# Project Context — Transactional Email Microservice

This document is the **primary source of truth** for any AI agent or developer working in this repository. It defines the business context, the overall architecture, coding rules, and the resilience expectations of the system.

> **Companion document:** `structure.md` — detailed technical implementation spec (folder-by-folder, file-by-file). Always read both before making changes.

---

## 1. Business Context & Overview

This repository contains the **Transactional Email Microservice** for a hotel management system.

- **Purpose:** Process and send critical customer notifications (booking confirmations, check-in/check-out reminders, payment receipts, and cancellations).
- **Core Premise:** Email sending must be **fully asynchronous and decoupled** from the main hotel system. No route in the hotel's main API should ever wait on the email service's response to reply to the customer.
- **Paradigm:** Event-Driven Architecture (EDA).

---

## 2. Architecture & Data Flow

```text
┌──────────────────────┐         ┌───────────────────────┐
│ System Backend        │         │ RabbitMQ Broker        │
│ (Hotel / Main System)│────►────│ Exchange / Queue        │
└──────────────────────┘         └──────────┬────────────┘
                                             │ (Async consumption)
                                             ▼
┌────────────────────────────────────────────────────────┐
│ Email Microservice (This Repository)                   │
│                                                          │
│  1. Validation (Zod)                                     │
│  2. Template rendering (Handlebars .hbs)                 │
│  3. Email dispatch (Resend SDK)                          │
└──────────────────────────┬───────────────────────────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │ Resend API       │ ──► [Customer Inbox]
                   └─────────────────┘
```

**Flow steps:**

1. The main hotel system publishes a JSON message to the RabbitMQ queue whenever a relevant event occurs.
2. This microservice continuously consumes messages from that queue.
3. Each message is validated against a Zod schema. If invalid, it is routed to the Dead Letter Queue (DLQ).
4. The HTML template matching the event type is compiled with Handlebars, using the payload data.
5. The Resend API is called to dispatch the email.
6. On success, the message is acknowledged (`ack`) and removed from the queue.

---

## 3. Technology Stack

| Concern | Technology |
|---|---|
| Language & Runtime | Node.js + TypeScript |
| Message Broker | RabbitMQ (`amqplib`) |
| Email Provider | Resend (`resend`) |
| Template Engine | Handlebars (`handlebars`) |
| Contract Validation | Zod (`zod`) |
| Process Manager (Prod) | PM2 / Docker container |

---

## 4. Development Guidelines for AI Agents

When performing any task or code change in this repository, the AI agent **must** strictly follow the rules below.

### 4.1 Code & Typing Rules

- **Strict TypeScript:** never use `any` under any circumstance. All data structures, parameters, and return values must be strongly typed.
- **Validation at the boundary:** every piece of external data (queue messages, environment variables) must be validated with Zod before being used in business logic.
- **Exception handling:** the Node.js worker process must never crash due to a malformed message or an external API error. Every error must be caught inside the consumer's `try/catch` block, logged, and routed to the DLQ.

### 4.2 Queue Resilience Strategy (RabbitMQ)

- **Prefetch limit:** the consumer must be configured with `channel.prefetch(1)` to prevent overload and ensure the worker processes one message at a time.
- **Manual acknowledgment (`ack`/`nack`):** a message should only receive `ack` after Resend confirms the email was sent successfully.
- **Failure handling (DLQ):** on an unrecoverable failure (invalid data, missing template) or a Resend API error, the message must be rejected with `channel.nack(msg, false, false)` so it is automatically routed to the Dead Letter Queue (`email_notifications_dlq`).
- **Idempotency:** each message should carry a unique event/message ID; the consumer should be able to detect and safely skip duplicate deliveries (RabbitMQ guarantees at-least-once delivery, not exactly-once).
- **Retry policy:** transient failures (e.g., temporary Resend API timeout) should be retried with backoff before being sent to the DLQ; only exhausted retries or permanently invalid payloads should be nacked to the DLQ directly.

### 4.3 Template Management

- All email templates must live in `src/templates/`.
- Template files must use the `.hbs` (Handlebars) extension.
- The template file name must exactly match the event key registered in the Zod schema enum (e.g., `RESERVA_CONFIRMADA.hbs`).

### 4.4 Observability & Logging

- Every processed message must produce a structured log entry (event type, message ID, outcome: ack/nack/retry) to support tracing and debugging.
- Log entries must never include sensitive customer data (full email content, payment details) in plaintext — mask or omit as needed.
- Consider exposing a lightweight health-check endpoint/process indicator so the worker's liveness can be monitored independently of the queue.

### 4.5 Security & Configuration

- All secrets (Resend API key, RabbitMQ credentials) must be sourced from environment variables, validated with Zod at startup, and never hardcoded or logged.
- `.env.example` must always be kept in sync with any new environment variable introduced in the code.

### 4.6 Testing Expectations

- New consumers, schemas, or services should include unit tests for the happy path and for the main failure modes (invalid payload, missing template, provider error).
- Template rendering should be tested with representative payloads to catch missing Handlebars variables early.

---

## 5. Standard File Structure

```text
hotel_messenger/
├── docks/
├────── README.md               # This context file
├────── structure.md            # Detailed technical implementation spec
├── .env.example             # Environment variable example
├── package.json             # Project scripts and dependencies
├── tsconfig.json             # TypeScript compiler configuration
└── src/
    ├── config/               # Connection modules (RabbitMQ, env vars)
    ├── consumers/             # Queue listeners and workers
    ├── schemas/               # Zod schemas and TypeScript types
    ├── services/               # External service integrations (Resend, Handlebars)
    ├── templates/               # HTML template files (.hbs)
    └── index.ts                # Worker entrypoint
```

---

## 6. Primary Instruction for AI Agents

Whenever you receive a request to write or change code in this project:

1. Consult the structure defined in this `README.md` and in the technical spec in `structure.md`.
2. Ensure every change preserves the microservice's decoupling from the main hotel system.
3. Do not add unnecessary dependencies to the project without prior authorization.
4. Follow the coding, resilience, template, observability, and security rules in Section 4 without exception.
5. When a request conflicts with any rule above, flag the conflict explicitly instead of silently overriding the rule.