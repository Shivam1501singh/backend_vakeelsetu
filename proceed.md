# Implementation Plan: Advocate Earnings & Withdrawals with Admin Approval

## Database Host & Environment Verification
- **PostgreSQL Host:** `ep-weathered-hat-b47xszyr-pooler.c-6.us-east-2.aws.neon.tech`
- **Database Name:** `neondb` (Production shared Neon instance — **strictly NO test records or manual mutations**)
- **Read-Only Baseline Aggregates:**
  - `COMPLETED` advocate bookings: **8**
  - Total `feePaise` earned across completed bookings: **310,000 paise** (₹3,100.00)
  - `COMPLETED`-then-`REFUNDED` bookings: **0**
  - `COMPLETED`-then-`REFUND_PENDING` bookings: **0**
  - Total bookings by status: `HOLD: 2`, `CONFIRMED: 12`, `EXPIRED: 10`, `COMPLETED: 8`

---

## 1. Current Behaviour Analysis

### 1.1 Booking Lifecycle & Fees
- `AdvocateBooking` captures:
  - `feePaise`: advocate consultation fee snapshot (the lawyer's earnings)
  - `gstPaise`: 18% GST collected
  - `platformFeePaise`: platform convenience fee
  - `totalPaise`: total paid by user (`feePaise + gstPaise + platformFeePaise`)
  - `status`: `HOLD` -> `CONFIRMED` -> `COMPLETED` (or `EXPIRED`, `REFUND_PENDING`, `REFUNDED`)
- When an advocate marks an appointment completed (`completeAdvocateAppointment` in `src/services/advocateBooking/advocateAppointment.service.js`):
  - Only `status` is set to `COMPLETED` and `completedAt` to `now`.
  - **No financial ledger or earning record is currently created.**

### 1.2 Refund Flow
- Admin/system refunds are handled in `src/controllers/payment.controller.js` (`refundPayment`) and `src/controllers/paymentWebhook.controller.js` (`refund.processed`):
  - Only the Main Admin with `force: true` can refund a `COMPLETED` advocate appointment (`payment.controller.js:623-628`).
  - Booking is updated to `REFUNDED` (or `REFUND_PENDING`).
  - **Currently, no clawback or reversal of the advocate's fee occurs.**

### 1.3 Account Deletion Impact
- In `src/services/advocateDeletion.service.js`, `finalizeAdvocateDeletion` executes `tx.advocate.delete({ where: { id: advocateId } })`.
- Because `AdvocateBooking` uses `@relation(..., onDelete: Restrict)` in `prisma/schema.prisma`, any advocate with booking history **cannot be deleted**.
- By defining `AdvocateEarningLedger`, `AdvocatePayoutAccount`, and `AdvocateWithdrawal` with `onDelete: Restrict`, the entire financial audit trail remains immutable and protected from accidental deletion.

---

## 2. Target Design Adapted to Real Codebase

### 2.1 Core Business Rules & Financial Logic
1. **Earning = `feePaise` only**:
   - GST (`gstPaise`) and Platform Fee (`platformFeePaise`) belong to the platform/tax authority. The advocate's credit is strictly `feePaise`.
2. **Instant Availability on `COMPLETED`**:
   - As soon as appointment status transitions to `COMPLETED`, a `BOOKING_EARNING` row of `+booking.feePaise` is recorded in the ledger within the same DB transaction.
3. **Double-Entry Ledger (No Stored Balance Column)**:
   - Every transaction is an immutable ledger entry in `AdvocateEarningLedger`.
   - `Available Balance = SUM(amountPaise)` across all ledger entries for that advocate.
4. **Held Amount at Withdrawal Request**:
   - When an advocate submits a withdrawal request, a `WITHDRAWAL_HOLD` row of `-amountPaise` is recorded immediately in the ledger.
   - `Available` drops immediately by `amountPaise`.
   - If the admin rejects the request, a `WITHDRAWAL_RELEASE` row of `+amountPaise` is added, restoring Available balance.
   - If the admin marks the withdrawal as PAID, no ledger adjustment is needed because funds were already debited at request time.
5. **Refund of Completed Booking (Negative Balance Recovery)**:
   - If a `COMPLETED` booking is refunded by Main Admin, a `REFUND_REVERSAL` row of `-booking.feePaise` is written to the ledger in the same transaction.
   - If the advocate has already withdrawn their earnings, their `Available` balance will legitimately go negative and will be automatically recovered from future booking earnings.
   - Withdrawals remain blocked while `Available < MIN_WITHDRAWAL_AMOUNT`.
6. **Balance Summary Metrics**:
   - `available`: `SUM(amountPaise)` across all ledger rows.
   - `pending`: `SUM(feePaise)` for `CONFIRMED` appointments (`advocateId, status: 'CONFIRMED'`).
   - `inProcess`: `SUM(amountPaise)` for withdrawals in `REQUESTED` or `APPROVED` status.
   - `withdrawn`: `SUM(amountPaise)` for withdrawals in `PAID` status.
   - `totalEarned`: `SUM(amountPaise)` for ledger rows where `type` is `BOOKING_EARNING` or `REFUND_REVERSAL`.
   - `canWithdraw`: `available >= minWithdrawal` AND no open withdrawal (`REQUESTED` / `APPROVED`) AND payout encryption is configured.

### 2.2 Security & Field Encryption
- Bank account numbers are sensitive financial data.
- **Algorithm:** AES-256-GCM.
- **Key:** `PAYOUT_ENCRYPTION_KEY` (32 bytes, base64-encoded).
  - Validated on startup / access.
  - If missing or invalid, withdrawal and payout-account endpoints return `503 Service Unavailable` with `"Payouts are not configured."` and logs an error once.
- **Storage Format:** `${iv}:${authTag}:${ciphertext}` in base64.
- Masked format returned everywhere: `XXXXXX` + last 4 digits (e.g. `XXXXXX1234`).
- Decrypted full account number is **ONLY** exposed in `GET /api/admin/withdrawals/:id` when the caller has `payouts:manage` permission.

---

## 3. Database Schema & Migration SQL

### 3.1 Prisma Schema Additions (`prisma/schema.prisma`)
```prisma
model AdvocateEarningLedger {
  id                String   @id @default(uuid())
  advocateId        String
  type              String   // BOOKING_EARNING | WITHDRAWAL_HOLD | WITHDRAWAL_RELEASE | REFUND_REVERSAL | ADJUSTMENT
  amountPaise       Int      // + credit, - debit
  advocateBookingId String?
  withdrawalId      String?
  note              String?
  createdBy         String?  // "system" | admin/staff id
  createdAt         DateTime @default(now())

  advocate          Advocate          @relation(fields: [advocateId], references: [id], onDelete: Restrict)
  advocateBooking   AdvocateBooking?  @relation(fields: [advocateBookingId], references: [id], onDelete: Restrict)
  withdrawal        AdvocateWithdrawal? @relation(fields: [withdrawalId], references: [id], onDelete: Restrict)

  @@unique([type, advocateBookingId])
  @@index([advocateId, createdAt])
}

model AdvocatePayoutAccount {
  id                     String   @id @default(uuid())
  advocateId             String   @unique
  accountHolderName      String
  accountNumberEncrypted String
  accountNumberLast4     String
  ifsc                   String
  bankName               String
  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt

  advocate               Advocate @relation(fields: [advocateId], references: [id], onDelete: Restrict)
}

model AdvocateWithdrawal {
  id                     String    @id @default(uuid())
  withdrawalId           String    @unique   // VSW-...
  advocateId             String
  amountPaise            Int
  status                 String    // REQUESTED | APPROVED | PAID | REJECTED
  accountHolderName      String
  accountNumberEncrypted String
  accountNumberLast4     String
  ifsc                   String
  bankName               String
  bankAccountChanged     Boolean   @default(false)
  holderNameMatches      Boolean   @default(true)
  approvedAt             DateTime?
  approvedBy             String?
  paidAt                 DateTime?
  paidBy                 String?
  utr                    String?
  rejectedAt             DateTime?
  rejectedBy             String?
  rejectionReason        String?
  createdAt              DateTime  @default(now())
  updatedAt              DateTime  @updatedAt

  advocate               Advocate  @relation(fields: [advocateId], references: [id], onDelete: Restrict)
  ledgerEntries          AdvocateEarningLedger[]

  @@index([advocateId, status])
  @@index([status, createdAt])
}
```

*Note on PostgreSQL unique index `@@unique([type, advocateBookingId])`:*
Standard PostgreSQL unique indexes treat `NULL` values as distinct. Multiple `WITHDRAWAL_HOLD` or `WITHDRAWAL_RELEASE` rows (where `advocateBookingId` is `NULL`) can exist without collision. Rows with non-null `advocateBookingId` (`BOOKING_EARNING`, `REFUND_REVERSAL`) will enforce strict at-most-once uniqueness.

### 3.2 Additive Migration SQL (Draft)
```sql
-- CreateTable AdvocateEarningLedger
CREATE TABLE "AdvocateEarningLedger" (
    "id" TEXT NOT NULL,
    "advocateId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "advocateBookingId" TEXT,
    "withdrawalId" TEXT,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvocateEarningLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable AdvocatePayoutAccount
CREATE TABLE "AdvocatePayoutAccount" (
    "id" TEXT NOT NULL,
    "advocateId" TEXT NOT NULL,
    "accountHolderName" TEXT NOT NULL,
    "accountNumberEncrypted" TEXT NOT NULL,
    "accountNumberLast4" TEXT NOT NULL,
    "ifsc" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdvocatePayoutAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable AdvocateWithdrawal
CREATE TABLE "AdvocateWithdrawal" (
    "id" TEXT NOT NULL,
    "withdrawalId" TEXT NOT NULL,
    "advocateId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "accountHolderName" TEXT NOT NULL,
    "accountNumberEncrypted" TEXT NOT NULL,
    "accountNumberLast4" TEXT NOT NULL,
    "ifsc" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "bankAccountChanged" BOOLEAN NOT NULL DEFAULT false,
    "holderNameMatches" BOOLEAN NOT NULL DEFAULT true,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidBy" TEXT,
    "utr" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectedBy" TEXT,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdvocateWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdvocateEarningLedger_type_advocateBookingId_key" ON "AdvocateEarningLedger"("type", "advocateBookingId");
CREATE INDEX "AdvocateEarningLedger_advocateId_createdAt_idx" ON "AdvocateEarningLedger"("advocateId", "createdAt");

CREATE UNIQUE INDEX "AdvocatePayoutAccount_advocateId_key" ON "AdvocatePayoutAccount"("advocateId");

CREATE UNIQUE INDEX "AdvocateWithdrawal_withdrawalId_key" ON "AdvocateWithdrawal"("withdrawalId");
CREATE INDEX "AdvocateWithdrawal_advocateId_status_idx" ON "AdvocateWithdrawal"("advocateId", "status");
CREATE INDEX "AdvocateWithdrawal_status_createdAt_idx" ON "AdvocateWithdrawal"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "AdvocateEarningLedger" ADD CONSTRAINT "AdvocateEarningLedger_advocateId_fkey" FOREIGN KEY ("advocateId") REFERENCES "Advocate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdvocateEarningLedger" ADD CONSTRAINT "AdvocateEarningLedger_advocateBookingId_fkey" FOREIGN KEY ("advocateBookingId") REFERENCES "AdvocateBooking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdvocateEarningLedger" ADD CONSTRAINT "AdvocateEarningLedger_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "AdvocateWithdrawal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AdvocatePayoutAccount" ADD CONSTRAINT "AdvocatePayoutAccount_advocateId_fkey" FOREIGN KEY ("advocateId") REFERENCES "Advocate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AdvocateWithdrawal" ADD CONSTRAINT "AdvocateWithdrawal_advocateId_fkey" FOREIGN KEY ("advocateId") REFERENCES "Advocate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

---

## 4. Environment Variables (`.env.example`)
```env
# Advocate Earnings & Withdrawals
MIN_WITHDRAWAL_AMOUNT=500
PAYOUT_ENCRYPTION_KEY=
WITHDRAWAL_ID_FORMAT=VSW-{YYYY}{MONTH_LETTER}{RAND6}
```
- Generation command for `PAYOUT_ENCRYPTION_KEY`:
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`

---

## 5. File Inventory & Routing Structure

### 5.1 New Files (Allowed Only)
1. `src/services/advocateEarnings.service.js`:
   - Summary calculation, ledger query, payout account retrieval.
   - Payout request execution with row lock (`FOR UPDATE`), balance validation, name matching, bank change detection, account upsert, withdrawal record & hold entry.
   - Admin listing, approval, mark-paid (with UTR), rejection (with hold release).
   - Earning credit on mark-complete & reversal on refund.
2. `src/utils/fieldEncryption.util.js`:
   - Dedicated AES-256-GCM encryption/decryption with `PAYOUT_ENCRYPTION_KEY`.
   - Never logs secrets or account numbers.
   - Throws generic 500-safe error on decryption failure.
3. `scripts/backfill-advocate-earnings.js`:
   - Backfills `BOOKING_EARNING` rows for the 8 already-`COMPLETED` bookings.
   - Supports `--dry-run` (default) and `--apply`.
   - Idempotent and outputs DB host, counts, totals, and booking IDs.
4. `prisma/migrations/<timestamp>_advocate_earnings_and_withdrawals/migration.sql`:
   - Migration SQL per Prisma migration policy.

### 5.2 Modified Existing Files
1. `prisma/schema.prisma`: Add models and relations.
2. `prisma/seedRbac.js`: Seed permissions `payouts:view` and `payouts:manage`.
3. `src/utils/idFormat.js`: Add `DEFAULT_WITHDRAWAL_ID_FORMAT`, `getWithdrawalIdFormat`, `generateWithdrawalId`, and env validator.
4. `src/validators/advocate.validator.js`: Add `advocateWithdrawalRequestSchema`.
5. `src/validators/admin.validator.js`: Add `adminWithdrawalListSchema`, `adminApproveWithdrawalSchema`, `adminMarkPaidWithdrawalSchema`, `adminRejectWithdrawalSchema`.
6. `src/routes/advocateBooking.routes.js` & `src/controllers/advocateBooking.controller.js`:
   - Add routes and controller methods:
     - `GET /api/advocate/earnings`
     - `GET /api/advocate/payout-account`
     - `POST /api/advocate/withdrawals`
     - `GET /api/advocate/withdrawals`
     - `GET /api/advocate/withdrawals/:id`
7. `src/server.js`:
   - Mount router at `/api/advocate` for earnings & withdrawal routes.
8. `src/routes/admin.routes.js` & `src/controllers/admin.controller.js`:
   - Add routes and controller methods:
     - `GET /api/admin/withdrawals` (`payouts:view`)
     - `GET /api/admin/withdrawals/:id` (`payouts:view`, decrypted with `payouts:manage`)
     - `POST /api/admin/withdrawals/:id/approve` (`payouts:manage`)
     - `POST /api/admin/withdrawals/:id/mark-paid` (`payouts:manage`)
     - `POST /api/admin/withdrawals/:id/reject` (`payouts:manage`)
     - `GET /api/admin/advocates/:advocateId/earnings` (`payouts:view`)
9. `src/services/advocateBooking/advocateAppointment.service.js`:
   - Add earning credit on mark-complete within transaction.
10. `src/controllers/payment.controller.js` & `src/controllers/paymentWebhook.controller.js`:
    - Add refund reversal for completed bookings within transaction.
11. `.env.example`: Document placeholders and key generation instruction.
12. `README.md`: Add comprehensive Postman Guide section.

---

## 6. Request & Response Samples

### 6.1 `GET /api/advocate/earnings`
```json
{
  "success": true,
  "summary": {
    "available": 1530.00,
    "pending": 510.00,
    "inProcess": 1000.00,
    "withdrawn": 2000.00,
    "totalEarned": 4530.00,
    "minWithdrawal": 500.00,
    "canWithdraw": true,
    "openWithdrawal": null
  },
  "ledger": [
    {
      "id": "e3b0c442-98fc-1c14-9afbf4c8996fb924",
      "type": "BOOKING_EARNING",
      "label": "Booking VLB-2026K9X7Z2 completed",
      "amount": 510.00,
      "createdAt": "2026-11-03T10:00:00.000Z",
      "booking": {
        "bookingId": "VLB-2026K9X7Z2",
        "mode": "VIDEO_CALL",
        "scheduledAt": "2026-11-03T10:00:00.000Z",
        "userName": "Ramesh Kumar"
      }
    },
    {
      "id": "b1b2c3d4-1234-5678-9abc-def012345678",
      "type": "WITHDRAWAL_HOLD",
      "label": "Withdrawal VSW-2026KA1B2C requested",
      "amount": -1000.00,
      "withdrawalId": "VSW-2026KA1B2C",
      "createdAt": "2026-11-03T11:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 2,
    "totalPages": 1,
    "hasNextPage": false
  }
}
```

### 6.2 `GET /api/advocate/payout-account`
```json
{
  "success": true,
  "account": {
    "accountHolderName": "Adv. Shivam Singh",
    "accountNumberMasked": "XXXXXX1234",
    "ifsc": "HDFC0001234",
    "bankName": "HDFC Bank",
    "updatedAt": "2026-11-03T12:00:00.000Z"
  }
}
```

### 6.3 `POST /api/advocate/withdrawals`
**Request:**
```json
{
  "amount": 1000.00,
  "accountHolderName": "Adv. Shivam Singh",
  "accountNumber": "000000001234",
  "confirmAccountNumber": "000000001234",
  "ifsc": "HDFC0001234",
  "bankName": "HDFC Bank"
}
```
**Response (200):**
```json
{
  "success": true,
  "message": "Withdrawal request submitted.",
  "withdrawal": {
    "withdrawalId": "VSW-2026KA1B2C",
    "amount": 1000.00,
    "status": "REQUESTED",
    "bank": {
      "accountHolderName": "Adv. Shivam Singh",
      "accountNumberMasked": "XXXXXX1234",
      "ifsc": "HDFC0001234",
      "bankName": "HDFC Bank"
    },
    "createdAt": "2026-11-03T12:05:00.000Z"
  }
}
```

### 6.4 `GET /api/admin/withdrawals/:id`
```json
{
  "success": true,
  "withdrawal": {
    "id": "c1c2c3c4-1234-5678-9abc-def012345678",
    "withdrawalId": "VSW-2026KA1B2C",
    "amount": 1000.00,
    "status": "REQUESTED",
    "advocate": {
      "id": "a1a2a3a4-1234-5678-9abc-def012345678",
      "fullName": "Shivam Singh",
      "phone": "+919876543210",
      "barCouncilId": "UP/1234/2020"
    },
    "bank": {
      "accountHolderName": "Adv. Shivam Singh",
      "accountNumberMasked": "XXXXXX1234",
      "accountNumber": "000000001234",
      "ifsc": "HDFC0001234",
      "bankName": "HDFC Bank"
    },
    "flags": {
      "bankAccountChanged": false,
      "holderNameMatches": true
    },
    "reviewHistory": {
      "approvedAt": null,
      "approvedBy": null,
      "paidAt": null,
      "paidBy": null,
      "utr": null,
      "rejectedAt": null,
      "rejectedBy": null,
      "rejectionReason": null
    },
    "createdAt": "2026-11-03T12:05:00.000Z",
    "advocateSummary": {
      "available": 530.00,
      "pending": 510.00,
      "withdrawn": 2000.00
    },
    "recentLedger": [ ... ],
    "previousWithdrawals": [ ... ]
  }
}
```
*(Note: `bank.accountNumber` plain text is included ONLY if admin has `payouts:manage`; otherwise omitted).*

### 6.5 `POST /api/admin/withdrawals/:id/mark-paid`
**Request:**
```json
{
  "utr": "UTR123456789012",
  "paidAt": "2026-11-03T12:30:00.000Z"
}
```
**Response (200):**
```json
{
  "success": true,
  "message": "Withdrawal marked as PAID.",
  "withdrawal": {
    "withdrawalId": "VSW-2026KA1B2C",
    "status": "PAID",
    "utr": "UTR123456789012",
    "paidAt": "2026-11-03T12:30:00.000Z"
  }
}
```

### 6.6 `POST /api/admin/withdrawals/:id/reject`
**Request:**
```json
{
  "reason": "IFSC code does not match branch or account name mismatch"
}
```
**Response (200):**
```json
{
  "success": true,
  "message": "Withdrawal rejected and held funds released.",
  "withdrawal": {
    "withdrawalId": "VSW-2026KA1B2C",
    "status": "REJECTED",
    "rejectionReason": "IFSC code does not match branch or account name mismatch",
    "rejectedAt": "2026-11-03T12:35:00.000Z"
  }
}
```

---

## 7. Risks & Mitigations

1. **Race Conditions / Double Withdrawals:**
   - *Risk:* Two simultaneous withdrawal requests from the same advocate could double-spend the available balance.
   - *Mitigation:* Explicit row locking using `SELECT id FROM "Advocate" WHERE id = $1 FOR UPDATE` inside `prisma.$transaction`. Re-verifying open withdrawals and calculating `SUM(amountPaise)` under the active lock.
2. **Concurrent Admin Actions:**
   - *Risk:* Two admins approve or reject the same withdrawal at the exact same time.
   - *Mitigation:* Conditional updates (`updateMany({ where: { id, status: expectedStatus } })`). If count is 0, return 409 Conflict.
3. **Sensitive Data Exposure:**
   - *Risk:* Leaking bank account number in logs or API responses.
   - *Mitigation:* Strip/mask account numbers in all advocate APIs and admin list API. Full number only visible on individual admin detail when holding `payouts:manage`. Explicitly exclude bank fields from generic logger.
4. **Encryption Key Loss or Misconfiguration:**
   - *Risk:* Missing key crashes the server or corrupts data.
   - *Mitigation:* Missing key triggers 503 on payout endpoints with safe error handling without crashing process. Startup warning logged once.
5. **Negative Balance on Post-Completion Refund:**
   - *Risk:* Main admin force-refunds a completed booking after advocate withdrew funds.
   - *Mitigation:* Ledger allows balance to go negative; future earnings automatically offset the negative balance. New withdrawal requests are blocked until balance exceeds `MIN_WITHDRAWAL_AMOUNT`.

---

## 8. Answers to OPEN QUESTIONS

1. **Should the advocate be able to cancel their own REQUESTED withdrawal?**
   - **Recommendation:** **No (not in this task)**. Once submitted, the withdrawal enters the administrative accounting pipeline. If cancellation is needed in the future, it can be added as a dedicated endpoint.
2. **Email notifications (request received / paid / rejected), using the existing email templates?**
   - **Recommendation:** **Not in this task**. Keeping this PR strictly scoped to core earnings, ledger mechanics, security encryption, and approval workflows avoids bloat and email provider flakiness.
3. **Should `holderNameMatches = false` or `bankAccountChanged = true` block approval, or only warn the admin?**
   - **Recommendation:** **Warn only**. In Indian banking, names often vary slightly (e.g., abbreviations like "Adv. S. K. Singh" vs "Shivam Kumar Singh") or advocates legitimately update their bank accounts. Blocking would cause unnecessary operational deadlocks; warning banners let admins manually verify UTR and KYC before clicking Approve.

---

## STOP Condition
Plan is complete. Awaiting user approval to proceed with migration review and implementation.
