/**
 * retryPolicy.ts
 *
 * Generic retry-with-exponential-backoff utility.
 *
 * Used by the email consumer to handle transient failures (e.g., temporary
 * Resend API timeouts) before nacking a message to the DLQ.
 *
 * Design decisions:
 *  - Jitter is added to avoid thundering-herd on multi-instance deploys.
 *  - `isRetryable` predicate lets callers distinguish permanent from transient errors.
 *  - `RetryExhaustedError` wraps the last error, preserving the cause for logging.
 */

import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Maximum number of attempts (includes the first attempt). Default: 3 */
  maxAttempts?: number;
  /** Delay before the second attempt in milliseconds. Default: 500 */
  initialDelayMs?: number;
  /** Multiplier applied to the delay on each subsequent attempt. Default: 2 */
  backoffFactor?: number;
  /**
   * Called with the error from each failed attempt.
   * Return `true` to retry, `false` to throw immediately.
   * Default: always returns true.
   */
  isRetryable?: (error: unknown) => boolean;
}

export class RetryExhaustedError extends Error {
  public readonly attempts: number;
  public readonly cause: unknown;

  constructor(message: string, attempts: number, cause: unknown) {
    super(message);
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(baseMs: number): number {
  // Add ±25% random jitter to avoid synchronized retries across instances
  return baseMs + Math.floor((Math.random() * baseMs) / 2) - Math.floor(baseMs / 4);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Executes `fn` up to `maxAttempts` times with exponential backoff + jitter.
 *
 * @param fn - The async operation to retry.
 * @param options - Retry configuration.
 * @returns The resolved value of `fn` on success.
 * @throws `RetryExhaustedError` if all attempts fail.
 * @throws The original error immediately if `isRetryable` returns `false`.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts  = 3,
    initialDelayMs = 500,
    backoffFactor  = 2,
    isRetryable    = () => true,
  } = options;

  let lastError: unknown;
  let currentDelay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const retryable = isRetryable(error);

      logger.warn('Operation failed', {
        attempt,
        maxAttempts,
        retryable,
        error: error instanceof Error ? error.message : String(error),
      });

      if (!retryable) {
        throw error;
      }

      if (attempt < maxAttempts) {
        const waitMs = jitter(currentDelay);
        logger.debug('Retrying after backoff', { waitMs, nextAttempt: attempt + 1 });
        await delayMs(waitMs);
        currentDelay = currentDelay * backoffFactor;
      }
    }
  }

  throw new RetryExhaustedError(
    `Operation failed after ${maxAttempts} attempt(s)`,
    maxAttempts,
    lastError,
  );
}
