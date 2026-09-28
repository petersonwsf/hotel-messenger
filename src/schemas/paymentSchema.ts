/**
 * paymentSchema.ts
 *
 * Zod schemas and TypeScript types for events published by the Payments Service.
 *
 * Contract source:  payments-service (Node.js / TypeScript)
 * Transport:        RabbitMQ topic exchange, routing key pattern `payment.*`
 * Idempotency key:  envelope.eventId (UUID)
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum PaymentStatus {
  PENDING    = 'PENDING',
  AUTHORIZED = 'AUTHORIZED',
  CAPTURED   = 'CAPTURED',
  FAILED     = 'FAILED',
  REFUNDED   = 'REFUNDED',
  CANCELLED  = 'CANCELLED',
  CANCELED   = 'CANCELED',
}

export enum CaptureMethod {
  AUTOMATIC = 'AUTOMATIC',
  MANUAL    = 'MANUAL',
}

export enum PaymentEventType {
  PAYMENT_CREATED         = 'payment.created',
  PAYMENT_REQUIRES_ACTION = 'payment.requires_action',
  PAYMENT_AUTHORIZED      = 'payment.authorized',
  PAYMENT_CAPTURED        = 'payment.captured',
  PAYMENT_CANCELED        = 'payment.canceled',
  PAYMENT_FAILED          = 'payment.failed',
  PAYMENT_REFUNDED        = 'payment.refunded',
  BOLETO_GENERATED        = 'boleto.generated',
}

// ---------------------------------------------------------------------------
// PaymentDataBase schema
// ---------------------------------------------------------------------------

export const paymentDataBaseSchema = z
  .object({
    paymentId:             z.number().int().positive(),
    reservationId:         z.number().int().positive(),
    userId:                z.number().int().positive(),
    stripePaymentIntentId: z.string().optional(),

    /** Customer email address (supports recipientEmail, email, or customerEmail). */
    recipientEmail: z.string().email().optional(),
    email:          z.string().email().optional(),
    customerEmail:  z.string().email().optional(),

    /** Customer full name (supports recipientName, name, or customerName). */
    recipientName: z.string().optional(),
    name:          z.string().optional(),
    customerName:  z.string().optional(),

    /** Optional human-readable payment method label. */
    paymentMethodLabel: z.string().optional(),

    /** Amounts in cents. amountCaptured is used as the email charged amount. */
    amountAuthorized: z.number().int().nonnegative().optional(),
    amountCaptured:   z.number().int().nonnegative(),
    /** ISO 4217 currency code (e.g. "BRL", "USD"). */
    currency:         z.string().length(3).default('BRL'),

    status:        z.nativeEnum(PaymentStatus).or(z.string()),
    captureMethod: z.nativeEnum(CaptureMethod).or(z.string()),

    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .transform((data) => {
    const resolvedEmail = data.recipientEmail ?? data.email ?? data.customerEmail;
    if (!resolvedEmail || !z.string().email().safeParse(resolvedEmail).success) {
      throw new Error(
        'Payment payload missing valid recipient email (recipientEmail, email, or customerEmail required)',
      );
    }
    const resolvedName = data.recipientName ?? data.name ?? data.customerName ?? 'Cliente';

    // Automatic captureMethod label mapping:
    // AUTOMATIC = Boleto, MANUAL = Cartão de crédito
    let resolvedMethod = data.paymentMethodLabel;
    if (!resolvedMethod) {
      if (data.captureMethod === CaptureMethod.AUTOMATIC || data.captureMethod === 'AUTOMATIC') {
        resolvedMethod = 'Boleto';
      } else if (data.captureMethod === CaptureMethod.MANUAL || data.captureMethod === 'MANUAL') {
        resolvedMethod = 'Cartão de crédito';
      } else {
        resolvedMethod = 'Cartão de crédito';
      }
    }

    return {
      ...data,
      recipientEmail:     resolvedEmail,
      recipientName:      resolvedName,
      paymentMethodLabel: resolvedMethod,
    };
  });

export type PaymentDataBase = z.infer<typeof paymentDataBaseSchema>;

// ---------------------------------------------------------------------------
// PaymentEventEnvelope schema
// ---------------------------------------------------------------------------

export const paymentEventEnvelopeSchema = z.object({
  /** Unique event identifier (UUID v4). Used as the idempotency key. */
  eventId:      z.string().uuid('eventId must be a valid UUID v4'),
  eventType:    z.nativeEnum(PaymentEventType),
  eventVersion: z.string().min(1),
  /** ISO-8601 datetime when the event occurred. */
  occurredAt:   z.string(),
  source:       z.literal('payments-service'),
  correlationId: z.string().uuid().optional(),
  data: paymentDataBaseSchema,
});

export type PaymentEventEnvelope = z.infer<typeof paymentEventEnvelopeSchema>;

export type PaymentEventEnvelopeOf<T extends PaymentEventType> =
  Omit<PaymentEventEnvelope, 'eventType'> & { eventType: T };
