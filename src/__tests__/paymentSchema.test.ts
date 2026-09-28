/**
 * paymentSchema.test.ts
 *
 * Unit tests for the PaymentEventEnvelope Zod schema.
 */

import { describe, it, expect } from 'vitest';
import {
  paymentEventEnvelopeSchema,
  PaymentEventType,
  PaymentStatus,
  CaptureMethod,
} from '../../schemas/paymentSchema';

const BASE_DATA = {
  paymentId:             1,
  reservationId:         42,
  userId:                7,
  stripePaymentIntentId: 'pi_3PxABC123',
  recipientEmail:        'guest@example.com',
  recipientName:         'Maria Silva',
  paymentMethodLabel:    'Pix',
  amountAuthorized:      150000,
  amountCaptured:        150000,
  currency:              'BRL',
  status:                PaymentStatus.CAPTURED,
  captureMethod:         CaptureMethod.AUTOMATIC,
  createdAt:             '2026-09-01T10:00:00.000Z',
  updatedAt:             '2026-09-01T10:01:00.000Z',
};

const VALID_ENVELOPE = {
  eventId:      '550e8400-e29b-41d4-a716-446655440000',
  eventType:    PaymentEventType.PAYMENT_CAPTURED,
  eventVersion: '1.0',
  occurredAt:   '2026-09-01T10:01:00.000Z',
  source:       'payments-service' as const,
  data:         BASE_DATA,
};

describe('paymentEventEnvelopeSchema — happy path', () => {
  it('accepts a valid PAYMENT_CAPTURED envelope', () => {
    const result = paymentEventEnvelopeSchema.safeParse(VALID_ENVELOPE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.eventType).toBe(PaymentEventType.PAYMENT_CAPTURED);
      expect(result.data.source).toBe('payments-service');
      expect(result.data.data.recipientEmail).toBe('guest@example.com');
    }
  });

  it('maps captureMethod AUTOMATIC to Boleto when paymentMethodLabel is missing', () => {
    const { paymentMethodLabel, ...dataWithoutLabel } = BASE_DATA;
    void paymentMethodLabel;
    const result = paymentEventEnvelopeSchema.safeParse({
      ...VALID_ENVELOPE,
      data: { ...dataWithoutLabel, captureMethod: CaptureMethod.AUTOMATIC },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data.paymentMethodLabel).toBe('Boleto');
    }
  });

  it('maps captureMethod MANUAL to Cartão de crédito when paymentMethodLabel is missing', () => {
    const { paymentMethodLabel, ...dataWithoutLabel } = BASE_DATA;
    void paymentMethodLabel;
    const result = paymentEventEnvelopeSchema.safeParse({
      ...VALID_ENVELOPE,
      data: { ...dataWithoutLabel, captureMethod: CaptureMethod.MANUAL },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data.paymentMethodLabel).toBe('Cartão de crédito');
    }
  });

  it('accepts all valid PaymentEventType values', () => {
    for (const eventType of Object.values(PaymentEventType)) {
      const result = paymentEventEnvelopeSchema.safeParse({ ...VALID_ENVELOPE, eventType });
      expect(result.success, `Failed for eventType ${eventType}`).toBe(true);
    }
  });
});

describe('paymentEventEnvelopeSchema — field fallbacks & validation', () => {
  it('rejects when email is missing in all fields', () => {
    const { recipientEmail, email, customerEmail, ...data } = BASE_DATA as Record<string, unknown>;
    void recipientEmail; void email; void customerEmail;
    const result = paymentEventEnvelopeSchema.safeParse({ ...VALID_ENVELOPE, data });
    expect(result.success).toBe(false);
  });

  it('accepts email field as fallback for recipientEmail', () => {
    const { recipientEmail, ...data } = BASE_DATA;
    void recipientEmail;
    const result = paymentEventEnvelopeSchema.safeParse({
      ...VALID_ENVELOPE,
      data: { ...data, email: 'fallback@example.com' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data.recipientEmail).toBe('fallback@example.com');
    }
  });
});
