# Implementation Plan: "Consultancy Booked" Confirmation Email to the USER

## Database Host
**Neon PostgreSQL Host:** `ep-weathered-hat-b47xszyr-pooler.c-6.us-east-2.aws.neon.tech`  
**Database Name:** `neondb` (Production shared instance — strictly NO test records or manual mutations)

---

## 1. Trigger Point Analysis (`file:line`)

### Primary Trigger Point:
- **File:** `src/services/payment.service.js`
- **Location:** Line 320–350 inside `syncPaymentFromRazorpay` transaction creates the `ConsultancyRequest`:
  - `tx.createConsultancyWithUniqueBookingId(...)` at line 322
  - `tx.payment.update({ where: { id: pId }, data: { status: 'PAID', consultancyRequestId: consultancy.id, paidAt: paidAtDate, refundEligibleAt } })` at line 339
- **Post-Transaction Trigger Point (File:Line):**
  - **`src/services/payment.service.js:492`** (immediately after transaction commit and fetch of `freshPayment` with relations):
    ```javascript
    // Trigger consultancy booking confirmation email when paid and confirmed
    if (
      freshPayment?.purpose === 'CONSULTANCY' &&
      freshPayment?.status === 'PAID' &&
      freshPayment?.consultancyRequestId &&
      freshPayment?.consultancyRequest &&
      !freshPayment.consultancyRequest.confirmationEmailSentAt
    ) {
      try {
        const withTimeout = (promise, ms = 8000) => {
          let timer;
          const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Email confirmation timed out after ${ms}ms`)), ms);
          });
          return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
        };
        await withTimeout(sendConsultancyConfirmationEmail(freshPayment.consultancyRequestId), 8000);
      } catch (emailErr) {
        console.error(`[Razorpay Sync] Consultancy confirmation email error for ${freshPayment.consultancyRequestId}:`, emailErr.message);
      }
    }
    ```
- **Context:** Because all payment verification paths (frontend `POST /api/payments/verify`, Razorpay Webhook `POST /api/payments/webhook`, and background cron `GET /api/internal/cron/payments-reconcile`) delegate to `syncPaymentFromRazorpay`, triggering here guarantees 100% coverage across all channels.

### Secondary Trigger Point (Background Reconcile Cron):
- **File & Line:** `src/controllers/paymentCron.controller.js:85` inside `reconcilePaymentsCron`.
- **Logic:** Queries `ConsultancyRequest` created within the last 48 hours with `confirmationEmailSentAt: null` and linked to a `PAID` payment, dispatching missing confirmation emails automatically.

---

## 2. Field Mapping & Architecture

### Data Models & Fields Read:
1. `ConsultancyRequest`:
   - `id`: UUID (Primary Key)
   - `bookingId`: e.g. `VSB-2026K4H7Q2M`
   - `callType`: `ConsultancyCallType` (`CALL` | `VIDEO_CALL`)
   - `duration`: e.g. `15` or `30` (minutes)
   - `price`: Decimal (e.g. `499.00`)
   - `phoneNumber`: Contact telephone from checkout
   - `email`: Contact email from checkout
   - `status`: `ConsultancyStatus` (`PENDING`)
   - `createdAt`: DateTime
   - `user`: relation to `User` (`fullName`, `email`)
2. `Payment`:
   - `amount`: Int in paise (e.g. `49900` = `₹499.00`)
   - `paidAt`: DateTime
   - `refundEligibleAt`: DateTime? (e.g. 7 working days from `paidAt`)
   - `attempts`: relation to `PaymentAttempt` with captured `razorpayPaymentId` (e.g. `pay_XXXXXXXXXXXX`)

### Recipient Resolution:
1. **Primary:** The checkout contact email (`ConsultancyRequest.email`).
2. **Fallback:** If checkout email is empty/missing, fall back to the account email (`ConsultancyRequest.user?.email`).
3. **If both are missing:** Skip delivery, log once at `info` level, and leave `confirmationEmailSentAt: null`.

---

## 3. Template Design (`consultancyBookedUserTemplate` in `src/templates/bookingEmail.template.js`)

Matching **Demo A** from `vakeelsetu_consultancy_email_demo.html`:
- **Subject:** `Consultancy booked – {Call | Video Call} • {duration} min`
- **Preheader:** `Booking {bookingId} confirmed. Our team will contact you shortly.`
- **Content Elements:**
  1. **Status Pill:** Green `"✓  Consultancy booked"` (`#e6f6ee` background, `#13804f` text)
  2. **Heading:** `"Your expert consultation is booked"`
  3. **Intro Paragraph:**
     - If name is present: `"Dear <strong style="color:#14161f;">{name}</strong>,<br/>"`
     - Body: `"Thank you for your payment. Your <strong>{Call | Video Call} Consultation ({duration} min)</strong> is confirmed. Our legal expert team will contact you shortly on the number below."`
  4. **Dark Reference Box (`#020317`):**
     - Left: `Booking ID` in amber uppercase `#f59f0b`, value in white monospace (`{bookingId}`)
     - Right: `Package` in amber uppercase `#f59f0b`, value in white (`{Call | Video Call}<br/>{duration} min`)
  5. **Detail Table (`#fbfaf8` card with `#ece6dc` border):**
     - Contact phone: `{phoneNumber}`
     - Contact email: `{email}`
     - Booked on: IST formatted (`{date}, {time} IST` e.g. `3 Nov 2026, 2:45 PM IST` from `payment.paidAt || consultancy.createdAt`)
     - Payment ID: Captured `razorpayPaymentId` from payment attempts or `payment.id`
     - Amount paid: Highlighted in `#d97706` 17px font, formatted from stored `payment.amount` snapshot (paise → ₹ with 2 decimals, Indian commas e.g. `₹499.00`)
  6. **Action Button:** `"View My Bookings"` → `{CLIENT_URL}/my-bookings` (reuses `getBookingDashboardUrl('USER')`)
  7. **Footnote Box:**
     - If `refundEligibleAt` exists: `"If your consultation doesn't happen by <strong>{refundDateStr}</strong>, you become eligible for a refund. Keep your phone reachable."` (date in IST e.g. `12 Nov 2026`)
     - If `refundEligibleAt` is null: footnote is omitted.
  8. **Support & Footer:**
     - Support card: Enabled (`showSupport: true`), rendering `BRAND_SUPPORT_PHONE` and `BRAND_SUPPORT_EMAIL`.
     - Footer: `#020317` with `BRAND_ADDRESS` and Website / Terms / Contact links.
- **Constraints Honored:**
  - **NO "What happens next" steps section.**
  - **NO team/admin email (Demo B is completely ignored).**
  - All dynamic data strictly sanitized via `escapeHtml()`.

---

## 4. Once-Only Delivery & Service Implementation (`src/services/email.service.js`)

**Function:** `sendConsultancyConfirmationEmail(consultancyRequestId)`
1. Fetches `ConsultancyRequest` with `user` and `payment.attempts`.
2. Resolves recipient (`consultancy.email || consultancy.user?.email`).
3. **Atomic Claiming:**
   ```javascript
   const claim = await prisma.consultancyRequest.updateMany({
     where: { id: consultancyRequestId, confirmationEmailSentAt: null },
     data: { confirmationEmailSentAt: new Date() }
   });
   if (claim.count === 0) {
     return { success: true, message: 'Already sent or claimed' };
   }
   ```
4. Dispatches via `sendBrandedMail(...)` with `emailType: 'CONSULTANCY_BOOKED_USER'` (automatically includes `src/assets/email/logo.png` CID attachment).
5. **Error & Timeout Handling:** If sending fails, resets `confirmationEmailSentAt: null` so the reconcile cron can retry. Never throws an error out of the function.
6. **Logging:** Logs masked recipient (`ra***@gmail.com`), `bookingId`, message ID, success/failure. Never logs email HTML body.

---

## 5. Scope & Filtering Rules

Confirmation email is dispatched **strictly for paid consultancy requests**:
- **Allowed:** `payment.status === 'PAID'` and `payment.purpose === 'CONSULTANCY'`.
- **Excluded:**
  - Legacy free requests (where `payment === null`).
  - Duplicate payment refunds (`DUPLICATE_REFUNDED`).
  - Refunds / SLA breach refunds.
  - Advocate bookings (handled by existing separate advocate booking email flow).
  - No team or admin notification.

---

## 6. Database Migration (Part B / Task 2)

### Schema Addition (`prisma/schema.prisma` in `model ConsultancyRequest`)
```prisma
model ConsultancyRequest {
  ...
  completedAt             DateTime?
  confirmationEmailSentAt DateTime?
  createdAt               DateTime            @default(now())
  ...
}
```

### Migration SQL
```sql
-- AlterTable
ALTER TABLE "ConsultancyRequest" ADD COLUMN "confirmationEmailSentAt" TIMESTAMP(3);
```
- **Policy:** Completely additive and nullable. Zero locking or downtime.
- **Generation:** Generated via `npx prisma migrate diff` script without shadow DB.
- **Rule:** Waiting for explicit user approval before running `npx prisma migrate deploy`.

---

## 7. Files to Modify

Only the specified existing files will be touched:
1. `src/templates/bookingEmail.template.js` — add `consultancyBookedUserTemplate`
2. `src/services/email.service.js` — add `sendConsultancyConfirmationEmail`
3. `src/services/payment.service.js` — trigger `sendConsultancyConfirmationEmail` with 8s timeout in `syncPaymentFromRazorpay`
4. `src/controllers/paymentCron.controller.js` — add 48-hour retry query in `reconcilePaymentsCron`
5. `scripts/preview-emails.js` — add `consultancy-user.html` preview generation
6. `prisma/schema.prisma` — add `confirmationEmailSentAt DateTime?`
7. `prisma/migrations/<timestamp>_add_consultancy_email_sent_timestamp/migration.sql` — generated migration SQL
8. `README.md` — document consultancy booking confirmation email in Section 36
9. `tests/email.test.js` — add unit test coverage for template, claiming, failure reset, and fallback email

---

## 8. Risks & Mitigations

1. **Risk:** Slow SMTP or network stall delaying user checkout verify response.  
   **Mitigation:** `withTimeout(..., 8000)` wraps the send call post-transaction. Timeout counts as failure, releases HTTP response immediately, resets timestamp to `null`, and cron retries later.
2. **Risk:** Race condition between webhook and client verify causing duplicate email sends.  
   **Mitigation:** Atomic row claim via `updateMany({ where: { id, confirmationEmailSentAt: null } })`. Exactly one execution claims the record and proceeds to send.
3. **Risk:** User entered different email during checkout vs their account registration email.  
   **Mitigation:** Prioritizes checkout contact email (`consultancy.email`), falling back to user's account email only if checkout email is missing.
