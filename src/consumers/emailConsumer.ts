/**
 * emailConsumer.ts
 *
 * RabbitMQ queue consumer worker.
 *
 * This consumer handles messages from TWO upstream services via a shared
 * topic exchange (routing keys: payment.*, reservation.*).
 *
 * Processing pipeline per message:
 *   1. Extract routing key & parse JSON   → nack on SyntaxError
 *   2. Route & schema-validate            → nack on RouterError / ZodError
 *   3. Adapt to internal EmailEvent       → ack silently if adapter returns null
 *   4. Idempotency check (eventId)        → ack (skip) on duplicate
 *   5. Template rendering                 → nack on TemplateNotFoundError
 *   6. Email dispatch with retry-backoff  → nack on RetryExhaustedError
 *   7. Mark eventId as processed
 *   8. channel.ack(msg)
 *
 * The process NEVER crashes from a message-level error — all failures are
 * caught, logged, and routed to the DLQ via nack.
 */

import amqp from 'amqplib';
import { z } from 'zod';
import { type EmailEvent, EmailEventType } from '../schemas/emailSchema.js';
import { renderTemplate, TemplateNotFoundError } from '../services/templateService.js';
import { sendEmail, isRetryableResendError } from '../services/resendService.js';
import { withRetry, RetryExhaustedError } from '../services/retryPolicy.js';
import { idempotencyStore } from '../services/idempotencyStore.js';
import { logger } from '../services/logger.js';
import { QUEUE_NAMES } from '../config/env.js';
import { routeMessage, RouterError } from './eventRouter.js';
import { adaptPaymentEvent, adaptReservationEvent, AdapterError } from './notificationAdapters.js';

// ---------------------------------------------------------------------------
// Email subject map — updated to include all event types
// ---------------------------------------------------------------------------

const EMAIL_SUBJECTS: Record<EmailEventType, string> = {
  [EmailEventType.RESERVA_CONFIRMADA]: 'Confirmação de Reserva — Grand Hotel',
  [EmailEventType.PAGAMENTO_RECEBIDO]: 'Pagamento Recebido — Grand Hotel',
  [EmailEventType.RESERVA_CANCELADA]:  'Cancelamento de Reserva — Grand Hotel',
};

// ---------------------------------------------------------------------------
// Template data enrichment
// ---------------------------------------------------------------------------

function enrichTemplateData(event: EmailEvent): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ...event,
    currentYear: new Date().getFullYear(),
  };

  switch (event.eventType) {
    case EmailEventType.RESERVA_CONFIRMADA: {
      return base;
    }

    case EmailEventType.PAGAMENTO_RECEBIDO: {
      const decimal = event.amountCents / 100;
      return {
        ...base,
        formattedAmount: decimal.toLocaleString('pt-BR', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
        paidAt: new Date(event.paidAt).toLocaleString('pt-BR', {
          dateStyle: 'short',
          timeStyle: 'short',
        }),
      };
    }

    case EmailEventType.RESERVA_CANCELADA: {
      const hasRefund =
        event.refundAmountCents !== undefined && event.refundAmountCents > 0;

      const formattedRefundAmount =
        hasRefund && event.refundAmountCents !== undefined
          ? (event.refundAmountCents / 100).toLocaleString('pt-BR', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })
          : null;

      return {
        ...base,
        hasRefund,
        formattedRefundAmount,
        cancellationDate: new Date().toLocaleDateString('pt-BR'),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Core message handler
// ---------------------------------------------------------------------------

async function handleMessage(
  msg: amqp.ConsumeMessage,
  channel: amqp.Channel,
): Promise<void> {
  const rawContent    = msg.content.toString();
  // routingKey do AMQP — usado apenas para logging; o roteamento real lê de msg.pattern
  const routingKey    = msg.fields.routingKey;
  const correlationId = msg.properties.correlationId as string | undefined;

  // ------------------------------------------------------------------
  // Step 1 & 2: Desempacota wrapper { pattern, data } + valida schema
  // ------------------------------------------------------------------
  let routed: ReturnType<typeof routeMessage>;
  try {
    // routeMessage lê o routing key do campo `pattern` dentro do JSON
    routed = routeMessage(rawContent);
  } catch (err) {
    if (err instanceof RouterError) {
      logger.error('Pattern/routing key desconhecido — enviando para DLQ', {
        routingKey,
        pattern: err.routingKey,
        error:   err.message,
      });
    } else if (err instanceof z.ZodError) {
      // ZodError já logado dentro de routeMessage
    } else {
      logger.error('Falha ao processar mensagem — enviando para DLQ', {
        routingKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    channel.nack(msg, false, false);
    return;
  }

  // ------------------------------------------------------------------
  // Step 3: Adapt to internal EmailEvent
  //         If adapter returns null → ack silently (no email to send)
  // ------------------------------------------------------------------
  let emailEvent: EmailEvent | null;
  try {
    if (routed.source === 'payments-service') {
      emailEvent = adaptPaymentEvent(routed.event);
    } else {
      emailEvent = adaptReservationEvent(routed.event);
    }
  } catch (err) {
    if (err instanceof AdapterError) {
      logger.error('Adapter could not map event to email — routing to DLQ', {
        routingKey,
        eventType:    err.eventType,
        correlationId,
        error:        err.message,
      });
    } else {
      logger.error('Unexpected adapter error — routing to DLQ', {
        routingKey,
        correlationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    channel.nack(msg, false, false);
    return;
  }

  if (emailEvent === null) {
    // Legitimate event but no email action needed (e.g. PAYMENT_AUTHORIZED)
    logger.info('Event acknowledged without email dispatch (no-op event type)', {
      routingKey,
      source: routed.source,
      correlationId,
    });
    channel.ack(msg);
    return;
  }

  const { messageId, eventType } = emailEvent;

  // ------------------------------------------------------------------
  // Step 4: Idempotency check (keyed on eventId / messageId)
  // ------------------------------------------------------------------
  if (idempotencyStore.has(messageId)) {
    logger.info('Duplicate event detected — skipping (ack)', {
      messageId,
      eventType,
      routingKey,
    });
    channel.ack(msg);
    return;
  }

  // ------------------------------------------------------------------
  // Step 5: Template rendering
  // ------------------------------------------------------------------
  let html: string;
  try {
    const templateData = enrichTemplateData(emailEvent);
    html = renderTemplate(eventType, templateData);
  } catch (err) {
    if (err instanceof TemplateNotFoundError) {
      logger.error('Template not found — routing to DLQ', {
        messageId,
        eventType,
        templatePath: err.templatePath,
      });
    } else {
      logger.error('Template rendering error — routing to DLQ', {
        messageId,
        eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    channel.nack(msg, false, false);
    return;
  }

  // ------------------------------------------------------------------
  // Step 6: Email dispatch with retry-backoff
  // ------------------------------------------------------------------
  try {
    await withRetry(
      () =>
        sendEmail({
          to:      emailEvent.to,
          subject: EMAIL_SUBJECTS[eventType],
          html,
        }),
      {
        maxAttempts:    3,
        initialDelayMs: 500,
        backoffFactor:  2,
        isRetryable:    isRetryableResendError,
      },
    );
  } catch (err) {
    if (err instanceof RetryExhaustedError) {
      logger.error('Email dispatch exhausted retries — routing to DLQ', {
        messageId,
        eventType,
        attempts: err.attempts,
        routingKey,
      });
    } else {
      logger.error('Non-retryable email dispatch error — routing to DLQ', {
        messageId,
        eventType,
        error: err instanceof Error ? err.message : String(err),
        routingKey,
      });
    }
    channel.nack(msg, false, false);
    return;
  }

  // ------------------------------------------------------------------
  // Step 7: Mark as processed
  // ------------------------------------------------------------------
  idempotencyStore.mark(messageId);

  // ------------------------------------------------------------------
  // Step 8: Acknowledge message
  // ------------------------------------------------------------------
  channel.ack(msg);

  logger.info('Message processed — ack sent', {
    messageId,
    eventType,
    routingKey,
    source: routed.source,
    outcome: 'ack',
  });
}

// ---------------------------------------------------------------------------
// Consumer entrypoint
// ---------------------------------------------------------------------------

/**
 * Attaches the message handler to the RabbitMQ channel and begins consuming.
 * The channel prefetch is already set by connectRabbitMQ().
 */
export async function startEmailConsumer(channel: amqp.Channel): Promise<void> {
  await channel.consume(
    QUEUE_NAMES.main,
    (msg) => {
      if (msg === null) {
        logger.warn('Consumer was cancelled by the broker');
        return;
      }

      handleMessage(msg, channel).catch((unexpectedErr) => {
        logger.error('Unexpected error in handleMessage — THIS SHOULD NOT HAPPEN', {
          error: unexpectedErr instanceof Error ? unexpectedErr.message : String(unexpectedErr),
        });
        try {
          channel.nack(msg, false, false);
        } catch {
          // channel may already be closed
        }
      });
    },
    { noAck: false },
  );

  logger.info('Email consumer started', { queue: QUEUE_NAMES.main });
}
