/**
 * resendService.ts
 *
 * Isolated wrapper for the Resend email delivery API.
 *
 * Responsibilities:
 *  - Instantiate the Resend SDK with the API key from validated env.
 *  - Translate SDK responses into typed errors the consumer can reason about.
 *  - Never log the recipient address, email body, or the API key.
 *
 * Error classification (for retryPolicy.ts):
 *  - `ResendApiError` with `isTransient = true`  → safe to retry (5xx, network)
 *  - `ResendApiError` with `isTransient = false`  → nack immediately (4xx, bad data)
 */

import { Resend } from 'resend';
import { env } from '../config/env.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

export class ResendApiError extends Error {
  /** HTTP-like status code from the Resend API, or 0 for network-level errors. */
  public readonly statusCode: number;
  /**
   * `true`  → caller may retry (transient: 5xx, network failures)
   * `false` → caller must nack immediately (permanent: 4xx, bad data)
   */
  public readonly isTransient: boolean;

  constructor(message: string, statusCode: number, isTransient: boolean) {
    super(message);
    this.name       = 'ResendApiError';
    this.statusCode  = statusCode;
    this.isTransient = isTransient;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SendEmailParams {
  /** Recipient email address. Never logged in plaintext. */
  to: string;
  /** Email subject line. */
  subject: string;
  /** Pre-rendered HTML body. Never logged in plaintext. */
  html: string;
}

// ---------------------------------------------------------------------------
// SDK singleton
// ---------------------------------------------------------------------------

const resend = new Resend(env.RESEND_API_KEY);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sends a transactional email via the Resend API.
 *
 * @throws `ResendApiError` on any delivery failure, with `isTransient`
 *   indicating whether the caller should retry or nack immediately.
 */
export async function sendEmail(params: SendEmailParams): Promise<void> {
  // Log intent without sensitive fields
  logger.debug('Dispatching email via Resend', {
    subject: params.subject,
    from:    env.EMAIL_FROM,
    // `to` and `html` are intentionally omitted from logs
  });

  const { data, error } = await resend.emails.send({
    from:    env.EMAIL_FROM,
    to:      params.to,
    subject: params.subject,
    html:    params.html,
  });

  if (error) {
    // Resend SDK returns a typed error object with a `name` and `message`.
    // We don't have a numeric statusCode from the SDK object directly, so we
    // classify by error name as documented in Resend's error reference.
    const isTransient = isTransientResendError(error.name);

    logger.warn('Resend API returned an error', {
      errorName: error.name,
      isTransient,
      // message may contain email addresses — omit from logs
    });

    throw new ResendApiError(
      `Resend error [${error.name}]: ${error.message}`,
      isTransient ? 503 : 422,
      isTransient,
    );
  }

  logger.debug('Email dispatched successfully', { resendId: data?.id });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Classifies a Resend error by name as transient or permanent.
 * Reference: https://resend.com/docs/api-reference/errors
 */
function isTransientResendError(errorName: string): boolean {
  const transientErrors = new Set([
    'internal_server_error',
    'rate_limit_exceeded',
    'service_unavailable',
  ]);
  return transientErrors.has(errorName.toLowerCase());
}

/**
 * Predicate compatible with `RetryOptions.isRetryable`.
 * Pass this to `withRetry` in the consumer.
 */
export function isRetryableResendError(error: unknown): boolean {
  if (error instanceof ResendApiError) {
    return error.isTransient;
  }
  // Network-level errors (ECONNREFUSED, ETIMEDOUT, etc.) are always transient
  if (error instanceof Error) {
    const networkCodes = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'];
    return networkCodes.some((code) => error.message.includes(code));
  }
  return false;
}
