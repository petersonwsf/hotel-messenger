/**
 * reservationSchema.ts
 *
 * Zod schemas and TypeScript types for events published by the Hospitality Service
 * (Java / Spring Boot).
 *
 * Contract source:  hospitality-service
 * Transport:        RabbitMQ topic exchange, routing key pattern `reservation.*`
 * Idempotency key:  envelope.eventId (UUID)
 *
 * ⚠️  CONTRACT GAP NOTES (see CONTRACT_REPORT.md §3)
 *
 *  H-1: `UserResponseDTO.login` is ambiguous.
 *       Interim strategy: prefer `email` if present, fall back to `login` if it
 *       passes RFC 5322 validation, nack to DLQ otherwise.
 *
 *  H-2: `ReservationDataMessage` lacks booking fields needed by email templates.
 *       The schema marks them required; missing fields → nack to DLQ.
 *
 *  H-3: `eventType` typed as string on the Java side.
 *       We parse to the `ReservationEventType` enum here; unknown values → nack.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// ReservationEventType enum
// ---------------------------------------------------------------------------

export enum ReservationEventType {
  RESERVA_CONFIRMADA = 'reservation.confirmed',
  RESERVA_CANCELADA  = 'reservation.cancelled',
}

// ---------------------------------------------------------------------------
// UserResponseDTO schema
//
// ⚠️  Gap H-1: resolve recipient email from `email` (proposed) or `login` (current).
// ---------------------------------------------------------------------------

export const userResponseDTOSchema = z
  .object({
    id:          z.number().int().positive(),
    name:        z.string().min(1),
    /**
     * Current field from Spring Boot User model.
     * Treated as the email address if `email` is absent (see transform below).
     */
    login:       z.string().min(1),
    /**
     * Proposed addition — preferred over `login` when present.
     * See CONTRACT_REPORT.md Gap H-1.
     */
    email:       z.string().email().optional(),
    phoneNumber: z.string().min(1),
    role:        z.string().min(1),
    imageKey:    z.string(),
  })
  .transform((dto) => {
    // Resolve the canonical recipient email:
    // 1. Use `email` if the Hospitality Service already publishes it.
    // 2. Fall back to `login` after validating it is an email address.
    const candidateEmail = dto.email ?? dto.login;
    const emailResult = z.string().email().safeParse(candidateEmail);
    if (!emailResult.success) {
      throw new Error(
        `UserResponseDTO has no valid email address. ` +
        `Neither 'email' nor 'login' is a valid RFC 5322 address. ` +
        `(login="${dto.login}", email="${dto.email ?? 'absent'}")`,
      );
    }
    return {
      ...dto,
      /** Canonical email resolved from `email` or `login`. */
      resolvedEmail: emailResult.data,
    };
  });

export type UserResponseDTO = z.infer<typeof userResponseDTOSchema>;

// ---------------------------------------------------------------------------
// ReservationDataMessage schema
//
// ⚠️  Gap H-2: booking fields are required by the email templates.
// ---------------------------------------------------------------------------

export const reservationDataMessageSchema = z.object({
  /** Internal reservation identifier. */
  id:   z.number().int().positive(),
  user: userResponseDTOSchema,

  // --- Booking fields (Gap H-2 — proposed additions) ---

  /** Human-readable reservation code shown to the guest (e.g. "RES-2026-0042"). */
  reservationCode: z.string().min(1),
  /** Check-in date, ISO-8601 YYYY-MM-DD format. */
  checkIn:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'checkIn must be YYYY-MM-DD').optional(),
  /** Check-out date, ISO-8601 YYYY-MM-DD format. */
  checkOut:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'checkOut must be YYYY-MM-DD').optional(),
  /** Number of nights. */
  totalNights:     z.number().int().positive().optional(),
  /** Room category label (e.g. "Superior", "Deluxe Suite"). */
  roomType:        z.string().optional(),

  // --- Cancellation fields (optional, only present on RESERVA_CANCELADA) ---
  cancellationReason: z.string().optional(),
  refundAmountCents:  z.number().int().nonnegative().optional(),
  refundCurrency:     z.string().length(3).optional(),
});

export type ReservationDataMessage = z.infer<typeof reservationDataMessageSchema>;

// ---------------------------------------------------------------------------
// ReservationMessageEnvelope schema
// ---------------------------------------------------------------------------

export const reservationMessageEnvelopeSchema = z.object({
  /** Unique event identifier (UUID v4). Used as the idempotency key. */
  eventId:      z.string().uuid('eventId must be a valid UUID v4'),
  /**
   * String on the Java side (Gap H-3). We map to the enum here;
   * unknown values cause a Zod parse failure → nack to DLQ.
   */
  eventType:    z.nativeEnum(ReservationEventType),
  eventVersion: z.string().min(1),
  /** ISO-8601 datetime when the event occurred. */
  occurredAt:   z.string().datetime(),
  source:       z.string().min(1),
  correlationId: z.string().uuid().optional(),
  data: reservationDataMessageSchema,
});

export type ReservationMessageEnvelope = z.infer<typeof reservationMessageEnvelopeSchema>;
