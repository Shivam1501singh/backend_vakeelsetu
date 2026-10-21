# Implementation Plan: Razorpay Payments for Consultancy Packages — VakeelSetu Backend

## Overview & Architecture
This document details the architectural plan, database schema, state machine, API contracts, cron schedules, risk assessments, and recommendations for integrating Razorpay payments into VakeelSetu's backend consultancy module.

The core business flow is:
**Pay First, Request Created Second.** The `ConsultancyRequest` row is created **only after** payment capture is verified by Razorpay.

---

## 1. Current Behaviour Analysis

### Consultancy Endpoints & Flow
1. **User Booking:** `POST /api/user/consultancy` (restricted to role `USER`) accepts `{ callType, duration, phoneNumber, email }`. It computes price via `getConsultancyPrice(callType, duration)` and immediately creates a `ConsultancyRequest` in `PENDING` status with no payment requirement.
2. **User History:** `GET /api/user/consultancy` and `GET /api/user/consultancy/:id` list the authenticated user's requests.
3. **Admin Management:**
   - `GET /api/admin/consultancy` (requires `consultancy:view` permission) lists requests ordered by `createdAt ASC, id ASC`.
   - `PATCH /api/admin/consultancy/:id/status` (requires `consultancy:update` permission) transitions a request to `COMPLETED` and sets `completedAt`.
4. **Data Model:**
   - `ConsultancyRequest`: fields `id`, `userId`, `callType` (`CALL` | `VIDEO_CALL`), `duration` (15 | 30), `price` (Decimal 10,2), `phoneNumber`, `email`, `status` (`PENDING` | `COMPLETED`), `completedAt`, `createdAt`, `updatedAt`.
5. **Runtime Environment & Limitations:**
   - `src/server.js` applies `express.json()` globally. Razorpay webhook signature verification requires raw binary/unparsed body (`express.raw({ type: 'application/json' })`) before JSON parsing.
   - Deployments on Vercel run as serverless function handlers (`api/index.js` -> `src/server.js`). There is no persistent event loop daemon, meaning `setInterval` background jobs cannot run. All recurring jobs must be triggered via Vercel Crons or external HTTP cron calls.

---

## 2. Final Database Design

### Enums
```prisma
enum PaymentStatus {
  CREATED
  PROCESSING
  PAID
  FAILED
  EXPIRED
  REFUND_PENDING
  REFUNDED
}

enum PaymentAttemptStatus {
  CREATED
  AUTHORIZED
  CAPTURED
  FAILED
  REFUNDED
  DUPLICATE_REFUNDED
}

enum ConsultancyStatus {
  PENDING
  COMPLETED
  REFUNDED
}
```

### Prisma Models
```prisma
model Payment {
  id                   String            @id @default(uuid())
  userId               String
  callType             ConsultancyCallType
  duration             Int
  phoneNumber          String
  email                String
  amount               Int               // in paise (e.g., 49900 = ₹499.00)
  currency             String            @default("INR")
  status               PaymentStatus     @default(CREATED)
  razorpayOrderId      String            @unique
  consultancyRequestId String?           @unique
  paidAt               DateTime?
  expiresAt            DateTime
  refundEligibleAt     DateTime?
  refundId             String?
  refundedAt           DateTime?
  refundReason         String?
  refundedById         String?
  refundedByType       String?
  failureReason        String?
  createdAt            DateTime          @default(now())
  updatedAt            DateTime          @updatedAt

  user                 User              @relation(fields: [userId], references: [id], onDelete: Cascade)
  consultancyRequest   ConsultancyRequest? @relation(fields: [consultancyRequestId], references: [id], onDelete: SetNull)
  attempts             PaymentAttempt[]

  @@index([userId])
  @@index([status])
  @@index([createdAt])
  @@index([refundEligibleAt])
}

model PaymentAttempt {
  id                 String               @id @default(uuid())
  paymentId          String
  razorpayPaymentId  String               @unique
  status             PaymentAttemptStatus
  amount             Int                  // in paise
  method             String?
  errorCode          String?
  errorDescription   String?
  capturedAt         DateTime?
  refundId           String?
  raw                Json?
  createdAt          DateTime             @default(now())
  updatedAt          DateTime             @updatedAt

  payment            Payment              @relation(fields: [paymentId], references: [id], onDelete: Cascade)

  @@index([paymentId])
  @@index([status])
  @@index([createdAt])
}

model PaymentWebhookEvent {
  id          String    @id @default(uuid())
  eventId     String    @unique
  event       String
  payload     Json
  processedAt DateTime?
  error       String?
  createdAt   DateTime  @default(now())

  @@index([eventId])
  @@index([createdAt])
}
```

### Updates to Existing Models
In `model ConsultancyRequest`:
```prisma
model ConsultancyRequest {
  // Existing fields remain unchanged
  id          String              @id @default(uuid())
  userId      String
  callType    ConsultancyCallType
  duration    Int
  price       Decimal             @db.Decimal(10, 2)
  phoneNumber String
  email       String
  status      ConsultancyStatus   @default(PENDING)
  completedAt DateTime?
  createdAt   DateTime            @default(now())
  updatedAt   DateTime            @updatedAt

  user        User                @relation(fields: [userId], references: [id], onDelete: Cascade)
  payment     Payment?            // Additive 1-to-1 relation

  @@index([userId])
  @@index([status])
  @@index([createdAt])
}
```
In `model User`:
```prisma
  payments    Payment[]           // Additive relation to User
```

### Additive Migration SQL (Target PostgreSQL)
```sql
-- 1. Create Enums
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'PROCESSING', 'PAID', 'FAILED', 'EXPIRED', 'REFUND_PENDING', 'REFUNDED');
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED', 'DUPLICATE_REFUNDED');
ALTER TYPE "ConsultancyStatus" ADD VALUE IF NOT EXISTS 'REFUNDED';

-- 2. Create Payment Table
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "callType" "ConsultancyCallType" NOT NULL,
    "duration" INTEGER NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "razorpayOrderId" TEXT NOT NULL,
    "consultancyRequestId" TEXT,
    "paidAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "refundEligibleAt" TIMESTAMP(3),
    "refundId" TEXT,
    "refundedAt" TIMESTAMP(3),
    "refundReason" TEXT,
    "refundedById" TEXT,
    "refundedByType" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- 3. Create PaymentAttempt Table
CREATE TABLE "PaymentAttempt" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "razorpayPaymentId" TEXT NOT NULL,
    "status" "PaymentAttemptStatus" NOT NULL,
    "amount" INTEGER NOT NULL,
    "method" TEXT,
    "errorCode" TEXT,
    "errorDescription" TEXT,
    "capturedAt" TIMESTAMP(3),
    "refundId" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- 4. Create PaymentWebhookEvent Table
CREATE TABLE "PaymentWebhookEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- 5. Indexes and Constraints
CREATE UNIQUE INDEX "Payment_razorpayOrderId_key" ON "Payment"("razorpayOrderId");
CREATE UNIQUE INDEX "Payment_consultancyRequestId_key" ON "Payment"("consultancyRequestId");
CREATE INDEX "Payment_userId_idx" ON "Payment"("userId");
CREATE INDEX "Payment_status_idx" ON "Payment"("status");
CREATE INDEX "Payment_createdAt_idx" ON "Payment"("createdAt");
CREATE INDEX "Payment_refundEligibleAt_idx" ON "Payment"("refundEligibleAt");

CREATE UNIQUE INDEX "PaymentAttempt_razorpayPaymentId_key" ON "PaymentAttempt"("razorpayPaymentId");
CREATE INDEX "PaymentAttempt_paymentId_idx" ON "PaymentAttempt"("paymentId");
CREATE INDEX "PaymentAttempt_status_idx" ON "PaymentAttempt"("status");
CREATE INDEX "PaymentAttempt_createdAt_idx" ON "PaymentAttempt"("createdAt");

CREATE UNIQUE INDEX "PaymentWebhookEvent_eventId_key" ON "PaymentWebhookEvent"("eventId");
CREATE INDEX "PaymentWebhookEvent_createdAt_idx" ON "PaymentWebhookEvent"("createdAt");

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_consultancyRequestId_fkey" FOREIGN KEY ("consultancyRequestId") REFERENCES "ConsultancyRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

---

## 3. Payment State Machine & Concurrency Strategy

```
                          ┌───────────────────────────┐
                          │          CREATED          │
                          │   (Razorpay order made)   │
                          └─────────────┬─────────────┘
                                        │
                ┌───────────────────────┼───────────────────────┐
                │ Payment Attempt Made  │                       │ Expired (TTL passed,
                ▼                       ▼                       │ no payment)
    ┌───────────────────────┐   ┌───────────────┐               ▼
    │      PROCESSING       │   │    FAILED     │   ┌───────────────────────┐
    │ (Authorized / Pending)│   │ (Failed pay)  │   │        EXPIRED        │
    └───────────┬───────────┘   └───────┬───────┘   └───────────────────────┘
                │                       │ Retry on
                ▼ Captured              │ same order
    ┌───────────────────────────────────▼───────┐
    │                   PAID                    │
    │  (Amount verified; Consultancy created)   │
    └─────────────────────┬─────────────────────┘
                          │
                          ▼ Consultancy not COMPLETED after 7 working days
    ┌───────────────────────────────────────────┐
    │              REFUND_PENDING               │
    │      (Razorpay refund API invoked)        │
    └─────────────────────┬─────────────────────┘
                          │ Webhook / sync confirms refund
                          ▼
    ┌───────────────────────────────────────────┐
    │                 REFUNDED                  │
    │ (Payment & Consultancy marked 'REFUNDED') │
    └───────────────────────────────────────────┘
```

### Concurrency & Locking Strategy
1. **Single Source of Truth:** `syncPaymentFromRazorpay({ paymentId, razorpayOrderId })` handles all state transitions for a checkout.
2. **PostgreSQL Row-Level Locking:**
   Inside an interactive Prisma transaction `prisma.$transaction(async (tx) => { ... }, { timeout: 15000 })`, we acquire an exclusive row lock on the `Payment` record:
   ```javascript
   const [payment] = await tx.$queryRaw`
     SELECT * FROM "Payment"
     WHERE "id" = ${paymentId}
     FOR UPDATE
   `;
   ```
   This guarantees that if the user's verify call, the Razorpay webhook, and a background cron job arrive simultaneously, they are executed strictly sequentially.
3. **Double-Click Race Protection on Checkout:**
   When a user requests `POST /checkout`:
   - Search for an active Payment for this `userId` where `callType` and `duration` match and `status IN ('CREATED', 'PROCESSING', 'FAILED')` and `expiresAt > now()`.
   - If found, sync with Razorpay. If already `PAID`, return `200` with `ALREADY_PAID`. If `PROCESSING`, return `409` `PAYMENT_PROCESSING`. If `CREATED`/`FAILED`, return the existing `razorpayOrderId`.
   - If not found, use a short advisory lock or insert transaction to ensure only one checkout record is created per user per package at any given second.
4. **Duplicate Captured Attempts (Multiple Payments on Same Order):**
   - If a captured attempt arrives and the Payment is not yet `PAID`, verify amount = `payment.amount`. If valid, create `ConsultancyRequest`, transition to `PAID`.
   - If a subsequent captured attempt arrives (or multiple attempts are captured concurrently), the row lock ensures the first one sets `PAID`. Every additional captured attempt is **automatically refunded via Razorpay's refund API for the full amount** and marked `DUPLICATE_REFUNDED`.
5. **Late Success on Expired Orders:**
   If a checkout expired (`EXPIRED` or past TTL) but Razorpay later returns a captured payment, we do **not** reject it: we mark `PAID` and create the `ConsultancyRequest`, as the user legitimately paid.

---

## 4. Endpoints & API Specifications

### A. User Endpoints

#### 1. `POST /api/user/consultancy/checkout`
- **Auth:** `requireAuth, requireRole('USER')`, `generalLimiter`
- **Body:**
```json
{
  "callType": "VIDEO_CALL",
  "duration": 15,
  "phoneNumber": "9876543210",
  "email": "user@example.com"
}
```
- **Responses:**
  - `201 Created` (New checkout created):
```json
{
  "success": true,
  "checkout": {
    "checkoutId": "550e8400-e29b-41d4-a716-446655440000",
    "razorpayOrderId": "order_OD1234567890",
    "amount": 49900,
    "currency": "INR",
    "keyId": "rzp_test_XXXXXXXXXXXX",
    "status": "CREATED",
    "expiresAt": "2026-10-21T13:24:44.000Z",
    "package": {
      "callType": "VIDEO_CALL",
      "duration": 15,
      "price": 499
    },
    "prefill": {
      "name": "Jane Doe",
      "email": "user@example.com",
      "contact": "9876543210"
    }
  }
}
```
  - `200 OK` (Reused existing CREATED/FAILED order to retry): Returns same payload with status `CREATED`.
  - `200 OK` (Already paid earlier):
```json
{
  "success": true,
  "code": "ALREADY_PAID",
  "message": "Payment for this package was already completed.",
  "payment": { "id": "...", "status": "PAID" },
  "consultancyRequest": { "id": "...", "status": "PENDING" }
}
```
  - `409 Conflict` (Previous payment is processing):
```json
{
  "success": false,
  "code": "PAYMENT_PROCESSING",
  "message": "Your previous payment is still being processed by the bank. Please wait — do not pay again.",
  "checkoutId": "550e8400-e29b-41d4-a716-446655440000"
}
```
  - `503 Service Unavailable`:
```json
{
  "success": false,
  "message": "Payments are not configured."
}
```

#### 2. `POST /api/user/consultancy/checkout/verify`
- **Auth:** `requireAuth, requireRole('USER')`
- **Body:**
```json
{
  "razorpay_order_id": "order_OD1234567890",
  "razorpay_payment_id": "pay_PY1234567890",
  "razorpay_signature": "9ef84a1e7d..."
}
```
- **Responses:**
  - `200 OK` (Verified and Captured):
```json
{
  "success": true,
  "status": "PAID",
  "payment": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "amount": 49900,
    "status": "PAID",
    "paidAt": "2026-10-21T13:00:00.000Z"
  },
  "consultancyRequest": {
    "id": "req-uuid-1234",
    "callType": "VIDEO_CALL",
    "duration": 15,
    "price": 499,
    "status": "PENDING",
    "createdAt": "2026-10-21T13:00:01.000Z"
  }
}
```
  - `202 Accepted` (Payment authorized/pending at bank):
```json
{
  "success": true,
  "status": "PROCESSING",
  "message": "Payment is currently processing with your bank."
}
```
  - `400 Bad Request` (Invalid HMAC signature):
```json
{
  "success": false,
  "code": "INVALID_SIGNATURE",
  "message": "Payment signature verification failed."
}
```
  - `404 Not Found`: Order not found or not owned by user.

#### 3. `GET /api/user/consultancy/checkout/:checkoutId/status`
- **Auth:** `requireAuth, requireRole('USER')`
- **Responses:**
  - `200 OK`:
```json
{
  "success": true,
  "status": "PAID",
  "payment": { "id": "...", "status": "PAID", "paidAt": "..." },
  "consultancyRequest": { "id": "...", "status": "PENDING" }
}
```

#### 4. `GET /api/user/payments`
- **Auth:** `requireAuth, requireRole('USER')`
- **Query Params:** `page=1&limit=10` (max limit 100)
- **Response `200 OK`:**
```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "status": "PAID",
      "amount": 49900,
      "amountRupees": 499,
      "currency": "INR",
      "callType": "VIDEO_CALL",
      "duration": 15,
      "razorpayOrderId": "order_OD1234567890",
      "consultancyRequestId": "req-uuid-1234",
      "paidAt": "2026-10-21T13:00:00.000Z",
      "refundEligibleAt": "2026-10-29T18:29:59.000Z",
      "refundedAt": null,
      "createdAt": "2026-10-21T12:55:00.000Z"
    }
  ],
  "pagination": { "total": 1, "page": 1, "limit": 10, "totalPages": 1 }
}
```

#### 5. Backward Compatibility on Existing User Consultancy Endpoints
- **`POST /api/user/consultancy`**:
  - If `PAYMENTS_ENABLED=true`:
    `400 Bad Request`
    ```json
    {
      "success": false,
      "code": "PAYMENT_REQUIRED",
      "message": "Please complete payment to book a consultancy. Use POST /api/user/consultancy/checkout."
    }
    ```
  - If `PAYMENTS_ENABLED=false`: Creates request without payment (existing behavior preserved).
- **`GET /api/user/consultancy` & `GET /api/user/consultancy/:id`**:
  - Include `"payment"`:
    ```json
    "payment": {
      "id": "uuid",
      "status": "PAID",
      "amount": 49900,
      "paidAt": "...",
      "refundEligibleAt": "...",
      "refundedAt": null
    }
    ```
    or `"payment": null` for legacy unpaid records.

---

### B. Webhook Endpoint

#### `POST /api/payments/razorpay/webhook`
- **Auth:** None (Public, validated via cryptographic HMAC SHA-256 signature).
- **Registration:** Mounted in `src/server.js` **before** `app.use(express.json())` with `express.raw({ type: 'application/json' })`.
- **Headers:** `x-razorpay-signature`, `x-razorpay-event-id`.
- **Responses:**
  - `200 OK`: `{ "received": true }` (always returned quickly for legitimate deliveries).
  - `400 Bad Request`: `{ "success": false, "message": "Invalid webhook signature." }`

---

### C. Admin Endpoints

#### 1. `GET /api/admin/payments`
- **Auth:** `requireAuth, requirePermission('payments:view')`
- **Query Params:** `status`, `refundEligible=true`, `search`, `from`, `to`, `page`, `limit` (max 100)
- **Response `200 OK`:**
```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "status": "PAID",
      "amount": 49900,
      "currency": "INR",
      "callType": "VIDEO_CALL",
      "duration": 15,
      "razorpayOrderId": "order_OD1234567890",
      "paidAt": "2026-10-21T13:00:00.000Z",
      "refundEligibleAt": "2026-10-29T18:29:59.000Z",
      "isRefundEligible": false,
      "user": {
        "id": "user-uuid",
        "fullName": "Jane Doe",
        "email": "user@example.com",
        "phone": "9876543210"
      },
      "consultancy": {
        "id": "req-uuid-1234",
        "status": "PENDING"
      },
      "attemptsSummary": {
        "total": 1,
        "captured": 1,
        "failed": 0
      }
    }
  ],
  "counts": {
    "ALL": 15,
    "CREATED": 2,
    "PROCESSING": 1,
    "PAID": 10,
    "FAILED": 1,
    "EXPIRED": 0,
    "REFUND_PENDING": 0,
    "REFUNDED": 1
  },
  "pagination": { "total": 15, "page": 1, "limit": 10, "totalPages": 2 }
}
```

#### 2. `GET /api/admin/payments/:id`
- **Auth:** `requireAuth, requirePermission('payments:view')`
- **Response `200 OK`:** Full payment details with attempts, user profile, consultancy request, and related webhook audit events.

#### 3. `POST /api/admin/payments/:id/refund`
- **Auth:** `requireAuth, requirePermission('payments:refund')`
- **Body:**
```json
{
  "reason": "Call not scheduled within 7 working days SLA",
  "force": false
}
```
- **Rules:**
  - Payment must be `PAID`.
  - Consultancy request must NOT be `COMPLETED`.
  - Current time must be `>= refundEligibleAt`.
  - If current time is `< refundEligibleAt`, only the **Main Admin** (`req.user.type === 'admin'`) can supply `"force": true`. Staff cannot force refunds (`400 Bad Request`).
  - If already `REFUND_PENDING` or `REFUNDED`: returns `409 Conflict`.
- **Response `200 OK`:**
```json
{
  "success": true,
  "message": "Refund initiated successfully",
  "payment": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "REFUND_PENDING",
    "refundReason": "Call not scheduled within 7 working days SLA"
  }
}
```

#### 4. Updates to Existing Admin Consultancy Endpoints
- **`PATCH /api/admin/consultancy/:id/status`**:
  If the consultancy request's payment status is `REFUND_PENDING` or `REFUNDED`, reject with `400 Bad Request`: `"Cannot complete a consultancy request that has been refunded or has a refund pending."`
- **`GET /api/admin/consultancy`**:
  Include `payment` object for each item.

---

### D. Internal Cron Endpoints

#### 1. `GET /api/internal/cron/payments-reconcile`
- **Headers:** `Authorization: Bearer <CRON_SECRET>` (Vercel standard)
- **Response `200 OK`:**
```json
{
  "success": true,
  "reconciledCount": 3,
  "expiredCount": 2,
  "errors": []
}
```

#### 2. `GET /api/internal/cron/refund-eligibility`
- **Headers:** `Authorization: Bearer <CRON_SECRET>`
- **Response `200 OK`:**
```json
{
  "success": true,
  "eligiblePaymentsFound": 2,
  "autoRefundsExecuted": 0,
  "autoRefundEnabled": false
}
```

---

## 5. Working Days Refund Calculation

### Pure Helper: `src/utils/workingDays.js`
`addWorkingDays(date, n, { weekdays, holidays, timeZone })`
- **Timezone:** Defaults to `Asia/Kolkata`.
- **Rule:** Count working days starting from the **day after** payment.
  - Non-working weekdays (e.g. Sunday = 0) and listed dates in `COMPANY_HOLIDAYS` (e.g. `2026-10-24`) are skipped.
  - Return the end of the N-th working day (23:59:59.999 IST, converted to UTC ISO).
- Example:
  - Paid Friday at 15:00 IST with Mon-Sat working:
    - Day 1: Saturday
    - Sunday skipped
    - Day 2: Monday
    - ...
    - Day 7: Saturday end of day (23:59:59 IST).

---

## 6. Vercel Cron Setup & Plan Limitations

### `vercel.json` Crons Definition
```json
{
  "version": 2,
  "functions": {
    "api/index.js": {
      "includeFiles": "uploads/**"
    }
  },
  "crons": [
    {
      "path": "/api/internal/cron/payments-reconcile",
      "schedule": "*/15 * * * *"
    },
    {
      "path": "/api/internal/cron/refund-eligibility",
      "schedule": "0 2 * * *"
    }
  ],
  "rewrites": [
    {
      "source": "/(.*)",
      "destination": "/api/index.js"
    }
  ]
}
```

### Vercel Plan Assessment:
- **Vercel Pro:** Supports sub-daily crons like `*/15 * * * *`.
- **Vercel Hobby:** Vercel enforces a limit of **at most once per day** per cron job (`0 * * * *` or sub-daily expressions will fail deployment or only run once a day).
- **Alternative/Fallback Strategy:**
  If the deployment is on Vercel Hobby:
  - Configure `/api/internal/cron/refund-eligibility` to run daily in `vercel.json` (`0 2 * * *`).
  - For the 15-minute `payments-reconcile`, recommend using a free external monitor/cron (e.g., cron-job.org or GitHub Actions schedule) making an authenticated `GET` request with header `Authorization: Bearer <CRON_SECRET>`.

---

## 7. Environment Variables

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `RAZORPAY_KEY_ID` | — | Yes (when payments enabled) | Razorpay public key ID |
| `RAZORPAY_KEY_SECRET` | — | Yes (when payments enabled) | Razorpay secret for checkout verification |
| `RAZORPAY_WEBHOOK_SECRET` | — | Yes (when payments enabled) | Secret for webhook HMAC validation |
| `PAYMENTS_ENABLED` | `false` | No | Flag to toggle payment enforcement |
| `PAYMENT_CHECKOUT_TTL_MINUTES` | `30` | No | Order expiry window in minutes |
| `REFUND_WORKING_DAYS` | `7` | No | SLA days before payment becomes refund-eligible |
| `COMPANY_WORKING_WEEKDAYS` | `1,2,3,4,5,6` | No | Working days (Mon-Sat = 1..6, Sun = 0) |
| `COMPANY_HOLIDAYS` | `""` | No | Comma-separated `YYYY-MM-DD` public holidays |
| `AUTO_REFUND_ENABLED` | `false` | No | If true, cron automatically executes refunds |
| `CRON_SECRET` | — | Yes (for cron calls) | Bearer token authenticating Vercel crons |
| `PAYMENT_TIMEZONE` | `Asia/Kolkata` | No | Timezone for day boundaries |

---

## 8. Risks & Mitigations

1. **Express Body Parser Conflict:**
   - *Risk:* `express.json()` consumes the stream, destroying raw body bytes needed for HMAC verification.
   - *Mitigation:* Mount `/api/payments/razorpay/webhook` using `express.raw({ type: 'application/json' })` **before** `app.use(express.json())`.
2. **Duplicate/Concurrent Webhooks:**
   - *Risk:* Razorpay sends parallel webhooks or retries while verify API is executing.
   - *Mitigation:* Webhook event deduplication table `PaymentWebhookEvent` with unique `eventId`. State sync enclosed within `SELECT ... FOR UPDATE` database transaction.
3. **Double Payment by User:**
   - *Risk:* User opens two tabs or double-clicks Pay.
   - *Mitigation:* Reusing active orders in `CREATED`/`PROCESSING`/`FAILED` states; locking during sync; automatic full refund for any duplicate captured attempts.
4. **Secrets Exposure:**
   - *Risk:* Leaking `RAZORPAY_KEY_SECRET` in logs or frontend responses.
   - *Mitigation:* Strictly return only `keyId` to client; keep secrets confined to backend environment variables; never include secrets in `console.error` or `ErrorLog`.
5. **Timezone Calculation Offsets:**
   - *Risk:* Calculating 7 working days in UTC rather than IST (Asia/Kolkata), resulting in premature or delayed refund eligibility.
   - *Mitigation:* Pure date helper with explicit timezone calculation anchoring day boundaries at 23:59:59.999 IST.

---

## 9. Answers to OPEN QUESTIONS

1. **Working days:**
   - *Recommendation:* Keep **Mon–Sat (default: `1,2,3,4,5,6`)** as legal services in India typically operate 6 days a week. Keep holidays configurable via env `COMPANY_HOLIDAYS` (comma-separated `YYYY-MM-DD`). This avoids table bloat and allows easy zero-downtime updates.
2. **Refund execution:**
   - *Recommendation:* Keep **Admin manual approval (default: `AUTO_REFUND_ENABLED=false`)**. In legal consultancy, a lawyer might have contacted the client offline or rescheduled with client consent. The admin should review the status and execute the refund unless company policy strictly mandates automated SLAs.
3. **User refund request:**
   - *Recommendation:* **Only admin acts.** The user sees their refund eligibility status and date in their dashboard history ("Eligible for refund since ..."). The actual refund trigger remains controlled by admin.
4. **Notifications:**
   - *Recommendation:* **Yes, send emails on payment success and refund processed** using the existing `email.service.js` if configured (`EMAIL_USER` is set). If sending fails or email is unconfigured in development, log the event and fail silently without rolling back the financial transaction.
5. **Receipt/invoice:**
   - *Recommendation:* **Yes, a clean receipt object in the API response is sufficient for v1.** PDF generation or GST invoice numbering can be added in a future enhancement.
6. **Checkout TTL:**
   - *Recommendation:* **Yes, 30 minutes (`PAYMENT_CHECKOUT_TTL_MINUTES=30`) is ideal.** It gives users adequate time to complete multi-step UPI/NetBanking authentication while preventing stale pending checkouts from accumulating indefinitely.

---
**Status:** Awaiting user approval. Migration, seeding, and implementation will not commence until "approved" is received.
