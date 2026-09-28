/**
 * emailConsumer.test.ts
 *
 * Unit tests for the email consumer pipeline.
 *
 * Strategy:
 *  - All external dependencies (templateService, resendService, idempotencyStore)
 *    are mocked with Vitest's vi.mock() so the test focuses purely on the
 *    consumer's control flow (ack/nack decisions and logging).
 *  - A minimal amqplib channel mock replaces the real RabbitMQ channel.
 *
 * Test cases:
 *  1. Happy path          → ack called, sendEmail called once
 *  2. Invalid JSON        → nack called, sendEmail not called
 *  3. Zod validation fail → nack called
 *  4. Duplicate messageId → ack called (skip), sendEmail not called
 *  5. Missing template    → nack called
 *  6. Retry exhausted     → nack called
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmailEventType } from '../../schemas/emailSchema';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock env before any consumer import so env.ts does not run validation
vi.mock('../../config/env', () => ({
  env: {
    RABBITMQ_URL:   'amqp://localhost',
    RABBITMQ_QUEUE: 'email_notifications',
    RESEND_API_KEY: 're_test_key',
    EMAIL_FROM:     'Hotel <noreply@test.com>',
    NODE_ENV:       'test',
    LOG_LEVEL:      'error', // suppress logs during tests
  },
  QUEUE_NAMES: {
    main: 'email_notifications',
    dlq:  'email_notifications_dlq',
    dlx:  'email_notifications_dlx',
  },
}));

const mockSendEmail = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockRenderTemplate = vi.fn<() => string>().mockReturnValue('<html>email</html>');
const mockIdempotencyHas = vi.fn<(id: string) => boolean>().mockReturnValue(false);
const mockIdempotencyMark = vi.fn<(id: string) => void>();

vi.mock('../../services/resendService', () => ({
  sendEmail:              mockSendEmail,
  isRetryableResendError: () => false,
  ResendApiError:         class ResendApiError extends Error {
    statusCode: number; isTransient: boolean;
    constructor(msg: string, code: number, transient: boolean) {
      super(msg); this.statusCode = code; this.isTransient = transient;
    }
  },
}));

vi.mock('../../services/templateService', () => {
  class TemplateNotFoundError extends Error {
    eventType: string; templatePath: string;
    constructor(eventType: string, templatePath: string) {
      super(`Template not found: ${eventType}`);
      this.eventType = eventType; this.templatePath = templatePath;
    }
  }
  return { renderTemplate: mockRenderTemplate, TemplateNotFoundError };
});

vi.mock('../../services/idempotencyStore', () => ({
  idempotencyStore: {
    has:  mockIdempotencyHas,
    mark: mockIdempotencyMark,
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal amqplib channel mock */
function makeChannelMock() {
  return {
    ack:     vi.fn(),
    nack:    vi.fn(),
    consume: vi.fn(),
    prefetch: vi.fn(),
    assertQueue:    vi.fn(),
    assertExchange: vi.fn(),
    bindQueue:      vi.fn(),
  };
}

/** Wraps a payload as an amqplib Message-like object */
function makeMessage(payload: unknown) {
  return {
    content: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)),
    fields:  { deliveryTag: 1, redelivered: false, exchange: '', routingKey: '' },
    properties: { messageId: null },
  };
}

const VALID_PAYLOAD = {
  messageId:       '550e8400-e29b-41d4-a716-446655440000',
  eventType:       EmailEventType.RESERVA_CONFIRMADA,
  to:              'guest@example.com',
  guestName:       'João Silva',
  reservationCode: 'RES-001',
  checkIn:         '2026-10-01',
  checkOut:        '2026-10-05',
  roomType:        'Standard',
  totalNights:     4,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('emailConsumer — handleMessage pipeline', () => {
  let channel: ReturnType<typeof makeChannelMock>;

  beforeEach(async () => {
    channel = makeChannelMock();
    vi.clearAllMocks();

    // Defaults for clean state
    mockIdempotencyHas.mockReturnValue(false);
    mockRenderTemplate.mockReturnValue('<html>email</html>');
    mockSendEmail.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // 1. Happy path
  // -------------------------------------------------------------------------
  it('acks and marks messageId on successful processing', async () => {
    // We need to import and invoke handleMessage indirectly via startEmailConsumer.
    // Vitest module isolation makes this straightforward.
    const { startEmailConsumer } = await import('../../consumers/emailConsumer');
    const msg = makeMessage(VALID_PAYLOAD);

    // Capture the consume callback
    let consumeCallback!: (msg: unknown) => void;
    channel.consume.mockImplementation((_queue: string, cb: (msg: unknown) => void) => {
      consumeCallback = cb;
    });

    await startEmailConsumer(channel as never);
    await consumeCallback(msg);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockIdempotencyMark).toHaveBeenCalledWith(VALID_PAYLOAD.messageId);
    expect(channel.ack).toHaveBeenCalledWith(msg);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. Invalid JSON
  // -------------------------------------------------------------------------
  it('nacks on malformed JSON', async () => {
    const { startEmailConsumer } = await import('../../consumers/emailConsumer');
    const msg = makeMessage('{not valid json {{{{');

    let consumeCallback!: (msg: unknown) => void;
    channel.consume.mockImplementation((_queue: string, cb: (msg: unknown) => void) => {
      consumeCallback = cb;
    });

    await startEmailConsumer(channel as never);
    await consumeCallback(msg);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. Zod validation failure
  // -------------------------------------------------------------------------
  it('nacks on schema validation failure', async () => {
    const { startEmailConsumer } = await import('../../consumers/emailConsumer');
    const msg = makeMessage({ eventType: 'RESERVA_CONFIRMADA' }); // missing required fields

    let consumeCallback!: (msg: unknown) => void;
    channel.consume.mockImplementation((_queue: string, cb: (msg: unknown) => void) => {
      consumeCallback = cb;
    });

    await startEmailConsumer(channel as never);
    await consumeCallback(msg);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 4. Duplicate messageId (idempotency skip)
  // -------------------------------------------------------------------------
  it('acks without sending email when messageId is a duplicate', async () => {
    mockIdempotencyHas.mockReturnValue(true); // Already processed

    const { startEmailConsumer } = await import('../../consumers/emailConsumer');
    const msg = makeMessage(VALID_PAYLOAD);

    let consumeCallback!: (msg: unknown) => void;
    channel.consume.mockImplementation((_queue: string, cb: (msg: unknown) => void) => {
      consumeCallback = cb;
    });

    await startEmailConsumer(channel as never);
    await consumeCallback(msg);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockRenderTemplate).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledWith(msg);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 5. Template not found
  // -------------------------------------------------------------------------
  it('nacks when template is not found', async () => {
    const { TemplateNotFoundError } = await import('../../services/templateService');
    mockRenderTemplate.mockImplementation(() => {
      throw new TemplateNotFoundError(EmailEventType.RESERVA_CONFIRMADA, '/fake/path.hbs');
    });

    const { startEmailConsumer } = await import('../../consumers/emailConsumer');
    const msg = makeMessage(VALID_PAYLOAD);

    let consumeCallback!: (msg: unknown) => void;
    channel.consume.mockImplementation((_queue: string, cb: (msg: unknown) => void) => {
      consumeCallback = cb;
    });

    await startEmailConsumer(channel as never);
    await consumeCallback(msg);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 6. Retry exhausted after send failures
  // -------------------------------------------------------------------------
  it('nacks after retry exhaustion from sendEmail failures', async () => {
    // Make sendEmail fail every time so retries exhaust
    mockSendEmail.mockRejectedValue(new Error('Simulated transient error'));

    const { startEmailConsumer } = await import('../../consumers/emailConsumer');
    const msg = makeMessage(VALID_PAYLOAD);

    let consumeCallback!: (msg: unknown) => void;
    channel.consume.mockImplementation((_queue: string, cb: (msg: unknown) => void) => {
      consumeCallback = cb;
    });

    await startEmailConsumer(channel as never);
    // This will take a moment due to retry delays — use fake timers in production tests
    await consumeCallback(msg);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
    expect(mockIdempotencyMark).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// IdempotencyStore — isolated unit tests
// ---------------------------------------------------------------------------

describe('IdempotencyStore', () => {
  it('reports has() = false before marking', async () => {
    const { IdempotencyStore } = await import('../../services/idempotencyStore');
    const store = new IdempotencyStore();
    expect(store.has('id-1')).toBe(false);
  });

  it('reports has() = true after marking', async () => {
    const { IdempotencyStore } = await import('../../services/idempotencyStore');
    const store = new IdempotencyStore();
    store.mark('id-1');
    expect(store.has('id-1')).toBe(true);
  });

  it('evicts the oldest entry when at maxSize capacity', async () => {
    const { IdempotencyStore } = await import('../../services/idempotencyStore');
    const store = new IdempotencyStore({ maxSize: 3 });
    store.mark('id-1');
    store.mark('id-2');
    store.mark('id-3');
    store.mark('id-4'); // should evict id-1
    expect(store.has('id-1')).toBe(false);
    expect(store.has('id-4')).toBe(true);
    expect(store.size).toBe(3);
  });

  it('does not evict when marking an already-present id', async () => {
    const { IdempotencyStore } = await import('../../services/idempotencyStore');
    const store = new IdempotencyStore({ maxSize: 2 });
    store.mark('id-1');
    store.mark('id-2');
    store.mark('id-1'); // re-mark: should be a no-op
    expect(store.size).toBe(2);
    expect(store.has('id-1')).toBe(true);
    expect(store.has('id-2')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RetryPolicy — isolated unit tests
// ---------------------------------------------------------------------------

describe('withRetry', () => {
  it('resolves on first attempt if fn succeeds', async () => {
    const { withRetry } = await import('../../services/retryPolicy');
    const fn = vi.fn<() => Promise<string>>().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxAttempts: 3, initialDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries and succeeds on the second attempt', async () => {
    const { withRetry } = await import('../../services/retryPolicy');
    const fn = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');
    const result = await withRetry(fn, { maxAttempts: 3, initialDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws RetryExhaustedError after all attempts fail', async () => {
    const { withRetry, RetryExhaustedError } = await import('../../services/retryPolicy');
    const fn = vi.fn<() => Promise<never>>().mockRejectedValue(new Error('always fails'));
    await expect(
      withRetry(fn, { maxAttempts: 2, initialDelayMs: 1 }),
    ).rejects.toThrow(RetryExhaustedError);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry when isRetryable returns false', async () => {
    const { withRetry } = await import('../../services/retryPolicy');
    const permanentError = new Error('permanent');
    const fn = vi.fn<() => Promise<never>>().mockRejectedValue(permanentError);
    await expect(
      withRetry(fn, { maxAttempts: 3, initialDelayMs: 1, isRetryable: () => false }),
    ).rejects.toThrow('permanent');
    expect(fn).toHaveBeenCalledTimes(1); // no retry
  });
});
