/**
 * notificationAdapters.ts
 *
 * Adapters que transformam os eventos de domínio (Payments e Hospitality)
 * no tipo interno `EmailEvent` consumido pelo pipeline de envio de e-mail.
 *
 * Regras de mapeamento:
 *  - payments-service → usa envelope.data.recipientEmail e envelope.data.recipientName
 *  - hotel-service    → usa envelope.data.user.email e envelope.data.user.name
 *
 * Cobertura de eventos:
 *  Pagamentos:
 *    - payment.captured  → PAGAMENTO_RECEBIDO (e-mail disparado)
 *    - payment.authorized, payment.failed, payment.refunded → sem e-mail (ack silencioso)
 *
 *  Reservas:
 *    - reservation.created   → RESERVA_CRIADA
 *    - reservation.confirmed → RESERVA_CONFIRMADA
 *    - reservation.updated   → RESERVA_ATUALIZADA
 *    - reservation.cancelled / reservation.canceled → RESERVA_CANCELADA
 */

import {
  PaymentEventEnvelope,
  PaymentEventType_Enum,
} from '../schemas/paymentSchema.js';
import {
  ReservationMessageEnvelope,
  ReservationEventType,
} from '../schemas/reservationSchema.js';
import {
  EmailEvent,
  EmailEventType,
  PagamentoRecebidoEvent,
  ReservaCriadaEvent,
  ReservaConfirmadaEvent,
  ReservaAtualizadaEvent,
  ReservaCanceladaEvent,
} from '../schemas/emailSchema.js';

// ---------------------------------------------------------------------------
// Erro de adaptação
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
// Adapter de Pagamentos (payments-service)
// ---------------------------------------------------------------------------

/**
 * Mapeia um `PaymentEventEnvelope` para um `PagamentoRecebidoEvent` interno.
 *
 * - Somente `payment.captured` dispara envio de e-mail.
 * - Os demais tipos (authorized, failed, refunded) são acusados silenciosamente (null).
 * - Dados do destinatário: `data.recipientEmail` e `data.recipientName`.
 * - Valor exibido no e-mail: `data.amountCaptured` (valor cobrado).
 * - Método de pagamento: derivado automaticamente pelo schema (AUTOMATIC→Boleto, MANUAL→Cartão).
 */
export function adaptPaymentEvent(
  envelope: PaymentEventEnvelope,
): PagamentoRecebidoEvent | null {
  const { eventId, eventType, occurredAt, data } = envelope;

  switch (eventType) {
    case PaymentEventType_Enum.PAYMENT_CAPTURED: {
      const event: PagamentoRecebidoEvent = {
        messageId:       eventId,
        eventType:       EmailEventType.PAGAMENTO_RECEBIDO,
        // Dados do destinatário — obrigatórios no contrato do payments-service
        to:              data.recipientEmail,
        guestName:       data.recipientName,
        // Detalhes do pagamento
        reservationCode: String(data.reservationId),
        amountCents:     data.amountCaptured,   // valor efetivamente cobrado
        currency:        data.currency,
        paymentMethod:   data.paymentMethodLabel, // derivado pelo schema (Boleto / Cartão)
        paidAt:          occurredAt,
      };
      return event;
    }

    // Eventos sem ação de e-mail — acusados silenciosamente
    case PaymentEventType_Enum.PAYMENT_AUTHORIZED:
    case PaymentEventType_Enum.PAYMENT_FAILED:
    case PaymentEventType_Enum.PAYMENT_REFUNDED:
      return null;

    default:
      return null; // outros tipos futuros ignorados
  }
}

// ---------------------------------------------------------------------------
// Helpers internos de reserva
// ---------------------------------------------------------------------------

/** Constrói a base comum para todos os eventos de reserva. */
function buildReservationBase(envelope: ReservationMessageEnvelope) {
  const { eventId, data } = envelope;
  return {
    messageId:       eventId,
    to:              data.user.email,
    guestName:       data.user.name,
    reservationCode: data.reservationCode,  // "#<id>" — gerado pelo schema
    checkInDate:     data.checkInDate,
    checkOutDate:    data.checkOutDate,
    roomType:        data.roomType,         // "Quarto #<roomId>" — gerado pelo schema
    totalNights:     data.totalNights,      // calculado pelo schema
  };
}

// ---------------------------------------------------------------------------
// Adapter de Reservas (hotel-service)
// ---------------------------------------------------------------------------

/**
 * Mapeia um `ReservationMessageEnvelope` para um `EmailEvent` interno.
 *
 * Cobertura completa:
 *  - reservation.created   → RESERVA_CRIADA
 *  - reservation.confirmed → RESERVA_CONFIRMADA
 *  - reservation.updated   → RESERVA_ATUALIZADA
 *  - reservation.cancelled → RESERVA_CANCELADA
 *  - reservation.canceled  → RESERVA_CANCELADA  (alias sem duplo-L)
 *
 * Dados do destinatário: `data.user.email` e `data.user.name`.
 */
export function adaptReservationEvent(
  envelope: ReservationMessageEnvelope,
): EmailEvent | null {
  const { eventType, data } = envelope;
  const base = buildReservationBase(envelope);
  const typeStr = String(eventType);

  // reservation.created → RESERVA_CRIADA
  if (typeStr === ReservationEventType.RESERVATION_CREATED) {
    const event: ReservaCriadaEvent = {
      ...base,
      eventType: EmailEventType.RESERVA_CRIADA,
    };
    return event;
  }

  // reservation.confirmed → RESERVA_CONFIRMADA
  if (typeStr === ReservationEventType.RESERVATION_CONFIRMED) {
    const event: ReservaConfirmadaEvent = {
      ...base,
      eventType: EmailEventType.RESERVA_CONFIRMADA,
    };
    return event;
  }

  // reservation.updated → RESERVA_ATUALIZADA
  if (typeStr === ReservationEventType.RESERVATION_UPDATED) {
    const event: ReservaAtualizadaEvent = {
      ...base,
      eventType:         EmailEventType.RESERVA_ATUALIZADA,
      statusReservation: data.statusReservation,
      dailyRate:         data.dailyRate,
      totalAmount:       data.totalAmount,
    };
    return event;
  }

  // reservation.cancelled / reservation.canceled → RESERVA_CANCELADA
  if (
    typeStr === ReservationEventType.RESERVATION_CANCELLED ||
    typeStr === ReservationEventType.RESERVATION_CANCELED
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

  // Tipo de evento desconhecido — ignora silenciosamente
  return null;
}
