/**
 * eventRouter.ts
 *
 * Desempacota e roteia mensagens do RabbitMQ no padrão de Microserviços NestJS ({ pattern, data }),
 * encaminhando o envelope interno para validação nos schemas Zod correspondentes.
 *
 * Formato de entrada unificado:
 * {
 *   "pattern": "payment.captured",         ← Routing Key usada para direcionamento
 *   "data": {                              ← Envelope do evento (PaymentEventEnvelope | MessageDataEnvelope)
 *     "eventId": "uuid",
 *     "eventType": "payment.captured",
 *     "eventVersion": "1.0",
 *     "occurredAt": "2026-09-29T13:40:00.000Z",
 *     "source": "payments-service",        ← "payments-service" | "hotel-service"
 *     "correlationId": "uuid",
 *     "data": { ... }                      ← Payload de domínio (PaymentDataBase | ReservationDataMessage)
 *   }
 * }
 *
 * Mapeamento de Roteamento (pattern):
 *   - payment.*     → PaymentEventEnvelope   (dados do payments-service)
 *   - reservation.* → ReservationEventEnvelope (dados do hotel-service/Spring)
 *
 * Fluxo de Processamento:
 *   1. Extrai a propriedade `pattern` do nó raiz para decidir o handler.
 *   2. Desencapsula o objeto `data` da raiz para obter o envelope do evento.
 *   3. Executa a validação do schema Zod correspondente ao evento.
 *   4. Dispara o envio de e-mail via serviços de templates.
 **/

import { z } from 'zod';
import {
  paymentEventEnvelopeSchema,
  type PaymentEventEnvelope,
} from '../schemas/paymentSchema.js';
import {
  reservationMessageEnvelopeSchema,
  type ReservationMessageEnvelope,
} from '../schemas/reservationSchema.js';
import { logger } from '../services/logger.js';

// ---------------------------------------------------------------------------
// Schema do wrapper externo { pattern, data }
// ---------------------------------------------------------------------------

/**
 * Valida o envelope externo publicado pelo NestJS Microservices.
 * O campo `data` é mantido como `unknown` — cada branch faz sua própria
 * validação Zod específica logo em seguida.
 */
const rootWrapperSchema = z.object({
  /** Routing key utilizada para roteamento (ex: "payment.captured"). */
  pattern: z.string().min(1, 'Campo "pattern" ausente na mensagem'),
  /** Envelope interno do evento (PaymentEventEnvelope ou ReservationEventEnvelope). */
  data:    z.unknown(),
});

// ---------------------------------------------------------------------------
// Union de eventos roteados
// ---------------------------------------------------------------------------

export type RoutedEvent =
  | { source: 'payments-service';    event: PaymentEventEnvelope }
  | { source: 'hospitality-service'; event: ReservationMessageEnvelope };

// ---------------------------------------------------------------------------
// Erro de roteamento
// ---------------------------------------------------------------------------

export class RouterError extends Error {
  public readonly routingKey: string;

  constructor(message: string, routingKey: string) {
    super(message);
    this.name       = 'RouterError';
    this.routingKey = routingKey;
  }
}

// ---------------------------------------------------------------------------
// Router principal
// ---------------------------------------------------------------------------

/**
 * Desempacota o wrapper `{ pattern, data }`, extrai o routing key do campo
 * `pattern` e valida o envelope interno com o schema Zod correspondente.
 *
 * @param rawBody - Conteúdo bruto da mensagem RabbitMQ (JSON string).
 * @returns RoutedEvent tipado — discriminado por `source`.
 * @throws `Error`        se o JSON for inválido.
 * @throws `RouterError`  se o `pattern` não for reconhecido.
 * @throws `z.ZodError`   se o envelope interno não passar na validação.
 */
export function routeMessage(rawBody: string): RoutedEvent {
  // ---- 1. Parse do JSON bruto -----------------------------------------
  let root: unknown;
  try {
    root = JSON.parse(rawBody);
  } catch {
    throw new Error('Falha ao parsear JSON da mensagem recebida da fila');
  }

  // ---- 2. Valida wrapper externo { pattern, data } --------------------
  const wrapperResult = rootWrapperSchema.safeParse(root);
  if (!wrapperResult.success) {
    // Mensagem pode ser um envelope "direto" (sem wrapper) — tenta fallback
    return routeEnvelopeDirect(root);
  }

  const { pattern, data: envelopePayload } = wrapperResult.data;
  logger.debug('Roteando mensagem', { pattern });

  // ---- 3. Roteia pelo pattern -----------------------------------------
  return parseEnvelope(pattern, envelopePayload);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Tenta rotear uma mensagem SEM wrapper (envelope direto).
 * Usado como fallback para compatibilidade retroativa.
 */
function routeEnvelopeDirect(raw: unknown): RoutedEvent {
  // Extrai a routing key de `eventType` no próprio envelope
  const maybe = raw as Record<string, unknown> | null;
  const eventType = typeof maybe?.['eventType'] === 'string' ? maybe['eventType'] : '';
  const source    = typeof maybe?.['source']    === 'string' ? maybe['source']    : '';

  if (eventType.startsWith('payment.') || source === 'payments-service') {
    return parseEnvelope(eventType || 'payment.unknown', raw);
  }

  if (eventType.startsWith('reservation.') || source === 'hotel-service' || source === 'hospitality-service') {
    return parseEnvelope(eventType || 'reservation.unknown', raw);
  }

  throw new RouterError(
    `Routing key/pattern não reconhecido. ` +
    `Prefixos suportados: payment.*, reservation.*. ` +
    `Recebido: eventType="${eventType}", source="${source}"`,
    eventType,
  );
}

/**
 * Valida o envelope interno com o schema Zod correto conforme o pattern/routing key.
 */
function parseEnvelope(pattern: string, payload: unknown): RoutedEvent {
  if (pattern.startsWith('payment.')) {
    const result = paymentEventEnvelopeSchema.safeParse(payload);
    if (!result.success) {
      logValidationFailure(pattern, result.error);
      throw result.error;
    }
    return { source: 'payments-service', event: result.data };
  }

  if (pattern.startsWith('reservation.')) {
    const result = reservationMessageEnvelopeSchema.safeParse(payload);
    if (!result.success) {
      logValidationFailure(pattern, result.error);
      throw result.error;
    }
    return { source: 'hospitality-service', event: result.data };
  }

  throw new RouterError(
    `Nenhum handler registrado para o pattern "${pattern}". ` +
    'Prefixos suportados: payment.*, reservation.*',
    pattern,
  );
}

function logValidationFailure(pattern: string, error: z.ZodError): void {
  logger.error('Falha na validação do schema da mensagem recebida', {
    pattern,
    issues: error.issues.map((i) => ({
      campo:     i.path.join('.'),
      mensagem:  i.message,
    })),
  });
}
