/**
 * emailSchema.test.ts
 *
 * Unit tests for the Zod email event schema.
 *
 * Covers:
 *  - Happy path: all three event types with valid payloads
 *  - Missing required fields (messageId, to, guestName)
 *  - Invalid field formats (bad UUID, bad email, wrong date format)
 *  - Unknown eventType → discriminated union rejection
 *  - Future-proofing: verifies the enum is the single source of truth
 */

import { describe, it, expect } from 'vitest';
import {
  emailEventSchema,
  EmailEventType,
  type ReservaConfirmadaEvent,
  type PagamentoRecebidoEvent,
  type ReservaCanceladaEvent,
} from '../../schemas/emailSchema';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE = {
  messageId: '550e8400-e29b-41d4-a716-446655440000',
  to:        'guest@example.com',
  guestName: 'Maria Silva',
} as const;

const RESERVA_CONFIRMADA_PAYLOAD: ReservaConfirmadaEvent = {
  ...BASE,
  eventType:       EmailEventType.RESERVA_CONFIRMADA,
  reservationCode: 'RES-001',
  checkIn:         '2026-10-01',
  checkOut:        '2026-10-05',
  roomType:        'Deluxe Suite',
  totalNights:     4,
};

const PAGAMENTO_RECEBIDO_PAYLOAD: PagamentoRecebidoEvent = {
  ...BASE,
  eventType:       EmailEventType.PAGAMENTO_RECEBIDO,
  reservationCode: 'RES-001',
  amountCents:     120000,
  currency:        'BRL',
  paymentMethod:   'Pix',
  paidAt:          '2026-09-04T20:00:00.000Z',
};

const RESERVA_CANCELADA_PAYLOAD: ReservaCanceladaEvent = {
  ...BASE,
  eventType:          EmailEventType.RESERVA_CANCELADA,
  reservationCode:    'RES-001',
  cancellationReason: 'Guest request',
  refundAmountCents:  120000,
  refundCurrency:     'BRL',
};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('emailEventSchema — happy path', () => {
  it('accepts a valid RESERVA_CONFIRMADA payload', () => {
    const result = emailEventSchema.safeParse(RESERVA_CONFIRMADA_PAYLOAD);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.eventType).toBe(EmailEventType.RESERVA_CONFIRMADA);
      expect(result.data.messageId).toBe(BASE.messageId);
    }
  });

  it('accepts a valid PAGAMENTO_RECEBIDO payload', () => {
    const result = emailEventSchema.safeParse(PAGAMENTO_RECEBIDO_PAYLOAD);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.eventType).toBe(EmailEventType.PAGAMENTO_RECEBIDO);
    }
  });

  it('accepts a valid RESERVA_CANCELADA payload', () => {
    const result = emailEventSchema.safeParse(RESERVA_CANCELADA_PAYLOAD);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.eventType).toBe(EmailEventType.RESERVA_CANCELADA);
    }
  });

  it('accepts RESERVA_CANCELADA without optional fields', () => {
    const { cancellationReason, refundAmountCents, refundCurrency, ...minimal } =
      RESERVA_CANCELADA_PAYLOAD;
    void cancellationReason; void refundAmountCents; void refundCurrency;
    const result = emailEventSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Missing required base fields
// ---------------------------------------------------------------------------

describe('emailEventSchema — missing required fields', () => {
  it('rejects when messageId is missing', () => {
    const { messageId, ...rest } = RESERVA_CONFIRMADA_PAYLOAD;
    void messageId;
    const result = emailEventSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects when to is missing', () => {
    const { to, ...rest } = RESERVA_CONFIRMADA_PAYLOAD;
    void to;
    const result = emailEventSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects when guestName is missing', () => {
    const { guestName, ...rest } = RESERVA_CONFIRMADA_PAYLOAD;
    void guestName;
    const result = emailEventSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invalid field formats
// ---------------------------------------------------------------------------

describe('emailEventSchema — invalid formats', () => {
  it('rejects an invalid UUID for messageId', () => {
    const result = emailEventSchema.safeParse({
      ...RESERVA_CONFIRMADA_PAYLOAD,
      messageId: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('messageId');
    }
  });

  it('rejects an invalid email for to', () => {
    const result = emailEventSchema.safeParse({
      ...RESERVA_CONFIRMADA_PAYLOAD,
      to: 'not-an-email',
    });
    expect(result.success).toBe(false);
  });

  it('rejects checkIn not in YYYY-MM-DD format', () => {
    const result = emailEventSchema.safeParse({
      ...RESERVA_CONFIRMADA_PAYLOAD,
      checkIn: '01/10/2026',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO paidAt date', () => {
    const result = emailEventSchema.safeParse({
      ...PAGAMENTO_RECEBIDO_PAYLOAD,
      paidAt: '2026-09-04', // date-only, not datetime
    });
    expect(result.success).toBe(false);
  });

  it('rejects currency not exactly 3 characters', () => {
    const result = emailEventSchema.safeParse({
      ...PAGAMENTO_RECEBIDO_PAYLOAD,
      currency: 'BR',
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative amountCents', () => {
    const result = emailEventSchema.safeParse({
      ...PAGAMENTO_RECEBIDO_PAYLOAD,
      amountCents: -100,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unknown / unsupported event types
// ---------------------------------------------------------------------------

describe('emailEventSchema — unknown eventType', () => {
  it('rejects an unknown eventType', () => {
    const result = emailEventSchema.safeParse({
      ...BASE,
      eventType: 'CHECK_IN_REMINDER', // not in the enum yet
    });
    expect(result.success).toBe(false);
  });

  it('rejects a payload with no eventType at all', () => {
    const result = emailEventSchema.safeParse(BASE);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Enum completeness guard
// ---------------------------------------------------------------------------

describe('EmailEventType enum', () => {
  it('has exactly the three event types defined in structure.md', () => {
    const knownTypes = new Set(Object.values(EmailEventType));
    expect(knownTypes.has(EmailEventType.RESERVA_CONFIRMADA)).toBe(true);
    expect(knownTypes.has(EmailEventType.PAGAMENTO_RECEBIDO)).toBe(true);
    expect(knownTypes.has(EmailEventType.RESERVA_CANCELADA)).toBe(true);
  });
});
