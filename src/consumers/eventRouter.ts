/**
 * eventRouter.ts
 *
 * Inspects incoming RabbitMQ messages and routes them to the correct
 * schema parser based on the message's routing key.
 *
 * Supported routing key patterns (bound in rabbitmq.ts):
 *   payment.*      → PaymentEventEnvelope   (Payments Service)
 *   reservation.*  → ReservationMessageEnvelope (Hospitality Service)
 *
 * Design:
 *  - Routing key is extracted from amqplib's `msg.fields.routingKey`.
 *  - The router returns a typed `RoutedEvent` discriminated union so the
 *    consumer has full type-safety without re-parsing or casting.
 *  - Unknown routing keys are rejected with a `RouterError` — the consumer
 *    nacks them to the DLQ.
 */

import { z } from 'zod';
import {
  paymentEventEnvelopeSchema,
  type PaymentEventEnvelope,
} from '../schemas/paymentSchema.js';
import {
  reservationMessageEnvelopeSchema,
  type ReservationMessageEnvelope,
} from '../schemas/reservationSchema.js';
import { logger } from '../services/logger.js';

// ---------------------------------------------------------------------------
// Discriminated union of all routed event types
// ---------------------------------------------------------------------------

export type RoutedEvent =
  | { source: 'payments-service';    event: PaymentEventEnvelope }
  | { source: 'hospitality-service'; event: ReservationMessageEnvelope };

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

export class RouterError extends Error {
  public readonly routingKey: string;

  constructor(message: string, routingKey: string) {
    super(message);
    this.name       = 'RouterError';
    this.routingKey = routingKey;
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Parses and routes a raw RabbitMQ message body by its routing key.
 *
 * @param routingKey  - AMQP routing key from `msg.fields.routingKey`
 * @param rawBody     - `msg.content.toString()` (raw JSON string)
 * @returns           A strongly-typed `RoutedEvent` union member.
 * @throws `RouterError`  if the routing key is unrecognised.
 * @throws `Error`        if JSON parsing fails.
 * @throws `z.ZodError`   if schema validation fails (captured by caller).
 */
export function routeMessage(routingKey: string, rawBody: string): RoutedEvent {
  logger.debug('Routing incoming message', { routingKey });

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error(`Failed to parse message JSON for routing key "${routingKey}"`);
  }

  if (routingKey.startsWith('payment.')) {
    const result = paymentEventEnvelopeSchema.safeParse(parsed);
    if (!result.success) {
      logValidationFailure(routingKey, result.error);
      throw result.error;
    }
    return { source: 'payments-service', event: result.data };
  }

  if (routingKey.startsWith('reservation.')) {
    const result = reservationMessageEnvelopeSchema.safeParse(parsed);
    if (!result.success) {
      logValidationFailure(routingKey, result.error);
      throw result.error;
    }
    return { source: 'hospitality-service', event: result.data };
  }

  throw new RouterError(
    `No handler registered for routing key "${routingKey}". ` +
    'Supported prefixes: payment.*, reservation.*',
    routingKey,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function logValidationFailure(routingKey: string, error: z.ZodError): void {
  logger.error('Schema validation failed for incoming message', {
    routingKey,
    issues: error.issues.map((i) => ({
      path:    i.path.join('.'),
      message: i.message,
    })),
  });
}
