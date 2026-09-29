/**
 * reservationSchema.test.ts
 *
 * Testes unitários para o schema ReservationMessageEnvelope.
 */

import { describe, it, expect } from 'vitest';
import {
  reservationMessageEnvelopeSchema,
  ReservationEventType,
} from '../../schemas/reservationSchema';

const BASE_USER = {
  id:          1,
  name:        'João Costa',
  email:       'joao@example.com',
  phoneNumber: '+55 11 99999-0000',
  role:        'GUEST',
};

const BASE_DATA = {
  id:                101,
  checkInDate:       '2026-10-01',
  checkOutDate:      '2026-10-05',
  dailyRate:         25000,
  totalAmount:       100000,
  discountAmount:    0,
  serviceFee:        500,
  statusReservation: 'CONFIRMED' as const,
  createdAt:         '2026-09-01T10:00:00.000Z',
  updatedAt:         '2026-09-01T10:00:00.000Z',
  userId:            1,
  roomId:            12,
  user:              BASE_USER,
};

const VALID_ENVELOPE = {
  eventId:      '660e8400-e29b-41d4-a716-446655440001',
  eventType:    ReservationEventType.RESERVATION_CONFIRMED,
  eventVersion: '1.0',
  occurredAt:   '2026-09-28T19:00:00.000Z',
  source:       'hotel-service',
  data:         BASE_DATA,
};

describe('reservationMessageEnvelopeSchema — happy path', () => {
  it('aceita envelope de reserva confirmada com campos camelCase', () => {
    const result = reservationMessageEnvelopeSchema.safeParse(VALID_ENVELOPE);
    expect(result.success).toBe(true);
    if (result.success) {
      // Código gerado automaticamente pelo schema
      expect(result.data.data.reservationCode).toBe('#101');
      // Noites calculadas automaticamente: 01/10 → 05/10 = 4 noites
      expect(result.data.data.totalNights).toBe(4);
      // Quarto derivado do roomId
      expect(result.data.data.roomType).toBe('Quarto #12');
      // Email e nome do user
      expect(result.data.data.user.email).toBe('joao@example.com');
      expect(result.data.data.user.name).toBe('João Costa');
    }
  });

  it('aceita envelope reservation.cancelled', () => {
    const result = reservationMessageEnvelopeSchema.safeParse({
      ...VALID_ENVELOPE,
      eventType: ReservationEventType.RESERVATION_CANCELLED,
      data: { ...BASE_DATA, cancellationReason: 'Pedido do hóspede' },
    });
    expect(result.success).toBe(true);
  });
});

describe('reservationMessageEnvelopeSchema — validação de campos obrigatórios', () => {
  it('rejeita quando user.email está ausente', () => {
    const { email, ...userSemEmail } = BASE_USER;
    void email;
    const result = reservationMessageEnvelopeSchema.safeParse({
      ...VALID_ENVELOPE,
      data: { ...BASE_DATA, user: userSemEmail },
    });
    expect(result.success).toBe(false);
  });

  it('rejeita user.email inválido', () => {
    const result = reservationMessageEnvelopeSchema.safeParse({
      ...VALID_ENVELOPE,
      data: { ...BASE_DATA, user: { ...BASE_USER, email: 'nao-e-email' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejeita checkInDate fora do formato YYYY-MM-DD', () => {
    const result = reservationMessageEnvelopeSchema.safeParse({
      ...VALID_ENVELOPE,
      data: { ...BASE_DATA, checkInDate: '01/10/2026' },
    });
    expect(result.success).toBe(false);
  });

  it('rejeita eventId que não é UUID', () => {
    const result = reservationMessageEnvelopeSchema.safeParse({
      ...VALID_ENVELOPE,
      eventId: 'nao-e-uuid',
    });
    expect(result.success).toBe(false);
  });
});
