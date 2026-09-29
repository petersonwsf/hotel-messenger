/**
 * paymentSchema.test.ts
 *
 * Testes unitários para o schema PaymentEventEnvelope.
 */

import { describe, it, expect } from 'vitest';
import {
  paymentEventEnvelopeSchema,
  PaymentEventType_Enum,
} from '../../schemas/paymentSchema';

const BASE_DATA = {
  paymentId:             1,
  reservationId:         42,
  userId:                7,
  stripePaymentIntentId: 'pi_3PxABC123',
  recipientEmail:        'guest@example.com',
  recipientName:         'Maria Silva',
  amountAuthorized:      15000,
  amountCaptured:        15000,
  currency:              'BRL',
  status:                'CAPTURED' as const,
  captureMethod:         'MANUAL' as const,
  createdAt:             '2026-09-01T10:00:00.000Z',
  updatedAt:             '2026-09-01T10:01:00.000Z',
};

const VALID_ENVELOPE = {
  eventId:      '550e8400-e29b-41d4-a716-446655440000',
  eventType:    PaymentEventType_Enum.PAYMENT_CAPTURED,
  eventVersion: '1.0',
  occurredAt:   '2026-09-01T10:01:00.000Z',
  source:       'payments-service' as const,
  data:         BASE_DATA,
};

describe('paymentEventEnvelopeSchema — happy path', () => {
  it('aceita envelope PAYMENT_CAPTURED válido', () => {
    const result = paymentEventEnvelopeSchema.safeParse(VALID_ENVELOPE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.eventType).toBe('payment.captured');
      expect(result.data.source).toBe('payments-service');
      expect(result.data.data.recipientEmail).toBe('guest@example.com');
      expect(result.data.data.recipientName).toBe('Maria Silva');
    }
  });

  it('traduz captureMethod AUTOMATIC para "Boleto"', () => {
    const result = paymentEventEnvelopeSchema.safeParse({
      ...VALID_ENVELOPE,
      data: { ...BASE_DATA, captureMethod: 'AUTOMATIC' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data.paymentMethodLabel).toBe('Boleto');
    }
  });

  it('traduz captureMethod MANUAL para "Cartão de crédito"', () => {
    const result = paymentEventEnvelopeSchema.safeParse({
      ...VALID_ENVELOPE,
      data: { ...BASE_DATA, captureMethod: 'MANUAL' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data.paymentMethodLabel).toBe('Cartão de crédito');
    }
  });

  it('aceita todos os PaymentEventTypes válidos', () => {
    const types = Object.values(PaymentEventType_Enum);
    for (const eventType of types) {
      const result = paymentEventEnvelopeSchema.safeParse({ ...VALID_ENVELOPE, eventType });
      expect(result.success, `Falhou para eventType ${eventType}`).toBe(true);
    }
  });
});

describe('paymentEventEnvelopeSchema — validação de campos obrigatórios', () => {
  it('rejeita quando recipientEmail está ausente', () => {
    const { recipientEmail, ...data } = BASE_DATA;
    void recipientEmail;
    const result = paymentEventEnvelopeSchema.safeParse({ ...VALID_ENVELOPE, data });
    expect(result.success).toBe(false);
  });

  it('rejeita quando recipientName está ausente', () => {
    const { recipientName, ...data } = BASE_DATA;
    void recipientName;
    const result = paymentEventEnvelopeSchema.safeParse({ ...VALID_ENVELOPE, data });
    expect(result.success).toBe(false);
  });

  it('rejeita recipientEmail inválido', () => {
    const result = paymentEventEnvelopeSchema.safeParse({
      ...VALID_ENVELOPE,
      data: { ...BASE_DATA, recipientEmail: 'nao-e-email' },
    });
    expect(result.success).toBe(false);
  });

  it('rejeita eventId que não é UUID', () => {
    const result = paymentEventEnvelopeSchema.safeParse({
      ...VALID_ENVELOPE,
      eventId: 'nao-e-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('rejeita eventType desconhecido', () => {
    const result = paymentEventEnvelopeSchema.safeParse({
      ...VALID_ENVELOPE,
      eventType: 'payment.desconhecido',
    });
    expect(result.success).toBe(false);
  });
});
