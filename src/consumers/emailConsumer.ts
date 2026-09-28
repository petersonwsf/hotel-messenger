/**
 * emailConsumer.ts
 *
 * RabbitMQ queue consumer worker.
 *
 * Processing pipeline per message:
 *   1. Parse raw JSON        → nack to DLQ on SyntaxError
 *   2. Zod validation        → nack to DLQ on ZodError
 *   3. Idempotency check     → ack (skip) on duplicate messageId
 *   4. Template rendering    → nack to DLQ on TemplateNotFoundError
 *   5. Email dispatch        → retry with backoff; nack to DLQ on RetryExhaustedError
 *   6. Mark messageId        → stored in idempotencyStore
 *   7. channel.ack(msg)      → message removed from queue
 *
 * The process NEVER crashes from a message-level error — all failures are
 * caught, logged, and routed to the DLQ via nack.
 */

import amqp from 'amqplib';
import { emailEventSchema, EmailEventType, type EmailEvent } from '../schemas/emailSchema.js';
import { renderTemplate, TemplateNotFoundError } from '../services/templateService.js';
import { sendEmail, isRetryableResendError } from '../services/resendService.js';
import { withRetry, RetryExhaustedError } from '../services/retryPolicy.js';
import { idempotencyStore } from '../services/idempotencyStore.js';
import { logger } from '../services/logger.js';
import { QUEUE_NAMES } from '../config/env.js';

// ---------------------------------------------------------------------------
// Email subject map
// ---------------------------------------------------------------------------

const EMAIL_SUBJECTS: Record<EmailEventType, string> = {
  [EmailEventType.RESERVA_CONFIRMADA]: 'Confirmação de Reserva — Grand Hotel',
  [EmailEventType.PAGAMENTO_RECEBIDO]: 'Pagamento Recebido — Grand Hotel',
  [EmailEventType.RESERVA_CANCELADA]:  'Cancelamento de Reserva — Grand Hotel',
};

// ---------------------------------------------------------------------------
// Template data enrichment
//
// Each event type may need computed fields before template rendering.
// This keeps business logic out of the Handlebars templates.
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
      // Format cents → decimal (e.g. 150000 → "1.500,00")
      const decimal = event.amountCents / 100;
      return {
        ...base,
        formattedAmount: decimal.toLocaleString('pt-BR', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
        // Truncate paidAt to a human-readable local datetime
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
// Message handler — called for every delivery from RabbitMQ
// ---------------------------------------------------------------------------

async function handleMessage(
  msg: amqp.ConsumeMessage,
  channel: amqp.Channel,
): Promise<void> {
  const rawContent = msg.content.toString();

  // ------------------------------------------------------------------
  // Step 1: Parse raw JSON
  // ------------------------------------------------------------------
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch (err) {
    logger.error('Failed to parse message JSON — routing to DLQ', {
      error: err instanceof Error ? err.message : String(err),
    });
    channel.nack(msg, false, false);
    return;
  }

  // ------------------------------------------------------------------
  // Step 2: Zod schema validation
  // ------------------------------------------------------------------
  const validationResult = emailEventSchema.safeParse(parsed);
  if (!validationResult.success) {
    logger.error('Schema validation failed — routing to DLQ', {
      issues: validationResult.error.issues.map((i) => ({
        path:    i.path.join('.'),
        message: i.message,
      })),
    });
    channel.nack(msg, false, false);
    return;
  }

  const event: EmailEvent = validationResult.data;
  const { messageId, eventType } = event;

  // ------------------------------------------------------------------
  // Step 3: Idempotency check
  // ------------------------------------------------------------------
  if (idempotencyStore.has(messageId)) {
    logger.info('Duplicate message detected — skipping (ack)', {
      messageId,
      eventType,
    });
    channel.ack(msg);
    return;
  }

  // ------------------------------------------------------------------
  // Step 4: Template rendering
  // ------------------------------------------------------------------
  let html: string;
  try {
    const templateData = enrichTemplateData(event);
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
  // Step 5: Email dispatch with retry-backoff
  // ------------------------------------------------------------------
  try {
    await withRetry(
      () =>
        sendEmail({
          to:      event.to,
          subject: EMAIL_SUBJECTS[eventType],
          html,
        }),
      {
        maxAttempts:   3,
        initialDelayMs: 500,
        backoffFactor:  2,
        isRetryable:   isRetryableResendError,
      },
    );
  } catch (err) {
    if (err instanceof RetryExhaustedError) {
      logger.error('Email dispatch exhausted retries — routing to DLQ', {
        messageId,
        eventType,
        attempts: err.attempts,
      });
    } else {
      logger.error('Non-retryable email dispatch error — routing to DLQ', {
        messageId,
        eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    channel.nack(msg, false, false);
    return;
  }

  // ------------------------------------------------------------------
  // Step 6: Mark as processed (after successful send)
  // ------------------------------------------------------------------
  idempotencyStore.mark(messageId);

  // ------------------------------------------------------------------
  // Step 7: Acknowledge message
  // ------------------------------------------------------------------
  channel.ack(msg);

  logger.info('Message processed — ack sent', {
    messageId,
    eventType,
    outcome: 'ack',
  });
}

// ---------------------------------------------------------------------------
// Consumer entrypoint
// ---------------------------------------------------------------------------

/**
 * Attaches the message handler to the RabbitMQ channel and begins consuming.
 * The channel must already have `prefetch(1)` set (done in rabbitmq.ts).
 */
export async function startEmailConsumer(channel: amqp.Channel): Promise<void> {
  await channel.consume(
    QUEUE_NAMES.main,
    (msg) => {
      if (msg === null) {
        // Null delivery means the consumer was cancelled by the broker.
        logger.warn('Consumer was cancelled by the broker');
        return;
      }

      // We intentionally do NOT await here — the channel handles one message
      // at a time due to prefetch(1). The promise rejection must be caught
      // internally (handleMessage never throws; all paths end in ack/nack).
      handleMessage(msg, channel).catch((unexpectedErr) => {
        logger.error('Unexpected error in handleMessage — THIS SHOULD NOT HAPPEN', {
          error: unexpectedErr instanceof Error ? unexpectedErr.message : String(unexpectedErr),
        });
        // Safety net: nack the message to avoid it staying unacknowledged forever
        try {
          channel.nack(msg, false, false);
        } catch {
          // channel may already be closed; nothing we can do
        }
      });
    },
    { noAck: false }, // manual acknowledgment mode
  );

  logger.info('Email consumer started', { queue: QUEUE_NAMES.main });
}
