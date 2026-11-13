# Implementation Plan: Safe Release of Advocate Booking HOLD on Checkout Cancel

## Database & Environment Protection Notice
- **Database:** Shared Neon PostgreSQL (`ep-weathered-hat-b47xszyr-pooler.c-6.us-east-2.aws.neon.tech`)
- **Policy:** Production database — **Strictly NO test records, NO manual mutations, NO Prisma schema migrations.**
- **Testing:** All unit/integration tests will stub Prisma and Razorpay clients in-memory. Manual testing strictly with Razorpay test credentials.

---

## 1. Codebase Analysis & Current Behavior (file:line)

### 1.1 Status Enums
- **`AdvocateBookingStatus` (`prisma/schema.prisma:678-685`):**
  ```prisma
  enum AdvocateBookingStatus {
    HOLD
    CONFIRMED
    COMPLETED
    EXPIRED
    REFUND_PENDING
    REFUNDED
  }
  ```
  *Finding:* It is a Postgres Enum that does **not** include `CANCELLED`. Per the task specification, we will use the existing `EXPIRED` status for cancelled holds without running any database schema migrations.
- **`PaymentStatus` (`prisma/schema.prisma:738-746`):**
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
  ```
  *Finding:* When a payment is cancelled before capture, `status` will be marked as `EXPIRED` with `failureReason: 'USER_CANCELLED'`.

### 1.2 Checkout Linking (Booking ↔ Payment ↔ Razorpay Order)
- **Relation (`prisma/schema.prisma:729, 768-770`):**
  - `Payment.advocateBookingId` is a unique foreign key referencing `AdvocateBooking.id`.
  - `Payment.razorpayOrderId` is unique, storing the Razorpay order ID.
- **Creation (`src/services/advocateBooking/advocateBooking.service.js:401-440`):**
  - Inside a transaction, `tx.advocateBooking.create` creates the booking with `status: 'HOLD'`, `holdExpiresAt`.
  - `tx.payment.create` creates the payment record with `status: 'CREATED'`, `advocateBookingId: newBooking.id`, `razorpayOrderId: rzpOrder.id`, `expiresAt: holdExpiresAt`.
  - Checkout response returns `checkoutId: newPayment.id` (or `synced.id` if reused).

### 1.3 Slot Validation & Busy Slots
- **`isSlotFree` (`src/services/advocateBooking/slotValidation.js:103-124`):**
  - Checks if any booking exists overlapping `[startAt, endAt)` with:
    - `status IN ['CONFIRMED', 'COMPLETED', 'REFUND_PENDING']`, OR
    - `status = 'HOLD'` AND `holdExpiresAt > now`.
- **`checkUserSlotConflict` (`src/services/advocateBooking/slotValidation.js:129-155`):**
  - Checks if the user has any overlapping booking across any advocate with `CONFIRMED`, `COMPLETED`, `REFUND_PENDING`, or active `HOLD`. Throws `USER_SLOT_CONFLICT`.
- **`getAdvocateBusySlots` (`src/services/advocateBooking/slotValidation.js:193-239`):**
  - Returns `busy: [{ startAt, endAt }]` for all confirmed or active `HOLD` bookings.
  - Route is defined at `src/routes/advocate.routes.js:26` without authentication.

### 1.4 HOLD Reuse & Replace Logic
- **`src/services/advocateBooking/advocateBooking.service.js:241-334`:**
  - Checks for active hold (`userId`, `advocateId`, `startAt: slotStart`, `status: 'HOLD'`, `expiresAt > now`).
  - If found and synced status is `CREATED` / `FAILED`:
    - Same mode & duration: reuses existing Razorpay order and HOLD.
    - Different mode or duration: sets `oldHoldToRelease = { paymentId, bookingId }` and in transaction sets old booking to `EXPIRED` and payment to `FAILED`.
  - *Limitation today:* If the user calls `POST /api/advocates/:advocateId/booking-quote` first, `isSlotFree` and `checkUserSlotConflict` reject the quote before the user even reaches checkout!

### 1.5 Lazy Expiry & Cron Expiry
- **Lazy Expiry:**
  - `slotValidation.js:115-118, 141-144, 217-219`: checks `holdExpiresAt > now`. Once `holdExpiresAt <= now`, the slot is immediately treated as free even before DB updates occur.
  - `src/services/payment.service.js:442-454`: during status sync, if `attempts.length === 0` and `now > currentPayment.expiresAt`, updates both payment and booking to `EXPIRED`.
- **Cron Expiry (`src/controllers/paymentCron.controller.js:56-84`):**
  - Runs periodically; finds payments where `status = 'CREATED'`, `expiresAt <= now`, and `attempts: { none: {} }`. Batch updates `Payment` to `EXPIRED` and `AdvocateBooking` to `EXPIRED`.

### 1.6 Late Payment after Expiry (`syncPaymentFromRazorpay`)
- **`src/services/payment.service.js:251-318`:**
  - When Razorpay reports payment as captured:
    - Locks advocate row with `SELECT id FROM "Advocate" WHERE id = ${booking.advocateId} FOR UPDATE`.
    - Checks `isSlotFree(booking.advocateId, booking.startAt, booking.endAt, tx, booking.id)`.
    - If slot is still free: updates `AdvocateBooking` to `CONFIRMED`, `confirmedAt`, generates `bookingId`, updates `Payment` to `PAID`. (Emails sent asynchronously).
    - If slot was taken by someone else: updates `AdvocateBooking` to `REFUND_PENDING` (reason: `SLOT_CONFLICT_AFTER_EXPIRY`), updates `Payment` to `FAILED`, and automatically triggers `rzpClient.payments.refund(...)`.
  - *Current behavior confirmed:* The backend already contains this safety mechanism! We will standardize the refund reason code to `SLOT_NO_LONGER_AVAILABLE` and ensure idempotency.

### 1.7 Razorpay SDK Call for Fetching Order Payments
- **SDK method (`src/services/payment.service.js:138`):**
  - `rzpClient.orders.fetchPayments(orderId)`: returns `{ items: [...] }` containing payment objects with their statuses (`captured`, `authorized`, `created`, `failed`).

---

## 2. Design & Architecture

### TASK 1: Cancel Checkout API (`POST /api/user/advocate-bookings/checkout/:checkoutId/cancel`)
1. **Route (`src/routes/advocateBooking.routes.js`):**
   - `userAdvocateBookingRouter.post('/checkout/:checkoutId/cancel', requireAuth, requireRole('USER'), generalLimiter, advocateBookingController.cancelCheckout);`
2. **Controller (`src/controllers/advocateBooking.controller.js`):**
   - Validates `checkoutId` parameter (UUID via validator).
   - Verifies ownership (`payment.userId === req.user.id`). If not matching or not found, returns `404 Not Found` (`{ success: false, message: 'Checkout not found.' }`).
3. **Service Logic (`cancelAdvocateBookingCheckout` in `advocateBooking.service.js`):**
   - If booking status is already `CONFIRMED`:
     - Return `200` `{ success: true, result: "PAID", message: "Payment received. Your booking is confirmed.", bookingId: booking.bookingId }`.
   - If booking status is already `EXPIRED` or payment is `EXPIRED` / `FAILED`:
     - Return `200` `{ success: true, result: "ALREADY_CLOSED", status: "EXPIRED" }`.
   - If booking status is `HOLD`:
     - Query Razorpay via `rzpClient.orders.fetchPayments(payment.razorpayOrderId)` wrapped in a 5,000 ms timeout.
     - **Razorpay Error / Timeout:**
       - Do **NOT** release. Keep hold.
       - Return `200` `{ success: true, result: "HOLD_KEPT", message: "We couldn't confirm the payment status right now. The slot will be released automatically in a few minutes." }`.
     - **Any payment `captured` or `authorized`:**
       - Synchronize using `syncPaymentFromRazorpay({ paymentId: payment.id })`.
       - Return `200` `{ success: true, result: "PAID", message: "Payment received. Your booking is confirmed.", bookingId: synced.advocateBooking?.bookingId }`.
     - **Any payment `created` (in-flight/pending UPI):**
       - Do **NOT** release.
       - Return `200` `{ success: true, result: "PAYMENT_PROCESSING", message: "Your payment is being confirmed. Please don't pay again." }`.
     - **No payments, or only `failed`:**
       - Execute atomic update inside transaction:
         - Verify booking is still `HOLD` (`WHERE id = booking.id AND status = 'HOLD'`).
         - Update `AdvocateBooking`: `status: 'EXPIRED'`.
         - Update `Payment`: `status: 'EXPIRED'`, `failureReason: 'USER_CANCELLED'`.
       - Return `200` `{ success: true, result: "RELEASED", message: "Slot released." }`.

### TASK 2: User Not Blocked by Own HOLD
1. **Quote Path (`quoteBookingSlot` in `advocateBooking.service.js`):**
   - Pass `userId` to `isSlotFree`. If an active HOLD on this advocate and slot belongs to the same user, do not treat it as taken for this user.
   - In `checkUserSlotConflict`, exclude active HOLDs of the user on the same slot or any hold being replaced.
2. **Checkout Path (`createAdvocateBookingCheckout`):**
   - **Case A (Same slot, same advocate, same mode, same duration):** Reuses the existing HOLD (existing logic).
   - **Case B (User has other active HOLDs on any slot/advocate):**
     - Find all other active HOLDs for `userId`.
     - For each one, perform the Razorpay safety check (`orders.fetchPayments`):
       - If any payment is pending (`created`) or captured: abort with `409 PAYMENT_PROCESSING` and include the `checkoutId`.
       - If no payments or only failed: safely mark as `EXPIRED` (`failureReason: 'USER_CANCELLED'`).
3. **`isSlotFree` & `checkUserSlotConflict` (`src/services/advocateBooking/slotValidation.js`):**
   - Add parameter `excludeUserIdHoldForSlot` / `excludeUserHoldId` so the user's own replaceable hold does not conflict.
4. **`busy-slots` (`src/services/advocateBooking/slotValidation.js` & `advocateBooking.controller.js`):**
   - Check if request has an authenticated user (via `optionalAuth` on the route or extracting token in controller).
   - If anonymous: behavior remains identical (returns `busy: [{ startAt, endAt }]`).
   - If authenticated user: user's own active HOLDs are filtered out of `busy` and placed into `myHolds: [{ startAt, endAt, checkoutId, expiresAt }]`.

### TASK 3: Late Payment Safety Net (`syncPaymentFromRazorpay`)
- Located in `src/services/payment.service.js:251-318`:
  - When payment is captured for an advocate booking whose hold was expired/cancelled:
    - If slot is still free: confirm booking as normal.
    - If slot was taken by another user: auto-refund full amount via `rzpClient.payments.refund(...)`, update `AdvocateBooking` to `REFUND_PENDING` with `refundReason: 'SLOT_NO_LONGER_AVAILABLE'`, and update `Payment` to `FAILED` with `failureReason: 'SLOT_NO_LONGER_AVAILABLE'`.
  - Ensure idempotency: if already confirmed or already refunded, skip duplicate actions.

### TASK 4: Hold Time from Environment Variable
- Read `ADVOCATE_BOOKING_HOLD_MINUTES` with default `10`.
- Validate range 3 to 30 minutes. If NaN, < 3, or > 30, log a single warning and default to 10.
- Update `.env.example` comments clarifying the valid range (3–30).

### TASK 5: Documentation & Tests
- Document all behavior, cancel flow, Postman test cases, and edge cases in `README.md`.
- Create comprehensive unit tests in `tests/advocateBookingCancel.test.js` stubbing Prisma and Razorpay.

---

## 3. Files to Change (No New Files in src/, No Schema Migrations)
1. `src/routes/advocateBooking.routes.js`: Add cancel checkout route.
2. `src/controllers/advocateBooking.controller.js`: Add `cancelCheckout` handler; update `getBusySlots` to pass `req.user?.id`.
3. `src/services/advocateBooking/advocateBooking.service.js`: Add `cancelAdvocateBookingCheckout`, update hold auto-release in checkout, update hold minutes parser.
4. `src/services/advocateBooking/slotValidation.js`: Support `excludeUserHold` in `isSlotFree`, `checkUserSlotConflict`, and return `myHolds` in `getAdvocateBusySlots`.
5. `src/services/payment.service.js`: Ensure reason code `SLOT_NO_LONGER_AVAILABLE` for conflicted late payments.
6. `src/validators/advocateBooking.validator.js`: Add `checkoutCancelParamsSchema`.
7. `src/routes/advocate.routes.js`: Add `optionalAuth` to `/:advocateId/busy-slots`.
8. `.env.example`: Update description for `ADVOCATE_BOOKING_HOLD_MINUTES` (range 3–30).
9. `README.md`: Add comprehensive documentation for the cancel API, own-hold rules, late payment refund, and Postman testing guide.
10. `tests/advocateBookingCancel.test.js`: Comprehensive unit tests with stubbed Prisma and Razorpay.

---

## 4. Request / Response Samples

### Cancel Checkout Request
```http
POST /api/user/advocate-bookings/checkout/a8f27329-87c2-487b-bb66-1070622a59a1/cancel
Authorization: Bearer <user_jwt_token>
```

### Responses
1. **Slot Released (no payment / failed payment):**
   ```json
   {
     "success": true,
     "result": "RELEASED",
     "message": "Slot released."
   }
   ```
2. **Payment Processing (UPI in-flight):**
   ```json
   {
     "success": true,
     "result": "PAYMENT_PROCESSING",
     "message": "Your payment is being confirmed. Please don't pay again."
   }
   ```
3. **Payment Already Captured / Authorized:**
   ```json
   {
     "success": true,
     "result": "PAID",
     "message": "Payment received. Your booking is confirmed.",
     "bookingId": "VLB-2026NOV123456"
   }
   ```
4. **Razorpay Error or Timeout (Hold Kept for Safety):**
   ```json
   {
     "success": true,
     "result": "HOLD_KEPT",
     "message": "We couldn't confirm the payment status right now. The slot will be released automatically in a few minutes."
   }
   ```
5. **Already Closed / Expired:**
   ```json
   {
     "success": true,
     "result": "ALREADY_CLOSED",
     "status": "EXPIRED"
   }
   ```

### Busy Slots Response (Authenticated with own hold)
```http
GET /api/advocates/:advocateId/busy-slots?date=2026-11-20
Authorization: Bearer <user_jwt_token>
```
```json
{
  "success": true,
  "date": "2026-11-20",
  "timezone": "Asia/Kolkata",
  "busy": [
    { "startAt": "2026-11-20T04:30:00.000Z", "endAt": "2026-11-20T05:00:00.000Z" }
  ],
  "myHolds": [
    {
      "startAt": "2026-11-20T05:30:00.000Z",
      "endAt": "2026-11-20T05:45:00.000Z",
      "checkoutId": "a8f27329-87c2-487b-bb66-1070622a59a1",
      "expiresAt": "2026-11-20T05:25:00.000Z"
    }
  ]
}
```

---

## 5. Risks & Mitigations
1. **UPI Race Condition:** User initiates UPI payment on phone, closes web popup, then completes payment on UPI app.
   - *Mitigation:* We never release the slot without querying Razorpay's `orders.fetchPayments`. If any payment attempt is `created` (pending) or `authorized`/`captured`, the slot is **not** released. If a late payment succeeds after slot release/expiry, `syncPaymentFromRazorpay` confirms the booking if slot is free, or auto-refunds the user if the slot was taken.
2. **Concurrency / Race Conditions:** Multiple simultaneous requests for cancel or checkout.
   - *Mitigation:* Row lock on `Advocate` via `SELECT ... FOR UPDATE` and conditional update (`WHERE status = 'HOLD'`) ensures strict serialization.
3. **Razorpay Gateway Outage / Network Delay:**
   - *Mitigation:* 5-second timeout on Razorpay call. If timeout occurs, result is `HOLD_KEPT` and normal 10-minute expiry cleans it up safely.
4. **Production DB Safety:**
   - *Mitigation:* No migrations, no write queries on shared Neon DB during testing. All test suites use stubbed in-memory mocks.

---

## 6. Answers to OPEN QUESTIONS

1. **Does the same issue exist for consultancy checkout?**
   - **Answer:** No. Consultancy checkouts (`POST /api/user/consultancy/checkout`) do not reserve calendar time slots or interact with advocate schedule availability. Consultancies are on-demand requests created upon successful payment. Therefore, consultancy checkout does not hold any slot and will not be modified.
2. **Should `PAYMENT_PROCESSING` from the cancel API also trigger a short server-side re-check (e.g. after 15 s), or rely on the existing webhook + cron?**
   - **Answer:** We will rely on the existing webhook + cron infrastructure. Webhooks receive instantaneous notifications from Razorpay when payment completes or fails, and cron handles periodic sweeps. Adding an ad-hoc in-memory timer or background delay introduces concurrency complexity and process failure vulnerabilities.
