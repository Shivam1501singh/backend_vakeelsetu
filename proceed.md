# Implementation Plan: Advocate (Lawyer) Booking System

This document outlines the architectural plan and specifications for implementing **Advocate Booking** in VakeelSetu backend. In this flow, a user selects an available time slot with an approved advocate, pays upfront via Razorpay, and upon confirmation, the advocate receives the appointment in "My Appointments" with contact details to call the user.

---

## 1. Current Behaviour Analysis

### 1.1 Existing Payment & Razorpay Architecture
- **Models:**
  - `Payment`: Currently tightly coupled to `ConsultancyRequest` (`callType: ConsultancyCallType`, `duration: Int`, `consultancyRequestId: String? @unique`). Amount is stored as an integer in paise.
  - `PaymentAttempt`: Stores gateway attempts (`razorpayPaymentId`, `status: PaymentAttemptStatus`, `amount`, `method`, `capturedAt`, `raw`).
  - `PaymentWebhookEvent`: Stores deduplicated webhook events (`eventId`, `event`, `payload`, `processedAt`).
- **Core State Machine (`src/services/payment.service.js` -> `syncPaymentFromRazorpay`):**
  - Idempotent and thread-safe via PostgreSQL row-level locking (`SELECT * FROM "Payment" WHERE "id" = $1 FOR UPDATE`).
  - If captured and amount matches:
    - Generates unique `bookingId` using `createConsultancyWithUniqueBookingId` (`VSB-...`).
    - Creates `ConsultancyRequest` with status `PENDING`.
    - Updates `Payment` to `PAID` with `paidAt` and `refundEligibleAt` (7 working days).
  - Handles duplicate captured attempts by refunding extras (`DUPLICATE_REFUNDED`).
  - Handles authorized but uncaptured attempts by calling Razorpay capture.
  - Sets `EXPIRED` if order has no attempts and `now > expiresAt`.
- **Checkout Controller (`src/controllers/payment.controller.js`):**
  - `createCheckout`: Finds reusable active payment (`status in ['CREATED', 'PROCESSING', 'FAILED']` and `expiresAt > now`). If already paid -> returns `ALREADY_PAID`. If processing -> returns `409 PAYMENT_PROCESSING`. Otherwise reuses order or creates new Razorpay order.
  - `verifyCheckout`: Validates HMAC SHA256 signature using `verifyCheckoutSignature` and calls `syncPaymentFromRazorpay`.
  - `getCheckoutStatus`: Throttled polling (10s) syncing status with Razorpay.
- **Webhook & Cron:**
  - `handleRazorpayWebhook`: Handles `payment.captured`, `payment.authorized`, `order.paid`, `refund.processed`.
  - `reconcilePaymentsCron`: Reconciles pending payments older than 2 minutes and expires stale checkouts.

### 1.2 "My Bookings" (`src/services/myBookings.service.js`)
- Currently only exposes `ConsultancyRequest` records merged with pending `Payment` records having status `PROCESSING` or `CREATED` with attempts.
- Normalizes records to `{ id, bookingId, title, callStatus, status, statusGroup, statusLabel, callType, durationMinutes, price, contact, payment, actions }`.
- Filtered by `statusGroup` (`ALL`, `UPCOMING`, `PROCESSING`, `COMPLETED`, `REFUNDED`).

### 1.3 Advocate Profile & Availability
- `Advocate` schema stores rates:
  - `voiceCallChargePerMinute` (Decimal?)
  - `videoCallChargePerMinute` (Decimal?)
  - `offlineVisitingFee` (Decimal?)
- Status flags:
  - `isActive`: Boolean
  - `status`: AdvocateStatus (`ACTIVE`, `BLOCKED`)
  - `approvalStatus`: AdvocateApprovalStatus (`PENDING`, `APPROVED`, `REJECTED`)
  - `deletionStatus`: AdvocateDeletionStatus (`NONE`, `PENDING`)
  - `callAvailability`: Boolean (used solely for immediate live calling in other modules; **must NOT** block advance scheduled slot bookings).

### 1.4 RBAC System
- Roles and permissions in `prisma/schema.prisma` (`Role`, `Permission`, `RolePermission`, `UserRole`).
- Seed script: `prisma/seedRbac.js`.
- Middleware: `requirePermission('permission:code')` and `requireRole('ROLE')`.

---

## 2. Final Database Design

### 2.1 Enums

```prisma
enum AdvocateBookingMode {
  VOICE_CALL
  VIDEO_CALL
  IN_PERSON
}

enum AdvocateBookingStatus {
  HOLD
  CONFIRMED
  COMPLETED
  EXPIRED
  REFUND_PENDING
  REFUNDED
}

enum PaymentPurpose {
  CONSULTANCY
  ADVOCATE_BOOKING
}
```

### 2.2 New Model `AdvocateBooking`

```prisma
model AdvocateBooking {
  id                   String                @id @default(uuid())
  bookingId            String?               @unique
  userId               String
  advocateId           String
  mode                 AdvocateBookingMode
  startAt              DateTime
  endAt                DateTime
  durationMinutes      Int
  subject              String

  // Price snapshot (in integer paise)
  ratePerMinutePaise   Int?                  // null for IN_PERSON
  feePaise             Int
  gstPercent           Int
  gstPaise             Int
  platformFeePaise     Int
  totalPaise           Int
  currency             String                @default("INR")

  // Contact snapshot taken at the time of booking
  userName             String
  userPhone            String
  userEmail            String
  advocateName         String

  // Lifecycle status
  status               AdvocateBookingStatus @default(HOLD)
  holdExpiresAt        DateTime
  confirmedAt          DateTime?
  completedAt          DateTime?
  refundedAt           DateTime?
  refundReason         String?

  createdAt            DateTime              @default(now())
  updatedAt            DateTime              @updatedAt

  // Relationships
  user                 User                  @relation(fields: [userId], references: [id], onDelete: Restrict)
  advocate             Advocate              @relation(fields: [advocateId], references: [id], onDelete: Restrict)
  payment              Payment?

  @@index([advocateId, startAt])
  @@index([userId, createdAt])
  @@index([status])
  @@index([startAt])
}
```

#### Cascade Rule Rationale (`onDelete: Restrict`)
- `AdvocateBooking` records represent legally binding appointments and financial transactions.
- Silently wiping booking records if a `User` or `Advocate` account is deleted would destroy audit trails and violate financial retention compliance.
- Therefore, foreign keys use `Restrict`. When users or advocates request account deletion, the system retains the booking history or marks accounts as soft-deleted / scheduled for deletion without deleting transaction rows.

### 2.3 Additive Extension to `Payment`

```prisma
model Payment {
  id                   String              @id @default(uuid())
  purpose              PaymentPurpose      @default(CONSULTANCY)
  userId               String
  callType             ConsultancyCallType?  // Made optional for ADVOCATE_BOOKING
  duration             Int?                  // Made optional for ADVOCATE_BOOKING
  phoneNumber          String
  email                String
  amount               Int                 // in paise
  currency             String              @default("INR")
  status               PaymentStatus       @default(CREATED)
  razorpayOrderId      String              @unique
  consultancyRequestId String?             @unique
  advocateBookingId    String?             @unique // Added for ADVOCATE_BOOKING
  paidAt               DateTime?
  expiresAt            DateTime
  refundEligibleAt     DateTime?
  refundId             String?
  refundedAt           DateTime?
  refundReason         String?
  refundedById         String?
  refundedByType       String?
  failureReason        String?
  createdAt            DateTime            @default(now())
  updatedAt            DateTime            @updatedAt

  user                 User                @relation(fields: [userId], references: [id], onDelete: Cascade)
  consultancyRequest   ConsultancyRequest? @relation(fields: [consultancyRequestId], references: [id], onDelete: SetNull)
  advocateBooking      AdvocateBooking?    @relation(fields: [advocateBookingId], references: [id], onDelete: SetNull)
  attempts             PaymentAttempt[]

  @@index([userId])
  @@index([status])
  @@index([createdAt])
  @@index([refundEligibleAt])
  @@index([purpose])
}
```

### 2.4 Proposed Migration SQL

Following README Section 31, the migration script will be placed under `prisma/migrations/<timestamp>_add_advocate_booking/migration.sql`.

```sql
-- 1. Create Enums
DO $$ BEGIN
    CREATE TYPE "AdvocateBookingMode" AS ENUM ('VOICE_CALL', 'VIDEO_CALL', 'IN_PERSON');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "AdvocateBookingStatus" AS ENUM ('HOLD', 'CONFIRMED', 'COMPLETED', 'EXPIRED', 'REFUND_PENDING', 'REFUNDED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "PaymentPurpose" AS ENUM ('CONSULTANCY', 'ADVOCATE_BOOKING');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Create Table AdvocateBooking
CREATE TABLE IF NOT EXISTS "AdvocateBooking" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT,
    "userId" TEXT NOT NULL,
    "advocateId" TEXT NOT NULL,
    "mode" "AdvocateBookingMode" NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "ratePerMinutePaise" INTEGER,
    "feePaise" INTEGER NOT NULL,
    "gstPercent" INTEGER NOT NULL,
    "gstPaise" INTEGER NOT NULL,
    "platformFeePaise" INTEGER NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "userName" TEXT NOT NULL,
    "userPhone" TEXT NOT NULL,
    "userEmail" TEXT NOT NULL,
    "advocateName" TEXT NOT NULL,
    "status" "AdvocateBookingStatus" NOT NULL DEFAULT 'HOLD',
    "holdExpiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "refundReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdvocateBooking_pkey" PRIMARY KEY ("id")
);

-- 3. Alter Table Payment (Additive & Non-destructive)
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "purpose" "PaymentPurpose" NOT NULL DEFAULT 'CONSULTANCY';
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "advocateBookingId" TEXT;
ALTER TABLE "Payment" ALTER COLUMN "callType" DROP NOT NULL;
ALTER TABLE "Payment" ALTER COLUMN "duration" DROP NOT NULL;

-- 4. Create Indexes
CREATE UNIQUE INDEX IF NOT EXISTS "AdvocateBooking_bookingId_key" ON "AdvocateBooking"("bookingId");
CREATE INDEX IF NOT EXISTS "AdvocateBooking_advocateId_startAt_idx" ON "AdvocateBooking"("advocateId", "startAt");
CREATE INDEX IF NOT EXISTS "AdvocateBooking_userId_createdAt_idx" ON "AdvocateBooking"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "AdvocateBooking_status_idx" ON "AdvocateBooking"("status");
CREATE INDEX IF NOT EXISTS "AdvocateBooking_startAt_idx" ON "AdvocateBooking"("startAt");

CREATE UNIQUE INDEX IF NOT EXISTS "Payment_advocateBookingId_key" ON "Payment"("advocateBookingId");
CREATE INDEX IF NOT EXISTS "Payment_purpose_idx" ON "Payment"("purpose");

-- 5. Foreign Key Constraints
DO $$ BEGIN
    ALTER TABLE "AdvocateBooking" ADD CONSTRAINT "AdvocateBooking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "AdvocateBooking" ADD CONSTRAINT "AdvocateBooking_advocateId_fkey" FOREIGN KEY ("advocateId") REFERENCES "Advocate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "Payment" ADD CONSTRAINT "Payment_advocateBookingId_fkey" FOREIGN KEY ("advocateBookingId") REFERENCES "AdvocateBooking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 6. PostgreSQL Double-Booking Exclusion Constraint (Requires btree_gist)
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$ BEGIN
    ALTER TABLE "AdvocateBooking" ADD CONSTRAINT "advocate_booking_no_overlap"
      EXCLUDE USING gist ("advocateId" WITH =, tstzrange("startAt", "endAt", '[)') WITH &&)
      WHERE ("status" IN ('CONFIRMED', 'COMPLETED', 'REFUND_PENDING'));
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
```

---

## 3. Double-Booking Prevention & Overlap Strategy

Double booking is prevented using a multi-layer strategy:

### Layer 1: Application-Level Overlap Check (`isSlotFree`)
- Used by public quote, checkout, and pre-payment confirmation.
- Queries `AdvocateBooking` for the given `advocateId` where:
  - `startAt < requestedEndAt` AND `endAt > requestedStartAt`
  - AND status is in `['CONFIRMED', 'COMPLETED', 'REFUND_PENDING']` OR (`status = 'HOLD'` AND `holdExpiresAt > now`).
- Expired `HOLD` records (`holdExpiresAt <= now`) are lazily ignored and treated as free.
- Also validates `USER_SLOT_CONFLICT`: ensures the same user does not already hold or have a confirmed slot overlapping the requested time window across any advocate.

### Layer 2: Transaction Row Locking
- When creating a checkout `HOLD` or confirming on payment, execute:
  ```sql
  SELECT id FROM "Advocate" WHERE id = $1 FOR UPDATE
  ```
- This serializes concurrent checkout requests for the same advocate in PostgreSQL.

### Layer 3: Database Exclusion Constraint
- The PostgreSQL `advocate_booking_no_overlap` exclusion constraint operates on `tstzrange("startAt", "endAt", '[)')`.
- Even if two concurrent requests somehow bypass application locks, the database engine enforces physical serialization at commit time and raises error `23P01 (exclusion_violation)`.

---

## 4. How Payment Machinery is Reused

The existing Razorpay state machine is reused 100% without creating a second webhook or payment flow.

```
+-----------------------------------------------------------------------------------------+
|                                    Razorpay Gateway                                     |
+-----------------------------------------------------------------------------------------+
         |                                |                                   |
         v                                v                                   v
+------------------+             +------------------+                +------------------+
| Verify Endpoint  |             | Webhook Endpoint |                |   Cron Reconcile |
| (/checkout/verify|             | (/payments/      |                |  (/payments-     |
|                  |             |  razorpay/webhook|                |   reconcile)     |
+------------------+             +------------------+                +------------------+
         |                                |                                   |
         +--------------------------------+-----------------------------------+
                                          |
                                          v
                    +------------------------------------------+
                    |  syncPaymentFromRazorpay(paymentId)      |
                    |  - Row-level lock: Payment FOR UPDATE   |
                    |  - Fetch attempts from Razorpay          |
                    |  - Branch on payment.purpose             |
                    +------------------------------------------+
                                          |
                +-------------------------+-------------------------+
                |                                                   |
                v                                                   v
      [purpose: CONSULTANCY]                            [purpose: ADVOCATE_BOOKING]
   (Existing behavior unchanged)                  - Re-check overlap (excluding current booking)
                                                  - If slot free:
                                                      * Generate bookingId (VLB-...)
                                                      * AdvocateBooking -> CONFIRMED, confirmedAt
                                                      * Payment -> PAID
                                                  - If slot taken (late payment after expiry):
                                                      * AdvocateBooking -> REFUND_PENDING
                                                      * Reason: SLOT_CONFLICT_AFTER_EXPIRY
                                                      * Auto-refund attempt via Razorpay
                                                  - If failed/expired:
                                                      * AdvocateBooking -> EXPIRED
```

### Key Reuse Rules:
1. **Single Webhook:** `handleRazorpayWebhook` already processes events by fetching `order_id` or `payment_id` and calling `syncPaymentFromRazorpay`. For `refund.processed`, it updates both `consultancyRequest` and `advocateBooking`.
2. **Single Cron:** `reconcilePaymentsCron` selects pending payments older than 2 minutes and calls `syncPaymentFromRazorpay`. Stale `CREATED` checkouts are updated to `EXPIRED`, which automatically expires the linked `AdvocateBooking`.
3. **Refund Endpoint:** `POST /api/admin/payments/:id/refund` checks `payment.purpose`. If `ADVOCATE_BOOKING`, the 7-day rule is skipped:
   - If booking is `CONFIRMED`, refund is allowed immediately.
   - If booking is `COMPLETED`, only Main Admin with `force: true` is allowed.
   - Updates `AdvocateBooking.status` to `REFUND_PENDING` (and `REFUNDED` if processed immediately).

---

## 5. Pricing, Duration & Subjects Service

### 5.1 Service Location: `src/services/advocateBooking/pricing.js`

- **Rules:**
  - `VOICE_CALL`: Slot = `ADVOCATE_BOOKING_SLOT_MINUTES` (default 15 min). Rate = `advocate.voiceCallChargePerMinute`. Fee = `Math.round(rate * 15)`.
  - `VIDEO_CALL`: Slot = `ADVOCATE_BOOKING_SLOT_MINUTES` (default 15 min). Rate = `advocate.videoCallChargePerMinute`. Fee = `Math.round(rate * 15)`.
  - `IN_PERSON`: Slot = `ADVOCATE_IN_PERSON_MINUTES` (default 60 min). Flat Fee = `advocate.offlineVisitingFee`.
  - GST = `Math.round(feePaise * BOOKING_GST_PERCENT / 100)`. (18% on fee only).
  - Platform Fee = `BOOKING_PLATFORM_FEE * 100` paise (₹25 flat, no GST).
  - Total = `feePaise + gstPaise + platformFeePaise`.
  - A mode is bookable only if rate/fee > 0.

- **Example Calculation:**
  - Voice Call at ₹34.00/min:
    - `feePaise` = $34 \times 15 \times 100 = 51000$ (₹510.00)
    - `gstPaise` = $\text{Math.round}(51000 \times 18 / 100) = 9180$ (₹91.80)
    - `platformFeePaise` = 2500 (₹25.00)
    - `totalPaise` = $51000 + 9180 + 2500 = 62680$ (₹626.80)

- **Advocate Bookable Verification:**
  - An advocate is bookable if and only if:
    `isActive === true` AND `status === 'ACTIVE'` AND `approvalStatus === 'APPROVED'` AND `deletionStatus !== 'PENDING'`.
  - **`callAvailability` is NOT checked** for scheduled bookings.

- **Standard Subject List:**
  ```javascript
  export const ADVOCATE_BOOKING_SUBJECTS = [
    'Criminal Defence',
    'Corporate',
    'Family',
    'Personal Injury',
    'Employment',
    'IP Rights',
    'Real Estate',
    'Tax',
    'Immigration',
    'Civil Litigation',
    'Other'
  ];
  ```

---

## 6. Endpoints & API Specifications

### Public & User Endpoints

#### 1. `GET /api/advocates/:advocateId/booking-options`
- **Auth:** Optional (`optionalAuth`)
- **Query:** None
- **Response `200 OK`:**
  ```json
  {
    "success": true,
    "advocate": {
      "id": "c6a1e3a4-8461-460d-a3df-20ce4b9685a1",
      "fullName": "Adv. Rajesh Sharma",
      "profilePhotoUrl": "https://res.cloudinary.com/...",
      "bestPracticeArea": "Criminal Litigation"
    },
    "bookable": true,
    "modes": [
      {
        "mode": "VOICE_CALL",
        "label": "Voice Call",
        "durationMinutes": 15,
        "ratePerMinute": 34,
        "ratePerMinutePaise": 3400,
        "fee": 510,
        "feePaise": 51000,
        "gst": 91.8,
        "gstPercent": 18,
        "gstPaise": 9180,
        "platformFee": 25,
        "platformFeePaise": 2500,
        "total": 626.8,
        "totalPaise": 62680
      },
      {
        "mode": "VIDEO_CALL",
        "label": "Video Call",
        "durationMinutes": 15,
        "ratePerMinute": 50,
        "ratePerMinutePaise": 5000,
        "fee": 750,
        "feePaise": 75000,
        "gst": 135,
        "gstPercent": 18,
        "gstPaise": 13500,
        "platformFee": 25,
        "platformFeePaise": 2500,
        "total": 910,
        "totalPaise": 91000
      },
      {
        "mode": "IN_PERSON",
        "label": "In-Person Meeting",
        "durationMinutes": 60,
        "ratePerMinute": null,
        "ratePerMinutePaise": null,
        "fee": 2500,
        "feePaise": 250000,
        "gst": 450,
        "gstPercent": 18,
        "gstPaise": 45000,
        "platformFee": 25,
        "platformFeePaise": 2500,
        "total": 2975,
        "totalPaise": 297500
      }
    ],
    "subjects": [
      "Criminal Defence",
      "Corporate",
      "Family",
      "Personal Injury",
      "Employment",
      "IP Rights",
      "Real Estate",
      "Tax",
      "Immigration",
      "Civil Litigation",
      "Other"
    ],
    "slotMinutes": 15,
    "inPersonMinutes": 60,
    "minLeadMinutes": 30,
    "maxDaysAhead": 30,
    "timezone": "Asia/Kolkata"
  }
  ```

#### 2. `GET /api/advocates/:advocateId/busy-slots?date=YYYY-MM-DD`
- **Auth:** Public
- **Query:** `date` (YYYY-MM-DD)
- **Response `200 OK`:**
  ```json
  {
    "success": true,
    "date": "2026-10-25",
    "timezone": "Asia/Kolkata",
    "busy": [
      {
        "startAt": "2026-10-25T05:30:00.000Z",
        "endAt": "2026-10-25T05:45:00.000Z"
      },
      {
        "startAt": "2026-10-25T09:00:00.000Z",
        "endAt": "2026-10-25T10:00:00.000Z"
      }
    ]
  }
  ```

#### 3. `POST /api/advocates/:advocateId/booking-quote`
- **Auth:** Required (`USER`)
- **Body:**
  ```json
  {
    "mode": "VOICE_CALL",
    "startAt": "2026-10-25T11:00:00.000Z"
  }
  ```
- **Response `200 OK`:**
  ```json
  {
    "success": true,
    "available": true,
    "startAt": "2026-10-25T11:00:00.000Z",
    "endAt": "2026-10-25T11:15:00.000Z",
    "durationMinutes": 15,
    "mode": "VOICE_CALL",
    "breakdown": {
      "ratePerMinute": 34,
      "ratePerMinutePaise": 3400,
      "fee": 510,
      "feePaise": 51000,
      "gst": 91.8,
      "gstPercent": 18,
      "gstPaise": 9180,
      "platformFee": 25,
      "platformFeePaise": 2500,
      "total": 626.8,
      "totalPaise": 62680
    }
  }
  ```
- **Error `409 Conflict` (Slot Taken):**
  ```json
  {
    "success": false,
    "code": "SLOT_TAKEN",
    "message": "The selected time slot is no longer available. Please select another time."
  }
  ```

#### 4. `POST /api/user/advocate-bookings/checkout`
- **Auth:** Required (`USER`), rate-limited
- **Body:**
  ```json
  {
    "advocateId": "c6a1e3a4-8461-460d-a3df-20ce4b9685a1",
    "mode": "VOICE_CALL",
    "startAt": "2026-10-25T11:00:00.000Z",
    "subject": "Criminal Defence"
  }
  ```
- **Response `201 Created`:**
  ```json
  {
    "success": true,
    "checkout": {
      "checkoutId": "f78d8f99-281b-4191-8848-eaefda142cb1",
      "razorpayOrderId": "order_Q8dKn9K2sLa",
      "amount": 62680,
      "currency": "INR",
      "keyId": "rzp_test_...",
      "status": "CREATED",
      "expiresAt": "2026-10-24T15:10:00.000Z",
      "booking": {
        "id": "e81d7398-319b-4322-bfa1-d419a71b8e19",
        "mode": "VOICE_CALL",
        "startAt": "2026-10-25T11:00:00.000Z",
        "endAt": "2026-10-25T11:15:00.000Z",
        "durationMinutes": 15,
        "subject": "Criminal Defence",
        "breakdown": {
          "fee": 510,
          "feePaise": 51000,
          "gst": 91.8,
          "gstPercent": 18,
          "gstPaise": 9180,
          "platformFee": 25,
          "platformFeePaise": 2500,
          "total": 626.8,
          "totalPaise": 62680
        }
      },
      "prefill": {
        "name": "Rahul Verma",
        "email": "client.rahul@example.com",
        "contact": "9876543210"
      }
    }
  }
  ```

#### 5. `POST /api/user/advocate-bookings/checkout/verify`
- **Auth:** Required (`USER`)
- **Body:**
  ```json
  {
    "razorpay_order_id": "order_Q8dKn9K2sLa",
    "razorpay_payment_id": "pay_Q8dMwP931l",
    "razorpay_signature": "abcdef123456..."
  }
  ```
- **Response `200 OK`:**
  ```json
  {
    "success": true,
    "status": "PAID",
    "booking": {
      "id": "e81d7398-319b-4322-bfa1-d419a71b8e19",
      "bookingId": "VLB-2026JK8M2NP",
      "status": "CONFIRMED",
      "confirmedAt": "2026-10-24T15:02:10.000Z"
    }
  }
  ```

#### 6. `GET /api/user/advocate-bookings/checkout/:checkoutId/status`
- **Auth:** Required (`USER`)
- **Response `200 OK`:**
  ```json
  {
    "success": true,
    "status": "PAID",
    "payment": {
      "id": "f78d8f99-281b-4191-8848-eaefda142cb1",
      "status": "PAID",
      "amount": 62680,
      "amountRupees": 626.8
    },
    "booking": {
      "id": "e81d7398-319b-4322-bfa1-d419a71b8e19",
      "bookingId": "VLB-2026JK8M2NP",
      "status": "CONFIRMED"
    }
  }
  ```

---

### Advocate Endpoints ("My Appointments")

#### 7. `GET /api/advocate/appointments`
- **Auth:** Required (`requireAuth`, `requireRole('ADVOCATE')`)
- **Query:**
  - `status`: `UPCOMING` (default) | `PAST_DUE` | `COMPLETED` | `REFUNDED` | `ALL`
  - `date`: `YYYY-MM-DD` (optional filter)
  - `page`: default 1
  - `limit`: default 10 (max 50)
- **Response `200 OK`:**
  ```json
  {
    "success": true,
    "appointments": [
      {
        "id": "e81d7398-319b-4322-bfa1-d419a71b8e19",
        "bookingId": "VLB-2026JK8M2NP",
        "mode": "VOICE_CALL",
        "startAt": "2026-10-25T11:00:00.000Z",
        "endAt": "2026-10-25T11:15:00.000Z",
        "durationMinutes": 15,
        "subject": "Criminal Defence",
        "status": "CONFIRMED",
        "user": {
          "name": "Rahul Verma",
          "phone": "9876543210",
          "email": "client.rahul@example.com"
        },
        "fee": 510,
        "feePaise": 51000,
        "confirmedAt": "2026-10-24T15:02:10.000Z",
        "completedAt": null,
        "message": "This user has booked you. Please call the user at the booked time."
      }
    ],
    "counts": {
      "ALL": 12,
      "UPCOMING": 4,
      "PAST_DUE": 1,
      "COMPLETED": 6,
      "REFUNDED": 1
    },
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 4,
      "totalPages": 1
    }
  }
  ```

#### 8. `GET /api/advocate/appointments/:id`
- **Auth:** Required (`ADVOCATE` - owner only)
- **Response `200 OK`:** Single appointment object with full timeline and contact details.

#### 9. `PATCH /api/advocate/appointments/:id/complete`
- **Auth:** Required (`ADVOCATE` - owner only)
- **Conditions:** Status must be `CONFIRMED` and `now >= startAt`.
- **Response `200 OK`:**
  ```json
  {
    "success": true,
    "message": "Appointment marked as completed.",
    "appointment": {
      "id": "e81d7398-319b-4322-bfa1-d419a71b8e19",
      "status": "COMPLETED",
      "completedAt": "2026-10-25T11:16:00.000Z"
    }
  }
  ```
- **Error `400 Bad Request`:**
  ```json
  {
    "success": false,
    "message": "You can mark this appointment completed only after it starts."
  }
  ```

---

### User "My Bookings" Endpoints (Extended)

#### 10. `GET /api/user/bookings`
- **Query:** `status` (`ALL`, `UPCOMING`, `PROCESSING`, `COMPLETED`, `REFUNDED`), `type` (`ALL`, `CONSULTANCY`, `ADVOCATE`), `from`, `to`, `page`, `limit`
- **Response `200 OK`:**
  ```json
  {
    "success": true,
    "availableTypes": ["CONSULTANCY", "ADVOCATE"],
    "bookings": [
      {
        "id": "e81d7398-319b-4322-bfa1-d419a71b8e19",
        "bookingType": "ADVOCATE",
        "bookingId": "VLB-2026JK8M2NP",
        "title": "Voice Call Consultation • 15 min",
        "mode": "VOICE_CALL",
        "status": "CONFIRMED",
        "statusGroup": "UPCOMING",
        "statusLabel": "Confirmed – the advocate will contact you",
        "callStatus": "PENDING",
        "scheduledAt": "2026-10-25T11:00:00.000Z",
        "startAt": "2026-10-25T11:00:00.000Z",
        "endAt": "2026-10-25T11:15:00.000Z",
        "durationMinutes": 15,
        "subject": "Criminal Defence",
        "advocate": {
          "id": "c6a1e3a4-8461-460d-a3df-20ce4b9685a1",
          "fullName": "Adv. Rajesh Sharma",
          "profilePhotoUrl": "https://...",
          "bestPracticeArea": "Criminal Litigation"
        },
        "breakdown": {
          "fee": 510,
          "gst": 91.8,
          "gstPercent": 18,
          "platformFee": 25,
          "total": 626.8
        },
        "actions": {
          "canViewReceipt": true,
          "refundEligibleNow": false
        },
        "createdAt": "2026-10-24T15:00:00.000Z"
      }
    ],
    "counts": {
      "ALL": 5,
      "UPCOMING": 2,
      "PROCESSING": 0,
      "COMPLETED": 2,
      "REFUNDED": 1
    },
    "pagination": { ... }
  }
  ```

---

### Admin Endpoints (RBAC)

#### 11. `GET /api/admin/advocate-bookings`
- **Auth:** Staff with `advocate_bookings:view`
- **Query:** `status`, `mode`, `advocateId`, `userId`, `from`, `to`, `paidFrom`, `paidTo`, `search`, `page`, `limit`
- **Response `200 OK`:** Full list of advocate bookings with user & advocate summaries, breakdown, payment links, and counts.

#### 12. `GET /api/admin/advocate-bookings/:id`
- **Auth:** Staff with `advocate_bookings:view`
- **Response `200 OK`:** Complete detail, payment attempts, and event timeline.

---

## 7. Status State Machine & Mappings

### 7.1 Advocate Booking State Machine

```
              +--------------+
              |     HOLD     |
              +--------------+
                /     |     \
 (Hold expires /      |      \ (Payment captured
  no payment) /       |       \  & slot free)
             v        |        v
      +-----------+   |   +---------------+
      |  EXPIRED  |   |   |   CONFIRMED   |
      +-----------+   |   +---------------+
                      |      /         \
       (Late payment  |     /           \ (Advocate marks
        after hold    |    /             \  after startAt)
        & slot taken) |   / (Admin        v
                      v  v   refund)  +-----------+
              +----------------+      | COMPLETED |
              | REFUND_PENDING |      +-----------+
              +----------------+            | (Admin force
                      |                     |  refund)
                      | (Refund processed)  v
                      +------------> +----------+
                                     | REFUNDED |
                                     +----------+
```

### 7.2 User "My Bookings" Status Mapping

| Booking Status | `status` | `statusGroup` | `statusLabel` | `callStatus` |
|---|---|---|---|---|
| HOLD + payment PROCESSING | `PAYMENT_PROCESSING` | `PROCESSING` | Payment processing – don't pay again | `PENDING` |
| CONFIRMED | `CONFIRMED` | `UPCOMING` | Confirmed – the advocate will contact you | `PENDING` |
| COMPLETED | `COMPLETED` | `COMPLETED` | Completed | `COMPLETED` |
| REFUND_PENDING | `REFUND_IN_PROGRESS` | `REFUNDED` | Refund in progress | `CANCELLED` |
| REFUNDED | `REFUNDED` | `REFUNDED` | Refunded | `CANCELLED` |

*HOLD without processing payment and EXPIRED are filtered out from user's booking list.*

---

## 8. Environment Variables

Documented in `.env.example` and `README.md`:

| Variable | Default Value | Description |
|---|---|---|
| `ADVOCATE_BOOKING_SLOT_MINUTES` | `15` | Default duration (mins) for voice & video call slots |
| `ADVOCATE_IN_PERSON_MINUTES` | `60` | Default duration (mins) for in-person meeting slots |
| `BOOKING_GST_PERCENT` | `18` | GST percentage applied to advocate booking fee only |
| `BOOKING_PLATFORM_FEE` | `25` | Flat platform fee in INR (no GST applied to it) |
| `ADVOCATE_BOOKING_MIN_LEAD_MINUTES` | `30` | Minimum lead time required before a slot can start |
| `ADVOCATE_BOOKING_MAX_DAYS_AHEAD` | `30` | Maximum booking window into the future in days |
| `ADVOCATE_BOOKING_HOLD_MINUTES` | `10` | Slot hold time while customer is on Razorpay payment checkout |
| `ADVOCATE_BOOKING_ID_FORMAT` | `VLB-{YYYY}{MONTH_LETTER}{RAND6}` | Format template for confirmed advocate booking IDs |
| `BOOKING_TIMEZONE` | `Asia/Kolkata` | Timezone for interpreting date filters and slot alignments |

---

## 9. Potential Risks & Mitigations

1. **Risk:** Concurrency race condition where two users simultaneously checkout the same slot.
   - **Mitigation:** Two-tier protection:
     1. PostgreSQL row-level lock (`SELECT id FROM "Advocate" WHERE id = $1 FOR UPDATE`) serializes checkouts.
     2. PostgreSQL exclusion constraint (`advocate_booking_no_overlap`) catches any overlapping confirmation.
2. **Risk:** Customer pays right after the 10-minute hold expires, and another customer booked the slot in the meantime.
   - **Mitigation:** In `syncPaymentFromRazorpay`, before confirming, the slot is re-checked. If taken, status moves to `REFUND_PENDING` with reason `SLOT_CONFLICT_AFTER_EXPIRY`, an automatic full refund is initiated via Razorpay, and the incident is logged. If still free, the late payment is honored and confirmed.
3. **Risk:** Breaking consultancy payments or shared webhook logic.
   - **Mitigation:** In `syncPaymentFromRazorpay`, strict branching on `payment.purpose`: if `CONSULTANCY`, the existing code runs untouched. Existing consultancy tests and verify routes remain intact.
4. **Risk:** Migration replay failure on deployment.
   - **Mitigation:** Strictly follow README Section 31: generate diff via `--script`, review for zero destructive actions, and execute `prisma migrate deploy`.

---

## 10. Answers to OPEN QUESTIONS

1. **Exclusion constraint: Does Neon support `btree_gist`?**
   - **Answer & Recommendation:** **Yes, Neon PostgreSQL natively supports `btree_gist`**. Neon is compatible with standard PostgreSQL extensions. We recommend implementing **Option (a)**: the exclusion constraint `advocate_booking_no_overlap` in the migration SQL, combined with **Option (b)** row-locking `Advocate` during checkout/confirmation transactions for clean serialized application responses.
2. **Advocate amount: Should the advocate see only their fee (default) or the full total?**
   - **Answer & Recommendation:** **Show only their fee** (default). GST is remitted to the government and the ₹25 platform fee belongs to VakeelSetu. Showing the net advocate fee avoids confusion regarding payouts and earnings.
3. **Same advocate: Should a user be allowed several future bookings with the same advocate?**
   - **Answer & Recommendation:** **Yes, allowed**, provided the time slots do not overlap. Clients frequently require multiple consultations on different days.
4. **`PAST_DUE`: Confirmed but not marked completed after the end time. Show it to the admin as a separate filter?**
   - **Answer & Recommendation:** **Yes**. Adding `status=PAST_DUE` in admin filters allows operational staff to monitor advocates who have not fulfilled or completed their scheduled appointments.
5. **Video calls: The advocate contacts the user (phone/WhatsApp video) for now, with no meeting link. OK?**
   - **Answer & Recommendation:** **Yes, agreed**. The advocate receives the client's verified phone number and calls the client directly at the appointed time, adhering strictly to Business Decision #7.
