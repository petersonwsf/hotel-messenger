/**
 * notificationAdapters.ts
 *
 * Adapters that transform incoming domain events (from Payments and Hospitality
 * Services) into the internal `EmailEvent` type consumed by the email pipeline.
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
 * `PAYMENT_CAPTURED` events trigger an email receipt using `amountCaptured`.
 * Other events (created, authorized, canceled, failed, refunded, boleto) are
 * acknowledged silently without sending an email.
 */
export function adaptPaymentEvent(
  envelope: PaymentEventEnvelope,
): PagamentoRecebidoEvent | null {
  const { eventId, eventType, occurredAt, data } = envelope;

  switch (eventType) {
    case PaymentEventType.PAYMENT_CAPTURED: {
      const event: PagamentoRecebidoEvent = {
        messageId:       eventId,
        eventType:       EmailEventType.PAGAMENTO_RECEBIDO,
        to:              data.recipientEmail,
        guestName:       data.recipientName,
        reservationCode: String(data.reservationId),
        amountCents:     data.amountCaptured, // charged amount
        currency:        data.currency,
        paymentMethod:   data.paymentMethodLabel,
        paidAt:          occurredAt,
      };
      return event;
    }

    case PaymentEventType.PAYMENT_CREATED:
    case PaymentEventType.PAYMENT_REQUIRES_ACTION:
    case PaymentEventType.PAYMENT_AUTHORIZED:
    case PaymentEventType.PAYMENT_CANCELED:
    case PaymentEventType.PAYMENT_FAILED:
    case PaymentEventType.PAYMENT_REFUNDED:
    case PaymentEventType.BOLETO_GENERATED:
      return null; // acknowledge silently without dispatching email

    default: {
      return null; // acknowledge unhandled event types silently
    }
  }
}

// ---------------------------------------------------------------------------
// Reservation adapter
// ---------------------------------------------------------------------------

/**
 * Maps a `ReservationMessageEnvelope` to an internal `EmailEvent`.
 */
export function adaptReservationEvent(
  envelope: ReservationMessageEnvelope,
): EmailEvent | null {
  const { eventId, eventType, data } = envelope;

  const base = {
    messageId: eventId,
    to:        data.resolvedEmail,
    guestName: data.resolvedName,
  };

  const typeStr = String(eventType);

  if (
    typeStr === ReservationEventType.RESERVA_CONFIRMADA ||
    typeStr === ReservationEventType.RESERVA_CRIADA ||
    typeStr === 'reservation.confirmed' ||
    typeStr === 'reservation.created'
  ) {
    const event: ReservaConfirmadaEvent = {
      ...base,
      eventType:       EmailEventType.RESERVA_CONFIRMADA,
      reservationCode: data.reservationCode,
      checkIn:         data.checkIn,
      checkOut:        data.checkOut,
      roomType:        data.roomType,
      totalNights:     data.totalNights,
    };
    return event;
  }

  if (
    typeStr === ReservationEventType.RESERVA_CANCELADA ||
    typeStr === ReservationEventType.RESERVA_CANCELED ||
    typeStr === 'reservation.cancelled' ||
    typeStr === 'reservation.canceled'
  ) {
    const event: ReservaCanceladaEvent = {
      ...base,
      eventType:          EmailEventType.RESERVA_CANCELADA,
      reservationCode:    data.reservationCode,
      cancellationReason: data.cancellationReason,
      refundAmountCents:  data.refundAmountCents,
      refundCurrency:     data.refundCurrency,
    };
    return event;
  }

  // Unknown/unhandled reservation events acknowledge silently
  return null;
}
