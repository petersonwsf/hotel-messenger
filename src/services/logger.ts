/**
 * logger.ts
 *
 * Structured JSON logger for the email microservice.
 *
 * Rules enforced here (per README §4.4):
 *  - All log entries are JSON-serialized objects written to stdout/stderr.
 *  - Sensitive fields are automatically redacted before output.
 *  - Log level is controlled by the LOG_LEVEL environment variable.
 *  - No external dependencies — uses Node.js built-in `console`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  [key: string]: unknown;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Sensitive field redaction
// ---------------------------------------------------------------------------

/**
 * Keys whose values will be replaced with "[REDACTED]" in log output.
 * Comparison is case-insensitive.
 */
const SENSITIVE_KEYS = new Set([
  'to',
  'email',
  'password',
  'apikey',
  'resendapikey',
  'resend_api_key',
  'cardnumber',
  'cvv',
  'ccv',
  'html',
  'content',
  'authorization',
  'token',
  'secret',
]);

export function maskSensitive(obj: LogContext): LogContext {
  const masked: LogContext = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      masked[key] = '[REDACTED]';
    } else if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      masked[key] = maskSensitive(value as LogContext);
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

// ---------------------------------------------------------------------------
// Level ordering
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info:  1,
  warn:  2,
  error: 3,
};

function resolveLogLevel(): LogLevel {
  const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'info';
}

// ---------------------------------------------------------------------------
// Core logging function
// ---------------------------------------------------------------------------

function log(level: LogLevel, message: string, context?: LogContext): void {
  const configuredLevel = resolveLogLevel();
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel]) {
    return;
  }

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(context ? maskSensitive(context) : {}),
  };

  const serialized = JSON.stringify(entry);

  if (level === 'error' || level === 'warn') {
    console.error(serialized);
  } else {
    console.log(serialized);
  }
}

// ---------------------------------------------------------------------------
// Public logger interface
// ---------------------------------------------------------------------------

export const logger = {
  debug: (message: string, context?: LogContext): void =>
    log('debug', message, context),

  info: (message: string, context?: LogContext): void =>
    log('info', message, context),

  warn: (message: string, context?: LogContext): void =>
    log('warn', message, context),

  error: (message: string, context?: LogContext): void =>
    log('error', message, context),
} as const;
