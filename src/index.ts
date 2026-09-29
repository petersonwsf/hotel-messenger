/**
 * index.ts
 *
 * Application entrypoint for the Transactional Email Microservice.
 *
 * Responsibilities:
 *  - Validate environment variables (via env.ts import — fails fast if invalid).
 *  - Connect to RabbitMQ and start the email consumer.
 *  - Auto-reconnect on broker disconnection with exponential backoff.
 *  - Graceful shutdown on SIGTERM/SIGINT: drain in-flight, close channel & connection.
 *
 * Process survival guarantee:
 *  - Uncaught exceptions and unhandled promise rejections are caught at this
 *    level and logged; they do NOT crash the process.
 *  - Only an explicit SIGTERM/SIGINT or max-retry exhaustion exits the process.
 */

// Must be the first import so env is validated before anything else runs.
import './config/env.js';

import amqp from 'amqplib';
import { connectRabbitMQ } from './config/rabbitmq.js';
import { startEmailConsumer } from './consumers/emailConsumer.js';
import { logger } from './services/logger.js';

// ---------------------------------------------------------------------------
// Reconnection configuration
// ---------------------------------------------------------------------------

const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

// ---------------------------------------------------------------------------
// Graceful shutdown state
// ---------------------------------------------------------------------------

let activeConnection: amqp.ChannelModel | null = null;
let activeChannel:    amqp.Channel    | null = null;
let isShuttingDown = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('Graceful shutdown initiated', { signal });

  // Cancel any pending reconnect timer
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    if (activeChannel !== null) {
      await activeChannel.close();
      logger.info('RabbitMQ channel closed');
    }
  } catch (err) {
    logger.warn('Error closing channel', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    if (activeConnection !== null) {
      await activeConnection.close();
      logger.info('RabbitMQ connection closed');
    }
  } catch (err) {
    logger.warn('Error closing connection', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info('Shutdown complete');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Connection bootstrap with auto-reconnect
// ---------------------------------------------------------------------------

async function connect(attempt = 1): Promise<void> {
  if (isShuttingDown) return;

  try {
    const { connection, channel } = await connectRabbitMQ();

    activeConnection = connection;
    activeChannel    = channel;

    // Attach connection-level event listeners
    connection.on('error', (err: Error) => {
      logger.error('RabbitMQ connection error', { error: err.message });
      // 'close' will follow; reconnect is handled there
    });

    connection.on('close', () => {
      if (isShuttingDown) return;
      logger.warn('RabbitMQ connection closed unexpectedly — scheduling reconnect');
      activeConnection = null;
      activeChannel    = null;
      scheduleReconnect(1);
    });

    await startEmailConsumer(channel);

    logger.info('Worker is running and consuming messages 🚀');

  } catch (err) {
    logger.error('Failed to connect to RabbitMQ', {
      attempt,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
      error: err instanceof Error ? err.message : String(err),
    });

    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      logger.error('Maximum reconnection attempts reached — exiting process');
      process.exit(1);
    }

    scheduleReconnect(attempt + 1);
  }
}

function scheduleReconnect(nextAttempt: number): void {
  if (isShuttingDown) return;

  // Exponential backoff capped at MAX_RECONNECT_DELAY_MS
  const delay = Math.min(
    INITIAL_RECONNECT_DELAY_MS * Math.pow(2, nextAttempt - 1),
    MAX_RECONNECT_DELAY_MS,
  );

  logger.info('Reconnecting to RabbitMQ...', {
    attempt: nextAttempt,
    delayMs: delay,
  });

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(nextAttempt).catch((err: unknown) => {
      logger.error('Unexpected error during reconnect', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, delay);
}

// ---------------------------------------------------------------------------
// Process-level safety nets
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err: Error) => {
  logger.error('Uncaught exception — process continues', { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Unhandled promise rejection — process continues', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

// ---------------------------------------------------------------------------
// Signal handlers
// ---------------------------------------------------------------------------

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

logger.info('Hotel Messenger — Transactional Email Microservice starting', {
  nodeVersion: process.version,
  pid: process.pid,
});

connect().catch((err: unknown) => {
  logger.error('Fatal startup error', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
