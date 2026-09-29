/**
 * emailSchema.ts
 *
 * Zod schema and TypeScript types for all email events consumed from RabbitMQ.
 *
 * Design goals:
 *  - Discriminated union keyed on `eventType` so new event types can be added
 *    without breaking existing consumers (open/closed principle).
 *  - Every event carries a `messageId` (UUID) for idempotency.
 *  - Sensitive fields (e.g. full payment card data) are deliberately excluded
 *    from all schemas to prevent accidental logging.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// EventType Enum
// ---------------------------------------------------------------------------

export enum EmailEventType {
  RESERVA_CONFIRMADA = 'RESERVA_CONFIRMADA',
  PAGAMENTO_RECEBIDO = 'PAGAMENTO_RECEBIDO',
  RESERVA_CANCELADA  = 'RESERVA_CANCELADA',
  // TODO: Add new event types here as they are finalized.
  // A corresponding .hbs template MUST be created in src/templates/ for each.
}

// ---------------------------------------------------------------------------
// Shared base — every event must carry these fields
// ---------------------------------------------------------------------------

const baseEventSchema = z.object({
  /**
   * Unique identifier for this specific message delivery.
   * Used for idempotency: the consumer will skip duplicate messageIds.
   * Must be a valid UUID v4.
   */
  messageId: z.string().uuid('messageId must be a valid UUID v4'),

  /** Recipient email address. */
  to: z.string().email('to must be a valid email address'),

  /** Guest full name, used inside templates. */
  guestName: z.string().min(1, 'guestName must not be empty'),
});

// ---------------------------------------------------------------------------
// Event-specific schemas
// ---------------------------------------------------------------------------

const reservaConfirmadaSchema = baseEventSchema.extend({
  eventType: z.literal(EmailEventType.RESERVA_CONFIRMADA),
  /** Reservation unique code shown to the guest. */
  reservationCode: z.string().min(1),
  /** Check-in date as ISO-8601 string (YYYY-MM-DD). */
  checkInDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'checkIn must be YYYY-MM-DD'),
  /** Check-out date as ISO-8601 string (YYYY-MM-DD). */
  checkOutDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'checkOut must be YYYY-MM-DD'),
  /** Room category (e.g. "Superior", "Deluxe Suite"). */
  roomType: z.string().min(1),
  /** Total number of nights derived at publish time; avoids date math in the service. */
  totalNights: z.number().int().positive(),
});

const pagamentoRecebidoSchema = baseEventSchema.extend({
  eventType: z.literal(EmailEventType.PAGAMENTO_RECEBIDO),
  /** Reservation code the payment relates to. */
  reservationCode: z.string().min(1),
  /** Amount charged (in smallest currency unit — e.g. cents for BRL). */
  amountCents: z.number().int().positive(),
  /** ISO 4217 currency code (e.g. "BRL", "USD"). */
  currency: z.string().length(3),
  /**
   * Human-readable payment method label (e.g. "Cartão de Crédito", "Pix").
   * Do NOT include card numbers, CVV, or any PCI-sensitive data here.
   */
  paymentMethod: z.string().min(1),
  /** ISO-8601 datetime of the transaction. */
  paidAt: z.string().datetime(),
});

const reservaCanceladaSchema = baseEventSchema.extend({
  eventType: z.literal(EmailEventType.RESERVA_CANCELADA),
  /** Reservation code being cancelled. */
  reservationCode: z.string().min(1),
  /** Optional human-readable reason for cancellation. */
  cancellationReason: z.string().optional(),
  /**
   * Refund amount in cents, if applicable.
   * 0 means no refund; absence means refund is being processed and amount is TBD.
   */
  refundAmountCents: z.number().int().nonnegative().optional(),
  /** ISO 4217 currency code for the refund. */
  refundCurrency: z.string().length(3).optional(),
});

// ---------------------------------------------------------------------------
// Union schema — extend here when adding new event types
// ---------------------------------------------------------------------------

export const emailEventSchema = z.discriminatedUnion('eventType', [
  reservaConfirmadaSchema,
  pagamentoRecebidoSchema,
  reservaCanceladaSchema,
]);

// ---------------------------------------------------------------------------
// TypeScript types derived from the schemas
// ---------------------------------------------------------------------------

export type ReservaConfirmadaEvent = z.infer<typeof reservaConfirmadaSchema>;
export type PagamentoRecebidoEvent = z.infer<typeof pagamentoRecebidoSchema>;
export type ReservaCanceladaEvent  = z.infer<typeof reservaCanceladaSchema>;

/** Discriminated union of all supported email event types. */
export type EmailEvent =
  | ReservaConfirmadaEvent
  | PagamentoRecebidoEvent
  | ReservaCanceladaEvent;
