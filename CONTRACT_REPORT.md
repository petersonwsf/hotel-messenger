# CONTRACT_REPORT.md — Gap Analysis for External Service Payloads

**Document type:** Contract Gap Analysis
**Author:** hotel_messenger team
**Date:** 2026-09-28
**Scope:** Payments Service & Hospitality Service payloads consumed by the Transactional Email Microservice

---

## 1. Executive Summary

The Transactional Email Microservice consumes events from two upstream producers:

| Service | Language/Framework | Transport |
|---|---|---|
| Payments Service | Node.js / TypeScript | RabbitMQ topic exchange, routing key `payment.*` |
| Hospitality Service | Java / Spring Boot | RabbitMQ topic exchange, routing key `reservation.*` |

After reviewing the proposed payload contracts against the email dispatch requirements (recipient address, personalisation data, and template variables), **two structural gaps** were identified — one critical and one minor. Both require changes to upstream producers before the notification service can dispatch emails without additional HTTP callbacks or database reads.

---

## 2. Gap Analysis — Payments Service

### 2.1 Payload reviewed

```typescript
// PaymentDataBase (payments-service)
export interface PaymentDataBase {
  paymentId: number;
  reservationId: number;
  userId: number;
  stripePaymentIntentId: string;
  amountAuthorized: number;
  amountCaptured: number;
  currency: string;
  status: PaymentStatus;
  captureMethod: CaptureMethod;
  createdAt: string;
  updatedAt: string;
}
```

### 2.2 Identified gaps

| # | Gap | Severity | Required for |
|---|---|---|---|
| P-1 | **No recipient email address.** `PaymentDataBase` contains `userId` but no `email` field. The notification service cannot dispatch a payment email without knowing where to send it. | 🔴 **Critical** | `sendEmail({ to })` |
| P-2 | **No guest / cardholder name.** Templates use `guestName` for personalisation (e.g. "Olá, João"). `userId` is a foreign key that cannot be resolved without a DB call. | 🟡 **High** | Handlebars `{{guestName}}` |
| P-3 | **`amountAuthorized` vs `amountCaptured` ambiguity.** The email receipt should show the amount actually charged. The contract exposes both; it is unclear which should be used. | 🟠 **Medium** | `PAGAMENTO_RECEBIDO` template |
| P-4 | **No human-readable payment method.** `captureMethod` is an internal enum (`AUTOMATIC`, `MANUAL`). Templates need a displayable label like "Cartão de Crédito" or "Pix". | 🟠 **Medium** | `PAGAMENTO_RECEBIDO` template |

### 2.3 Proposed changes to `PaymentDataBase`

```typescript
export interface PaymentDataBase {
  paymentId: number;
  reservationId: number;
  userId: number;

  // --- NEW FIELDS REQUIRED BY NOTIFICATION SERVICE ---

  /** Recipient email address. Sourced from the user record at publish time. */
  recipientEmail: string;          // Gap P-1 ✅

  /** Guest full name for email personalisation. */
  recipientName: string;           // Gap P-2 ✅

  /** Human-readable payment method label shown in the receipt email. */
  paymentMethodLabel: string;      // Gap P-4 ✅ (e.g. "Pix", "Cartão de Crédito")

  // --- EXISTING FIELDS ---
  stripePaymentIntentId: string;
  amountAuthorized: number;
  amountCaptured: number;          // Gap P-3: email uses amountCaptured
  currency: string;
  status: PaymentStatus;
  captureMethod: CaptureMethod;
  createdAt: string;
  updatedAt: string;
}
```

> **Justification:** The notification service operates as a pure consumer with no read access to the user database or the payments database. Embedding `recipientEmail` and `recipientName` in the event payload at publish time is the standard EDA pattern — the producer holds the data at the moment of the event and should denormalise it for downstream consumers. This avoids tight coupling and avoids HTTP round-trips in the hot path.

---

## 3. Gap Analysis — Hospitality Service

### 3.1 Payload reviewed

```typescript
// UserResponseDTO (hospitality-service)
export interface UserResponseDTO {
  id: number;
  name: string;
  login: string;      // ← ambiguous: is this the email address?
  phoneNumber: string;
  role: string;
  imageKey: string;
}

// ReservationDataMessage (hospitality-service)
export interface ReservationDataMessage {
  id: number;
  user: UserResponseDTO;
}
```

### 3.2 Identified gaps

| # | Gap | Severity | Required for |
|---|---|---|---|
| H-1 | **`login` field is ambiguous.** In Spring Boot's `UserDetails`, `getUsername()` returns the login/username, which in many systems _is_ the email but is not guaranteed. The field name `login` does not communicate this clearly. | 🟡 **High** | `sendEmail({ to })` |
| H-2 | **No reservation-specific data in `ReservationDataMessage`.** For `RESERVA_CONFIRMADA`, the template requires `checkIn`, `checkOut`, `roomType`, `totalNights`, `reservationCode`. None of these are present. | 🔴 **Critical** | `RESERVA_CONFIRMADA` template |
| H-3 | **`eventType` is `string` instead of a typed enum.** The envelope defines `eventType: string`, making exhaustiveness checks impossible and allowing undocumented routing keys to arrive silently. | 🟠 **Medium** | Message router type-safety |

### 3.3 Proposed changes

#### 3.3.1 Rename `login` → `email` in `UserResponseDTO`

```java
// Java DTO — UserResponseDTO.java
public class UserResponseDTO {
    private Long id;
    private String name;
    private String email;          // RENAMED from 'login' — Gap H-1 ✅
    private String phoneNumber;
    private String role;
    private String imageKey;
}
```

> If renaming is not possible (e.g. `login` is a public API contract), add an explicit `email` field derived from the Spring Security `UserDetails.getUsername()` at serialisation time.

#### 3.3.2 Enrich `ReservationDataMessage` with booking details

```java
// Java DTO — ReservationDataMessage.java  (Gap H-2 ✅)
public class ReservationDataMessage {
    private Long id;                        // reservation internal ID
    private String reservationCode;         // human-readable code, e.g. "RES-2026-0042"
    private UserResponseDTO user;
    private LocalDate checkIn;
    private LocalDate checkOut;
    private Integer totalNights;
    private String roomType;
    // For cancellations:
    private String cancellationReason;      // nullable
    private Long refundAmountCents;         // nullable
    private String refundCurrency;          // nullable, ISO 4217
}
```

#### 3.3.3 Type the `eventType` field with an enum

```typescript
// TypeScript contract (Gap H-3 ✅)
export enum ReservationEventType {
  RESERVA_CONFIRMADA = 'reservation.confirmed',
  RESERVA_CANCELADA  = 'reservation.cancelled',
}

export interface ReservationMessageEnvelope<T = ReservationDataMessage> {
  eventId: string;
  eventType: ReservationEventType;   // was: string
  eventVersion: string;
  occurredAt: string;
  source: string;
  correlationId?: string;
  data: T;
}
```

---

## 4. Decision: `login` field interim handling

Until the Hospitality Service publishes a renamed `email` field, the notification service will:

1. **Prefer `data.user.email`** if present (forward-compatible with the proposed fix).
2. **Fall back to `data.user.login`** if `email` is absent and `login` is a valid RFC 5322 email address (validated by Zod).
3. **Nack to DLQ** if neither field is a valid email — a clear, observable failure that surfaces the missing data rather than silently discarding the notification.

This logic is implemented in `src/schemas/reservationSchema.ts` (transform step) and documented inline.

---

## 5. Impact Summary

| Service | Change required | Breaking? | Notification service blocks? |
|---|---|---|---|
| Payments Service | Add `recipientEmail`, `recipientName`, `paymentMethodLabel` to `PaymentDataBase` | No (additive) | ✅ Yes — cannot send emails without |
| Hospitality Service | Rename `login` → `email` **or** add explicit `email` field | No (additive) | ✅ Yes (mitigated by fallback) |
| Hospitality Service | Enrich `ReservationDataMessage` with booking fields | No (additive) | ✅ Yes — templates cannot render |
| Hospitality Service | Type `eventType` with enum | No (additive) | No — handled via string mapping |

---

## 6. Recommended Next Steps

1. **[Payments Team]** Add `recipientEmail`, `recipientName`, `paymentMethodLabel` to the `PAYMENT_CAPTURED` event publisher.
2. **[Hospitality Team]** Add `email` field (or rename `login`) and add booking fields to `ReservationDataMessage`.
3. **[Both Teams]** Update OpenAPI/AsyncAPI specs and notify the notification team.
4. **[Notification Team]** Remove the `login`-fallback once the `email` field is confirmed live.
