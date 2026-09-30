/**
 * paymentSchema.ts
 *
 * Schemas e tipos TypeScript para eventos publicados pelo Payments Service.
 *
 * Formato de entrega (RabbitMQ via NestJS Microservices):
 *   { "pattern": "payment.captured", "data": { PaymentEventEnvelope  } }
 *
 * O desempacotamento do wrapper { pattern, data } é feito no eventRouter.ts.
 * Este módulo valida apenas o envelope interno (PaymentEventEnvelope).
 **/

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Tipos literais / Enums (conforme contrato do payments-service)
// ---------------------------------------------------------------------------

export const PaymentStatusSchema = z.enum([
  'AUTHORIZED',
  'CAPTURED',
  'REFUNDED',
  'FAILED',
  'CANCELLED',
]);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const CaptureMethodSchema = z.enum(['AUTOMATIC', 'MANUAL']);
export type CaptureMethod = z.infer<typeof CaptureMethodSchema>;

export const PaymentEventTypeSchema = z.enum([
  'payment.authorized',
  'payment.captured',
  'payment.refunded',
  'payment.failed',
]);
export type PaymentEventType = z.infer<typeof PaymentEventTypeSchema>;

// Mantido como enum TS para uso no notificationAdapters.ts
export enum PaymentEventType_Enum {
  PAYMENT_AUTHORIZED = 'payment.authorized',
  PAYMENT_CAPTURED   = 'payment.captured',
  PAYMENT_REFUNDED   = 'payment.refunded',
  PAYMENT_FAILED     = 'payment.failed',
}

// ---------------------------------------------------------------------------
// Schema do payload de domínio — PaymentDataBase
// ---------------------------------------------------------------------------

export const paymentDataBaseSchema = z
  .object({
    paymentId:             z.number().int().positive(),
    reservationId:         z.number().int().positive(),
    userId:                z.number().int().positive(),
    /** E-mail do destinatário — obrigatório conforme contrato acordado. */
    recipientEmail:        z.string().email('recipientEmail deve ser um e-mail válido'),
    /** Nome do cliente — obrigatório para personalização do e-mail. */
    recipientName:         z.string().min(1, 'recipientName não pode ser vazio'),
    stripePaymentIntentId: z.string().min(1),
    amountAuthorized:      z.number().int().nonnegative(),
    /** Valor efetivamente cobrado — usado no e-mail de comprovante. */
    amountCaptured:        z.number().int().nonnegative(),
    /** Código ISO 4217 (ex: "BRL"). */
    currency:              z.string().length(3),
    status:                PaymentStatusSchema,
    /** AUTOMATIC → Boleto | MANUAL → Cartão de crédito */
    captureMethod:         CaptureMethodSchema,
    createdAt:             z.string(),
    updatedAt:             z.string(),
  })
  .transform((data) => ({
    ...data,
    // Tradução de captureMethod para rótulo legível usado no template de e-mail
    paymentMethodLabel:
      data.captureMethod === 'AUTOMATIC' ? 'Boleto' : 'Cartão de crédito',
  }));

export type PaymentDataBase = z.infer<typeof paymentDataBaseSchema>;

// ---------------------------------------------------------------------------
// Schema do envelope completo — PaymentEventEnvelope
// ---------------------------------------------------------------------------

export const paymentEventEnvelopeSchema = z.object({
  /** Identificador único do evento (UUID v4) — chave de idempotência. */
  eventId:       z.string(),
  eventType:     PaymentEventTypeSchema,
  eventVersion:  z.string().min(1),
  /** Data/hora ISO-8601 em que o evento ocorreu. */
  occurredAt:    z.string(),
  source:        z.literal('payments-service'),
  correlationId: z.string().nullish(),
  data:          paymentDataBaseSchema,
});

export type PaymentEventEnvelope = z.infer<typeof paymentEventEnvelopeSchema>;
