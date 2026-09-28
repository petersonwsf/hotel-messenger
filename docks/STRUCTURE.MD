# structure.md — Technical Specification for AI Agent

## 1. System Overview
This project is a **decoupled asynchronous email microservice**. It operates on an event-driven architecture, listening to a message queue on **RabbitMQ**, validating and parsing the received payloads, rendering HTML templates via **Handlebars**, and executing email deliveries using the **Resend API**.

The AI agent must build a resilient, strongly-typed **TypeScript (Node.js)** application designed to run continuously as a background worker process.

---

## 2. Directory and File Tree

Create and adhere strictly to the following directory structure:

```text
hotel_messenger/
├── docks/ # Context files for AI
├── src/
│   ├── config/
│   │   ├── env.ts             # Validation and export of environment variables
│   │   └── rabbitmq.ts        # Setup for connection, exchanges, and queues
│   ├── schemas/
│   │   └── emailSchema.ts     # Zod schema and types for the email payload
│   ├── services/
│   │   ├── templateService.ts # Dynamic reading and compiling of .hbs template files
│   │   └── resendService.ts   # Wrapper for Resend API calls
│   ├── templates/
│   │   ├── RESERVA_CONFIRMADA.hbs
│   │   ├── PAGAMENTO_RECEBIDO.hbs
│   │   └── RESERVA_CANCELADA.hbs
│   ├── consumers/
│   │   └── emailConsumer.ts   # Main RabbitMQ consumer worker process
│   └── index.ts               # Application entry point
├── .env.example
├── package.json
├── tsconfig.json
└── README.md