/**
 * rabbitmq.ts
 *
 * Establishes the RabbitMQ connection, declares all required topology
 * (main queue + Dead Letter Exchange + DLQ), and returns the live channel.
 *
 * Topology summary:
 *
 *   [Producer] ──► [email_notifications] ──(nack)──► [email_notifications_dlx]
 *                                                              │
 *                                                              ▼
 *                                                   [email_notifications_dlq]
 *
 * The DLX is a fanout exchange. The DLQ is a plain durable queue bound to it.
 * This ensures nacked messages are always captured and never silently dropped.
 */

import amqp from 'amqplib';
import { env, QUEUE_NAMES } from './env.js';
import { logger } from '../services/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RabbitMQConnection {
  connection: amqp.ChannelModel;
  channel: amqp.Channel;
}

// ---------------------------------------------------------------------------
// Connection & topology setup
// ---------------------------------------------------------------------------

export async function connectRabbitMQ(): Promise<RabbitMQConnection> {
  logger.info('Connecting to RabbitMQ...', { url: env.RABBITMQ_URL.replace(/\/\/.*@/, '//<credentials>@') });

  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel    = await connection.createChannel();

  // Enforce single in-flight message per consumer instance (back-pressure).
  await channel.prefetch(1);

  // ------------------------------------------------------------------
  // 1. Dead Letter Exchange (DLX) — fanout, durable
  // ------------------------------------------------------------------
  await channel.assertExchange(QUEUE_NAMES.dlx, 'fanout', {
    durable: true,
  });

  // ------------------------------------------------------------------
  // 2. Dead Letter Queue (DLQ) — durable, bound to DLX
  // ------------------------------------------------------------------
  await channel.assertQueue(QUEUE_NAMES.dlq, {
    durable: true,
  });
  await channel.bindQueue(QUEUE_NAMES.dlq, QUEUE_NAMES.dlx, '');

  // ------------------------------------------------------------------
  // 3. Main queue — durable, with DLX routing on nack/reject/expiry
  // ------------------------------------------------------------------
  await channel.assertQueue(QUEUE_NAMES.main, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': QUEUE_NAMES.dlx,
    },
  });

  logger.info('RabbitMQ topology ready', {
    mainQueue: QUEUE_NAMES.main,
    dlq:       QUEUE_NAMES.dlq,
    dlx:       QUEUE_NAMES.dlx,
  });

  return { connection, channel };
}
