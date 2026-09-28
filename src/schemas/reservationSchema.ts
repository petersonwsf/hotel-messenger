/**
 * reservationSchema.ts
 *
 * Zod schemas and TypeScript types for events published by the Hospitality Service
 * (Java / Spring Boot).
 *
 * Contract source:  hospitality-service
 * Transport:        RabbitMQ topic exchange, routing key pattern `reservation.*`
 * Idempotency key:  envelope.eventId (UUID)
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// ReservationEventType enum
// ---------------------------------------------------------------------------

export enum ReservationEventType {
  RESERVA_CONFIRMADA  = 'reservation.confirmed',
  RESERVA_CRIADA      = 'reservation.created',
  RESERVA_CANCELADA   = 'reservation.cancelled',
  RESERVA_CANCELED    = 'reservation.canceled',
}

// ---------------------------------------------------------------------------
// UserResponseDTO schema
// ---------------------------------------------------------------------------

export const userResponseDTOSchema = z
  .object({
    id:          z.number().int().positive().optional(),
    name:        z.string().optional(),
    login:       z.string().optional(),
    email:       z.string().email().optional(),
    phoneNumber: z.string().optional(),
    role:        z.string().optional(),
    imageKey:    z.string().optional(),
  })
  .transform((dto) => {
    const candidateEmail = dto.email ?? dto.login;
    const emailResult = z.string().email().safeParse(candidateEmail);
    return {
      ...dto,
      resolvedEmail: emailResult.success ? emailResult.data : undefined,
    };
  });

export type UserResponseDTO = z.infer<typeof userResponseDTOSchema>;

// ---------------------------------------------------------------------------
// ReservationDataMessage schema
// ---------------------------------------------------------------------------

export const reservationDataMessageSchema = z
  .object({
    /** Reservation database primary key ID. */
    id: z.number().int().positive(),

    // Database fields (snake_case and camelCase supported)
    check_in_date:      z.string().optional(),
    checkIn:            z.string().optional(),
    check_out_date:     z.string().optional(),
    checkOut:           z.string().optional(),
    daily_rate:         z.number().optional(),
    dailyRate:          z.number().optional(),
    total_amount:       z.number().optional(),
    totalAmount:        z.number().optional(),
    discount_amount:    z.number().optional(),
    discountAmount:     z.number().optional(),
    service_fee:        z.number().optional(),
    serviceFee:         z.number().optional(),
    status_reservation: z.string().optional(),
    statusReservation:  z.string().optional(),
    created_at:         z.string().optional(),
    createdAt:          z.string().optional(),
    updated_at:         z.string().optional(),
    updatedAt:          z.string().optional(),

    user_id: z.number().optional(),
    userId:  z.number().optional(),
    room_id: z.number().optional(),
    roomId:  z.number().optional(),

    /** User object (Spring Boot DTO) or top-level user fields. */
    user:  userResponseDTOSchema.optional(),
    email: z.string().email().optional(),
    name:  z.string().optional(),

    /** Booking overrides (optional) */
    reservationCode: z.string().optional(),
    totalNights:     z.number().int().positive().optional(),
    roomType:        z.string().optional(),

    /** Cancellation fields */
    cancellationReason: z.string().optional(),
    refundAmountCents:  z.number().int().nonnegative().optional(),
    refundCurrency:     z.string().length(3).optional(),
  })
  .transform((data) => {
    // Resolve dates
    const rawCheckIn = data.check_in_date ?? data.checkIn;
    const rawCheckOut = data.check_out_date ?? data.checkOut;

    // Normalize YYYY-MM-DD
    const checkIn = rawCheckIn ? rawCheckIn.slice(0, 10) : undefined;
    const checkOut = rawCheckOut ? rawCheckOut.slice(0, 10) : undefined;

    // Resolve email (user.email -> user.login -> top level email)
    const resolvedEmail = data.user?.resolvedEmail ?? data.email;
    if (!resolvedEmail) {
      throw new Error(
        `Reservation payload (id=${data.id}) missing valid email address. ` +
        `Include 'email' or 'login' in user object or at top level.`,
      );
    }

    const resolvedName = data.user?.name ?? data.name ?? 'Hóspede';

    // Calculate totalNights if check-in and check-out present
    let nights = data.totalNights;
    if (!nights && checkIn && checkOut) {
      const start = new Date(checkIn).getTime();
      const end = new Date(checkOut).getTime();
      if (!isNaN(start) && !isNaN(end) && end > start) {
        nights = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
      }
    }

    const code = data.reservationCode ?? `#${data.id}`;
    const room = data.roomType ?? (data.room_id ?? data.roomId ? `Quarto #${data.room_id ?? data.roomId}` : 'Quarto Standard');

    return {
      ...data,
      reservationCode: code,
      checkIn:          checkIn ?? '2026-10-01',
      checkOut:         checkOut ?? '2026-10-02',
      totalNights:      nights ?? 1,
      roomType:         room,
      resolvedEmail,
      resolvedName,
    };
  });

export type ReservationDataMessage = z.infer<typeof reservationDataMessageSchema>;

// ---------------------------------------------------------------------------
// ReservationMessageEnvelope schema
// ---------------------------------------------------------------------------

export const reservationMessageEnvelopeSchema = z.object({
  /** Unique event identifier (UUID v4). Used as the idempotency key. */
  eventId:      z.string().uuid('eventId must be a valid UUID v4'),
  eventType:    z.nativeEnum(ReservationEventType).or(z.string()),
  eventVersion: z.string().min(1),
  /** ISO-8601 datetime when the event occurred. */
  occurredAt:   z.string(),
  source:       z.string().min(1),
  correlationId: z.string().uuid().optional(),
  data: reservationDataMessageSchema,
});

export type ReservationMessageEnvelope = z.infer<typeof reservationMessageEnvelopeSchema>;
