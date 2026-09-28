/**
 * paymentSchema.ts
 *
 * Zod schemas and TypeScript types for events published by the Payments Service.
 *
 * Contract source:  payments-service (Node.js / TypeScript)
 * Transport:        RabbitMQ topic exchange, routing key pattern `payment.*`
 * Idempotency key:  envelope.eventId (UUID)
 *
 * ⚠️  CONTRACT GAP NOTE (see CONTRACT_REPORT.md §2)
 *     Fields `recipientEmail`, `recipientName`, and `paymentMethodLabel` were
 *     PROPOSED additions to `PaymentDataBase`.  Until the Payments Service
 *     publishes these fields the notification service CANNOT send emails and
 *     will nack matching messages to the DLQ.  The schemas below validate their
 *     presence so failures are observable rather than silent.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum PaymentStatus {
  PENDING   = 'PENDING',
  AUTHORIZED = 'AUTHORIZED',
  CAPTURED  = 'CAPTURED',
  FAILED    = 'FAILED',
  REFUNDED  = 'REFUNDED',
  CANCELLED = 'CANCELLED',
}

export enum CaptureMethod {
  AUTOMATIC = 'AUTOMATIC',
  MANUAL    = 'MANUAL',
}

export enum PaymentEventType {
  PAYMENT_AUTHORIZED = 'payment.authorized',
  PAYMENT_CAPTURED   = 'payment.captured',
  PAYMENT_FAILED     = 'payment.failed',
  PAYMENT_REFUNDED   = 'payment.refunded',
}

// ---------------------------------------------------------------------------
// PaymentDataBase schema
// ---------------------------------------------------------------------------

export const paymentDataBaseSchema = z.object({
  paymentId:             z.number().int().positive(),
  reservationId:         z.number().int().positive(),
  userId:                z.number().int().positive(),
  stripePaymentIntentId: z.string().min(1),

  /**
   * ⚠️  REQUIRED by notification service — proposed addition to upstream contract.
   *     See CONTRACT_REPORT.md Gap P-1.
   */
  recipientEmail: z.string().email('recipientEmail must be a valid email address'),

  /**
   * ⚠️  REQUIRED by notification service — proposed addition to upstream contract.
   *     See CONTRACT_REPORT.md Gap P-2.
   */
  recipientName: z.string().min(1, 'recipientName must not be empty'),

  /**
   * ⚠️  REQUIRED by notification service — proposed addition to upstream contract.
   *     See CONTRACT_REPORT.md Gap P-4.
   *     Example values: "Pix", "Cartão de Crédito", "Boleto".
   */
  paymentMethodLabel: z.string().min(1, 'paymentMethodLabel must not be empty'),

  /** Amount actually captured (used in receipt email). See CONTRACT_REPORT.md Gap P-3. */
  amountAuthorized: z.number().int().nonnegative(),
  /** Use this field for the email receipt — the amount the customer was charged. */
  amountCaptured:   z.number().int().nonnegative(),
  /** ISO 4217 currency code (e.g. "BRL", "USD"). */
  currency: z.string().length(3),

  status:        z.nativeEnum(PaymentStatus),
  captureMethod: z.nativeEnum(CaptureMethod),

  /** ISO-8601 datetime string. */
  createdAt: z.string().datetime(),
  /** ISO-8601 datetime string. */
  updatedAt: z.string().datetime(),
});

export type PaymentDataBase = z.infer<typeof paymentDataBaseSchema>;

// ---------------------------------------------------------------------------
// PaymentEventEnvelope schema
// ---------------------------------------------------------------------------

/**
 * Generic payment event envelope.
 * Every message published by the Payments Service must conform to this shape.
 */
export const paymentEventEnvelopeSchema = z.object({
  /** Unique event identifier (UUID v4). Used as the idempotency key. */
  eventId:      z.string().uuid('eventId must be a valid UUID v4'),
  eventType:    z.nativeEnum(PaymentEventType),
  eventVersion: z.string().min(1),
  /** ISO-8601 datetime when the event occurred. */
  occurredAt:   z.string().datetime(),
  source: z.literal('payments-service'),
  correlationId: z.string().uuid().optional(),
  data: paymentDataBaseSchema,
});

export type PaymentEventEnvelope = z.infer<typeof paymentEventEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Typed helper — narrow to a specific event type
// ---------------------------------------------------------------------------

export type PaymentEventEnvelopeOf<T extends PaymentEventType> =
  Omit<PaymentEventEnvelope, 'eventType'> & { eventType: T };
