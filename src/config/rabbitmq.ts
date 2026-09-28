/**
 * rabbitmq.ts
 *
 * Establishes the RabbitMQ connection and declares the full topology required
 * to consume events from both the Payments Service and the Hospitality Service.
 *
 * Topology:
 *
 *   [payments-service]    ──► payment.*    ──►┐
 *                                             │  [hotel_events] (topic exchange)
 *   [hospitality-service] ──► reservation.* ──►┘
 *                                              │
 *                         bind payment.*  ─────┤
 *                         bind reservation.* ──┤──► [email_notifications] (queue)
 *                                              │               │ nack
 *                                              │               ▼
 *                                        [email_notifications_dlx] (fanout)
 *                                                       │
 *                                                       ▼
 *                                        [email_notifications_dlq] (queue)
 *
 * All configuration is read strictly from environment variables.
 * See src/config/env.ts for the full variable list.
 */

import amqp from 'amqplib';
import { env, QUEUE_NAMES, ROUTING_KEYS } from './env.js';
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
  logger.info('Connecting to RabbitMQ...', {
    url:      env.RABBITMQ_URL.replace(/\/\/.*@/, '//<credentials>@'),
    exchange: env.RABBITMQ_EXCHANGE,
    queue:    env.RABBITMQ_QUEUE,
  });

  const connection = await amqp.connect(env.RABBITMQ_URL);
  const channel    = await connection.createChannel();

  // Enforce back-pressure: process at most RABBITMQ_PREFETCH_COUNT unacked messages.
  await channel.prefetch(env.RABBITMQ_PREFETCH_COUNT);

  // ------------------------------------------------------------------
  // 1. Dead Letter Exchange (DLX) — fanout, durable
  //    Receives nacked / expired / rejected messages from the main queue.
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
  // 3. Main topic exchange — durable
  //    Both upstream services publish to this exchange with routing keys.
  // ------------------------------------------------------------------
  await channel.assertExchange(env.RABBITMQ_EXCHANGE, 'topic', {
    durable: true,
  });

  // ------------------------------------------------------------------
  // 4. Consumer queue — durable, with DLX routing on nack/reject/expiry
  // ------------------------------------------------------------------
  await channel.assertQueue(QUEUE_NAMES.main, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': QUEUE_NAMES.dlx,
    },
  });

  // ------------------------------------------------------------------
  // 5. Bind consumer queue to the topic exchange for each routing pattern
  //    payment.*      → all Payments Service events
  //    reservation.*  → all Hospitality Service events
  // ------------------------------------------------------------------
  for (const routingKey of Object.values(ROUTING_KEYS)) {
    await channel.bindQueue(QUEUE_NAMES.main, env.RABBITMQ_EXCHANGE, routingKey);
    logger.debug('Queue bound to exchange', {
      queue:      QUEUE_NAMES.main,
      exchange:   env.RABBITMQ_EXCHANGE,
      routingKey,
    });
  }

  logger.info('RabbitMQ topology ready', {
    exchange:  env.RABBITMQ_EXCHANGE,
    mainQueue: QUEUE_NAMES.main,
    dlq:       QUEUE_NAMES.dlq,
    dlx:       QUEUE_NAMES.dlx,
    bindings:  Object.values(ROUTING_KEYS),
    prefetch:  env.RABBITMQ_PREFETCH_COUNT,
  });

  return { connection, channel };
}
