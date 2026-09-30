/**
 * reservationSchema.ts
 *
 * Schemas e tipos TypeScript para eventos publicados pelo Hotel Service
 * (Java / Spring Boot).
 *
 * Formato de entrega (RabbitMQ via NestJS Microservices):
 *   { "pattern": "reservation.confirmed", "data": { ReservationEventEnvelope } }
 *
 * O desempacotamento do wrapper { pattern, data } é feito no eventRouter.ts.
 * Este módulo valida apenas o envelope interno (ReservationEventEnvelope).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Tipos de evento de reserva suportados
// ---------------------------------------------------------------------------

export enum ReservationEventType {
  RESERVATION_CONFIRMED = 'reservation.confirmed',
  RESERVATION_CREATED   = 'reservation.created',
  RESERVATION_UPDATED   = 'reservation.updated',
  RESERVATION_CANCELLED = 'reservation.cancelled',
  /** Alias sem duplo-L para compatibilidade com clientes que omitem o segundo 'l'. */
  RESERVATION_CANCELED  = 'reservation.canceled',
}

// ---------------------------------------------------------------------------
// Schema do usuário — UserData (conforme contrato do hotel-service)
// ---------------------------------------------------------------------------

export const userDataSchema = z.object({
  id:          z.number().int().positive(),
  /** Nome completo do hóspede. */
  name:        z.string().min(1),
  /** E-mail do destinatário — obrigatório conforme contrato. */
  email:       z.string().email('user.email deve ser um e-mail válido'),
  phoneNumber: z.string().optional(),
  role:        z.string().optional(),
});

export type UserData = z.infer<typeof userDataSchema>;

// ---------------------------------------------------------------------------
// Schema do payload de domínio — ReservationDataMessage
// ---------------------------------------------------------------------------

export const reservationDataMessageSchema = z
  .object({
    /** PK da reserva na base de dados. */
    id:                 z.number().int().positive(),
    /** Data de check-in no formato ISO "YYYY-MM-DD". */
    checkInDate:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'checkInDate deve ser YYYY-MM-DD'),
    /** Data de check-out no formato ISO "YYYY-MM-DD". */
    checkOutDate:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'checkOutDate deve ser YYYY-MM-DD'),
    /** Valor da diária em reais (ex: 250.00). */
    dailyRate:          z.number().nonnegative(),
    /** Valor total da reserva em reais. */
    totalAmount:        z.number().nonnegative(),
    discountAmount:     z.number().nonnegative().optional(),
    serviceFee:         z.number().nonnegative().optional(),
    statusReservation:  z.enum(['CREATED', 'CONFIRMED', 'CANCELED', 'PENDING']),
    createdAt:          z.string(),
    updatedAt:          z.string(),
    userId:             z.number().int().positive(),
    roomId:             z.number().int().positive(),
    /** Dados do hóspede — contém e-mail e nome para envio do e-mail. */
    user:               userDataSchema,
    cancellationReason: z.string().optional(),
    refundAmountCents:  z.number().optional(),
    refundCurrency:     z.string().optional(),
  })
  .transform((data) => {
    // Calcula o total de noites automaticamente com base nas datas
    const start = new Date(data.checkInDate).getTime();
    const end   = new Date(data.checkOutDate).getTime();
    const totalNights =
      !isNaN(start) && !isNaN(end) && end > start
        ? Math.ceil((end - start) / (1000 * 60 * 60 * 24))
        : 1;

    return {
      ...data,
      /** Código visível ao hóspede — baseado no ID da reserva. */
      reservationCode: `#${data.id}`,
      /** Número de noites calculado automaticamente. */
      totalNights,
      /** Identificação do quarto reservado. */
      roomType: `Quarto #${data.roomId}`,
    };
  });

export type ReservationDataMessage = z.infer<typeof reservationDataMessageSchema>;

// ---------------------------------------------------------------------------
// Schema do envelope completo — ReservationEventEnvelope
// ---------------------------------------------------------------------------

export const reservationMessageEnvelopeSchema = z.object({
  /** Identificador único do evento (UUID v4) — chave de idempotência. */
  eventId:       z.string().uuid('eventId deve ser um UUID v4 válido'),
  eventType:     z.string().min(1),
  eventVersion:  z.string().min(1),
  /** Data/hora ISO-8601 em que o evento ocorreu. */
  occurredAt:    z.string(),
  source:        z.string().min(1),
  correlationId: z.string().uuid().optional(),
  data:          reservationDataMessageSchema,
});

export type ReservationMessageEnvelope = z.infer<typeof reservationMessageEnvelopeSchema>;
