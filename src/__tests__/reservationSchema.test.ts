/**
 * reservationSchema.test.ts
 *
 * Unit tests for the ReservationMessageEnvelope Zod schema.
 */

import { describe, it, expect } from 'vitest';
import {
  reservationMessageEnvelopeSchema,
  ReservationEventType,
} from '../../schemas/reservationSchema';

const BASE_USER = {
  id:          1,
  name:        'João Costa',
  login:       'joao@example.com',
  phoneNumber: '+55 11 99999-0000',
  role:        'GUEST',
  imageKey:    'avatars/joao.jpg',
};

const BASE_DATA_CONFIRMED = {
  id:                 101,
  check_in_date:      '2026-10-01',
  check_out_date:     '2026-10-05',
  daily_rate:         25000,
  total_amount:       100000,
  discount_amount:    0,
  service_fee:        500,
  status_reservation: 'CONFIRMED',
  user_id:            1,
  room_id:            12,
  user:               BASE_USER,
};

const VALID_ENVELOPE = {
  eventId:      '660e8400-e29b-41d4-a716-446655440001',
  eventType:    ReservationEventType.RESERVA_CONFIRMADA,
  eventVersion: '1.0',
  occurredAt:   '2026-09-28T19:00:00.000Z',
  source:       'hospitality-service',
  data:         BASE_DATA_CONFIRMED,
};

describe('reservationMessageEnvelopeSchema — happy path', () => {
  it('accepts a valid reservation envelope with DB fields', () => {
    const result = reservationMessageEnvelopeSchema.safeParse(VALID_ENVELOPE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data.reservationCode).toBe('#101');
      expect(result.data.data.totalNights).toBe(4);
      expect(result.data.data.resolvedEmail).toBe('joao@example.com');
      expect(result.data.data.roomType).toBe('Quarto #12');
    }
  });

  it('prefers explicit email field over login when both are present', () => {
    const envelope = {
      ...VALID_ENVELOPE,
      data: {
        ...BASE_DATA_CONFIRMED,
        user: { ...BASE_USER, email: 'explicit@example.com', login: 'not-used-login' },
      },
    };
    const result = reservationMessageEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data.resolvedEmail).toBe('explicit@example.com');
    }
  });

  it('accepts RESERVA_CANCELADA envelope', () => {
    const cancelledEnvelope = {
      ...VALID_ENVELOPE,
      eventType: ReservationEventType.RESERVA_CANCELADA,
      data: {
        ...BASE_DATA_CONFIRMED,
        cancellationReason: 'Guest request',
        refundAmountCents: 100000,
        refundCurrency: 'BRL',
      },
    };
    const result = reservationMessageEnvelopeSchema.safeParse(cancelledEnvelope);
    expect(result.success).toBe(true);
  });
});
