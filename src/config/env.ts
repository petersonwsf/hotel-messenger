/**
 * env.ts
 *
 * Environment variable validation using Zod.
 *
 * This module is the single source of truth for all configuration values.
 * It must be imported before any other module that requires env vars.
 *
 * Rules:
 *  - Fails fast at process startup with a descriptive error if any required
 *    variable is missing or malformed — prevents the worker from running in a
 *    broken state.
 *  - Secrets are never re-exported as plain strings accessible to logging.
 *  - `dotenv` is loaded here so callers don't need to call `config()` themselves.
 *
 * Architecture note:
 *  The service now binds to a single **topic exchange** (RABBITMQ_EXCHANGE)
 *  and uses routing key patterns `payment.*` and `reservation.*` to receive
 *  events from both the Payments Service and the Hospitality Service.
 */

import 'dotenv/config';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const envSchema = z.object({
  /** Full AMQP connection URL, e.g. amqp://user:pass@localhost:5672 */
  RABBITMQ_URL: z
    .string()
    .min(1, 'RABBITMQ_URL is required')
    .startsWith('amqp', 'RABBITMQ_URL must start with amqp:// or amqps://'),

  /**
   * Topic exchange name that both the Payments and Hospitality Services publish to.
   * Default: hotel_events
   */
  RABBITMQ_EXCHANGE: z
    .string()
    .min(1)
    .default('hotel_events'),

  /**
   * Consumer queue name. The DLQ is derived as <RABBITMQ_QUEUE>_dlq automatically.
   * Default: email_notifications
   */
  RABBITMQ_QUEUE: z
    .string()
    .min(1)
    .default('email_notifications'),

  /**
   * Maximum number of unacknowledged messages per channel (back-pressure).
   * Default: 1 (process one message at a time, safest for exactly-once semantics).
   */
  RABBITMQ_PREFETCH_COUNT: z
    .string()
    .regex(/^\d+$/, 'RABBITMQ_PREFETCH_COUNT must be a positive integer')
    .transform(Number)
    .pipe(z.number().int().positive())
    .default('1'),

  /** Resend API key — must NOT be logged. */
  RESEND_API_KEY: z
    .string()
    .min(1, 'RESEND_API_KEY is required')
    .startsWith('re_', 'RESEND_API_KEY must start with re_'),

  /**
   * The "From" address used in all dispatched emails.
   * Must be a domain verified in Resend (e.g. "Hotel <noreply@yourdomain.com>").
   */
  EMAIL_FROM: z
    .string()
    .min(1, 'EMAIL_FROM is required'),

  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),

  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error'])
    .default('info'),
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    // Intentionally crash the process — a misconfigured worker must not run.
    throw new Error(
      `[env] Environment variable validation failed:\n${issues}\n\nSee .env.example for reference.`,
    );
  }

  return result.data;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const env = validateEnv();

/** Derived queue names based on the configured main queue. */
export const QUEUE_NAMES = {
  main: env.RABBITMQ_QUEUE,
  dlq:  `${env.RABBITMQ_QUEUE}_dlq`,
  dlx:  `${env.RABBITMQ_QUEUE}_dlx`,
} as const;

/**
 * Routing key patterns this consumer binds to on the topic exchange.
 * Pattern `payment.*`     → all events from the Payments Service.
 * Pattern `reservation.*` → all events from the Hospitality Service.
 */
export const ROUTING_KEYS = {
  payments:    'payment.*',
  reservations: 'reservation.*',
} as const;

export type RoutingKey = (typeof ROUTING_KEYS)[keyof typeof ROUTING_KEYS];

