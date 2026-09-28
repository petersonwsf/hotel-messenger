/**
 * notificationAdapters.ts
 *
 * Adapters that transform incoming domain events (from Payments and Hospitality
 * Services) into the internal `EmailEvent` type consumed by the email pipeline.
 *
 * Adapter pattern rationale:
 *  - The `EmailEvent` union (emailSchema.ts) is the internal contract of this service.
 *  - External contracts (paymentSchema, reservationSchema) are the upstream contracts.
 *  - Adapters live at the boundary — they isolate internal types from upstream churn.
 *
 * Each adapter:
 *  1. Receives a strongly-typed external event.
 *  2. Maps its fields to the internal EmailEvent structure.
 *  3. Throws `AdapterError` for cases where required data is missing
 *     (e.g. unrecognised PaymentEventType → no email to send).
 */

import {
  PaymentEventEnvelope,
  PaymentEventType,
} from '../schemas/paymentSchema.js';
import {
  ReservationMessageEnvelope,
  ReservationEventType,
} from '../schemas/reservationSchema.js';
import {
  EmailEvent,
  EmailEventType,
  PagamentoRecebidoEvent,
  ReservaConfirmadaEvent,
  ReservaCanceladaEvent,
} from '../schemas/emailSchema.js';

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

export class AdapterError extends Error {
  public readonly eventType: string;

  constructor(message: string, eventType: string) {
    super(message);
    this.name      = 'AdapterError';
    this.eventType = eventType;
  }
}

// ---------------------------------------------------------------------------
// Payment adapter
// ---------------------------------------------------------------------------

/**
 * Maps a `PaymentEventEnvelope` to an internal `PagamentoRecebidoEvent`.
 *
 * Only `PAYMENT_CAPTURED` events trigger an email — other statuses (authorized,
 * failed, refunded) are acknowledged silently without dispatch.
 *
 * @throws `AdapterError` if the event type does not have a corresponding email.
 */
export function adaptPaymentEvent(
  envelope: PaymentEventEnvelope,
): PagamentoRecebidoEvent | null {
  const { eventId, eventType, occurredAt, data } = envelope;

  switch (eventType) {
    case PaymentEventType.PAYMENT_CAPTURED: {
      const event: PagamentoRecebidoEvent = {
        // Internal idempotency key — use the upstream eventId as messageId
        messageId:       eventId,
        eventType:       EmailEventType.PAGAMENTO_RECEBIDO,
        // Recipient data (Gap P-1 / P-2 fields from CONTRACT_REPORT.md)
        to:              data.recipientEmail,
        guestName:       data.recipientName,
        // Booking / payment details
        reservationCode: String(data.reservationId),
        amountCents:     data.amountCaptured,
        currency:        data.currency,
        paymentMethod:   data.paymentMethodLabel,
        paidAt:          occurredAt,
      };
      return event;
    }

    // These event types are valid but do not trigger an email notification.
    case PaymentEventType.PAYMENT_AUTHORIZED:
    case PaymentEventType.PAYMENT_FAILED:
    case PaymentEventType.PAYMENT_REFUNDED:
      return null; // caller will ack silently

    default: {
      // TypeScript exhaustiveness guard
      const _exhaustive: never = eventType;
      throw new AdapterError(
        `No email mapping defined for payment event type "${String(_exhaustive)}"`,
        String(_exhaustive),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Reservation adapter
// ---------------------------------------------------------------------------

/**
 * Maps a `ReservationMessageEnvelope` to an internal `EmailEvent`.
 *
 * @throws `AdapterError` if required booking fields are missing for the event type.
 */
export function adaptReservationEvent(
  envelope: ReservationMessageEnvelope,
): EmailEvent | null {
  const { eventId, eventType, data } = envelope;
  const { user, reservationCode } = data;

  const base = {
    messageId: eventId,
    to:        user.resolvedEmail,  // resolved by the Zod transform in reservationSchema.ts
    guestName: user.name,
  };

  switch (eventType) {
    case ReservationEventType.RESERVA_CONFIRMADA: {
      // Validate that all required booking fields are present
      if (!data.checkIn || !data.checkOut || !data.totalNights || !data.roomType) {
        throw new AdapterError(
          `RESERVA_CONFIRMADA event is missing required booking fields. ` +
          `Received: checkIn=${data.checkIn}, checkOut=${data.checkOut}, ` +
          `totalNights=${data.totalNights}, roomType=${data.roomType}. ` +
          `See CONTRACT_REPORT.md Gap H-2.`,
          eventType,
        );
      }

      const event: ReservaConfirmadaEvent = {
        ...base,
        eventType:       EmailEventType.RESERVA_CONFIRMADA,
        reservationCode,
        checkIn:         data.checkIn,
        checkOut:        data.checkOut,
        roomType:        data.roomType,
        totalNights:     data.totalNights,
      };
      return event;
    }

    case ReservationEventType.RESERVA_CANCELADA: {
      const event: ReservaCanceladaEvent = {
        ...base,
        eventType:          EmailEventType.RESERVA_CANCELADA,
        reservationCode,
        cancellationReason: data.cancellationReason,
        refundAmountCents:  data.refundAmountCents,
        refundCurrency:     data.refundCurrency,
      };
      return event;
    }

    default: {
      const _exhaustive: never = eventType;
      throw new AdapterError(
        `No email mapping defined for reservation event type "${String(_exhaustive)}"`,
        String(_exhaustive),
      );
    }
  }
}
