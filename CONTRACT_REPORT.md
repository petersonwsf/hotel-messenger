# CONTRACT_REPORT.md — Relatório de Contratos e DTOs de Integração

**Documento:** Análise de Lacunas e DTOs de Integração
**Serviço:** Microserviço de E-mail (hotel_messenger)
**Data:** 2026-09-28
**Escopo:** Integração de eventos entre `payments-service` (Node.js), `hospitality-service` (Spring Boot Java) e `hotel_messenger` (Node.js).

---

## 1. Visão Geral dos Eventos e Transportes

| Serviço Emissor | Linguagem | Exchange (RabbitMQ) | Routing Keys Suportadas |
|---|---|---|---|
| **Payments Service** | Node.js / TS | `hotel.events` (topic) | `payment.*` (ex: `payment.captured`, `payment.authorized`, `boleto.generated`) |
| **Hospitality Service** | Java / Spring Boot | `hotel.events` (topic) | `reservation.*` (ex: `reservation.created`, `reservation.confirmed`, `reservation.cancelled`) |

---

## 2. DTO do Serviço de Pagamentos (`payments-service`)

### 2.1 Mapeamentos e Regras Ajustadas no Sistema de E-mail:
1. **Valor cobrado no e-mail:** É utilizado o campo `amountCaptured` (em centavos).
2. **Método de Pagamento (`captureMethod`):**
   - `'AUTOMATIC'` → Traduzido automaticamente para **"Boleto"** (ou "Boleto bancário").
   - `'MANUAL'` → Traduzido automaticamente para **"Cartão de crédito"**.
   - Se o campo `paymentMethodLabel` for enviado explicitamente, ele terá prioridade.
3. **Dados do Cliente:** O evento de pagamento deve conter o e-mail e o nome do cliente (`recipientEmail` e `recipientName` ou `email`/`name`).

### 2.2 Enums do Serviço de Pagamentos:
```typescript
export enum PaymentEventType {
  PAYMENT_CREATED         = 'payment.created',
  PAYMENT_REQUIRES_ACTION = 'payment.requires_action',
  PAYMENT_AUTHORIZED      = 'payment.authorized',
  PAYMENT_CAPTURED        = 'payment.captured',
  PAYMENT_CANCELED        = 'payment.canceled',
  PAYMENT_FAILED          = 'payment.failed',
  PAYMENT_REFUNDED        = 'payment.refunded',
  BOLETO_GENERATED        = 'boleto.generated',
}
```

### 2.3 Estrutura Recomendada do DTO Publicado (`payment.captured`):
```json
{
  "eventId": "550e8400-e29b-41d4-a716-446655440000",
  "eventType": "payment.captured",
  "eventVersion": "1.0",
  "occurredAt": "2026-09-28T20:00:00.000Z",
  "source": "payments-service",
  "data": {
    "paymentId": 101,
    "reservationId": 42,
    "userId": 7,
    "recipientEmail": "cliente@email.com",
    "recipientName": "Nome do Cliente",
    "amountAuthorized": 15000,
    "amountCaptured": 15000,
    "currency": "BRL",
    "status": "CAPTURED",
    "captureMethod": "MANUAL",
    "createdAt": "2026-09-28T20:00:00.000Z",
    "updatedAt": "2026-09-28T20:00:00.000Z"
  }
}
```

---

## 3. DTO do Serviço de Reserva (`hospitality-service` - Java/Spring Boot)

### 3.1 Estrutura da Reserva na Base de Dados:
A reserva na base possui os seguintes campos nativos:
`id`, `check_in_date`, `check_out_date`, `daily_rate`, `total_amount`, `discount_amount`, `service_fee`, `status_reservation`, `created_at`, `updated_at`, `user_id`, `room_id`.

### 3.2 Regras do Sistema de E-mail para Reservas:
1. **Código da Reserva:** Como a tabela não possui uma coluna `code`, o sistema gera automaticamente `#<id>` (ex: `#1042`).
2. **Cálculo de Diárias (`totalNights`):** O sistema calcula automaticamente o total de noites a partir da diferença entre `check_in_date` e `check_out_date`.
3. **E-mail e Nome do Hóspede:** O sistema aceita tanto o DTO aninhado `user: { id, name, email }` (ou `login`) quanto campos no topo (`email`, `name`).

### 3.3 Enums do Serviço de Reserva:
```java
// Java Enum / Event Types
"reservation.confirmed" / "reservation.created"
"reservation.cancelled" / "reservation.canceled"
```

### 3.4 Estrutura Recomendada do DTO Publicado no Java (Spring Boot):

```java
// DTO em Java a ser serializado em JSON para a fila RabbitMQ
public class ReservationEventEnvelope {
    private String eventId;             // UUID ex: "660e8400-e29b-41d4-a716-446655440001"
    private String eventType;           // "reservation.confirmed" ou "reservation.cancelled"
    private String eventVersion;        // "1.0"
    private String occurredAt;          // ISO-8601 ex: "2026-09-28T20:00:00Z"
    private String source;              // "hospitality-service"
    private ReservationDataMessage data;
}

public class ReservationDataMessage {
    private Long id;
    private String check_in_date;       // Formato "YYYY-MM-DD"
    private String check_out_date;      // Formato "YYYY-MM-DD"
    private BigDecimal daily_rate;
    private BigDecimal total_amount;
    private BigDecimal discount_amount;
    private BigDecimal service_fee;
    private String status_reservation;  // Ex: "CONFIRMED", "CANCELLED"
    private String created_at;
    private String updated_at;
    private Long user_id;
    private Long room_id;

    // Dados do usuário (UserResponseDTO)
    private UserResponseDTO user;
}

public class UserResponseDTO {
    private Long id;
    private String name;
    private String email;              // ou 'login' contendo um e-mail válido
    private String phoneNumber;
    private String role;
}
```

---

## 4. Resumo das Modificações Realizadas no `hotel_messenger`

1. **Ajuste de Valor em Pagamentos:** O e-mail de comprovante utiliza estritamente `amountCaptured`.
2. **Mapeamento Automático de `captureMethod`:**
   - `AUTOMATIC` → Exibe **Boleto** no e-mail.
   - `MANUAL` → Exibe **Cartão de crédito** no e-mail.
3. **Adaptação Completa dos Campos da Reserva:**
   - Suporte total às colunas da tabela de reserva (`check_in_date`, `check_out_date`, `room_id`, `id`).
   - Cálculo automático de noites (`totalNights`).
   - Geração automática de código legível (`#<id>`).
4. **Resolução Flexível de E-mail/Nome:** Aceita tanto DTO aninhado `user` quanto campos no topo (`email`/`name`), com fallback automático de `login` para `email`.
