# Implementation Plan: Advocate Booking — Voice/Video Duration Extension (+15 min steps)

## Database Host & Environment Verification
- **PostgreSQL Host:** `ep-weathered-hat-b47xszyr-pooler.c-6.us-east-2.aws.neon.tech`
- **Database:** `neondb` (Production shared Neon PostgreSQL — **strictly read-only baseline; NO test records, NO manual mutations**)
- **Unit Testing Strategy:** All tests will use Node's built-in `node:test` runner with stubbed Prisma mocks / in-memory fixtures. No live database writes or test records will touch the shared Neon DB.

---

## 1. Current Behaviour Analysis (file:line)

### 1.1 `booking-options`
- **File & Lines:** `src/services/advocateBooking/advocateBooking.service.js:22-80` and `src/services/advocateBooking/pricing.js:131-159`
- **Current Behavior:**
  - Queries advocate pricing fields (`voiceCallPricePer15Min`, `videoCallPricePer15Min`, `offlineVisitingFee`, `officeVisitDurationMinutes`).
  - Calls `getBookableModes(advocate)` (`pricing.js:147-159`), which calculates pricing via `calculatePricing(advocate, mode)` (`pricing.js:55-125`).
  - Modes return fixed `durationMinutes: 15` for `VOICE_CALL` and `VIDEO_CALL`, or `advocate.officeVisitDurationMinutes` (or default 60) for `IN_PERSON`.
  - Currently returns:
    ```json
    {
      "mode": "VIDEO_CALL",
      "label": "Video Call",
      "priceLabel": "₹700 / 15 min",
      "durationMinutes": 15,
      "fee": 700,
      "feePaise": 70000,
      "gst": 126,
      "gstPercent": 18,
      "gstPaise": 12600,
      "platformFee": 25,
      "platformFeePaise": 2500,
      "total": 851,
      "totalPaise": 85100
    }
    ```
  - **Missing today:** Flags for frontend duration expansion (`extendable`, `stepMinutes`, `minDurationMinutes`, `pricePerStep`).

### 1.2 `booking-quote` and `checkout`
- **Validators:** `src/validators/advocateBooking.validator.js:3-16`
  - `bookingQuoteSchema` only accepts `{ mode, startAt }`.
  - `advocateCheckoutSchema` only accepts `{ advocateId, mode, startAt }`.
  - Neither schema accepts `durationMinutes`.
- **Slot Alignment:** `src/services/advocateBooking/slotValidation.js:51-66`
  - Enforces `minuteInTz % slotMinutes === 0` (e.g. 0, 15, 30, 45 in `Asia/Kolkata`) and `seconds === 0 && milliseconds === 0`.
- **Lead Time & Max Days Ahead:** `src/services/advocateBooking/slotValidation.js:68-88`
  - `startAt` must be $\ge$ `minLeadMinutes` (default 30 mins) in the future.
  - `startAt` must be $\le$ `maxDaysAhead` (default 30 days) in advance.
- **Overlap Check (`isSlotFree`):** `src/services/advocateBooking/slotValidation.js:103-124`
  - Queries active conflicting bookings using time interval intersection:
    `startAt < endAt AND endAt > startAt` for `CONFIRMED`, `COMPLETED`, `REFUND_PENDING`, or active `HOLD` (`holdExpiresAt > now`).
  - Already checks the full interval `[startAt, endAt)`!
- **User Conflict Check (`checkUserSlotConflict`):** `src/services/advocateBooking/slotValidation.js:129-155`
  - Queries across all advocates for this `userId` where `startAt < endAt AND endAt > startAt` with status `CONFIRMED`, `COMPLETED`, `REFUND_PENDING`, or active `HOLD`. Throws 400 `USER_SLOT_CONFLICT`.
- **10-minute HOLD & Transactional Concurrency:** `src/services/advocateBooking/advocateBooking.service.js:255-348`
  - Holds the slot for `ADVOCATE_BOOKING_HOLD_MINUTES || '10'`.
  - Locks the advocate row with `SELECT id FROM "Advocate" WHERE id = ${advocateId} FOR UPDATE` to serialize concurrent checkouts.
- **Existing HOLD Reuse Logic Today:** `src/services/advocateBooking/advocateBooking.service.js:169-252`
  - Checks if an active payment exists for:
    ```javascript
    where: {
      userId,
      purpose: 'ADVOCATE_BOOKING',
      advocateBooking: { advocateId, mode, startAt: slotStart, status: 'HOLD' },
      expiresAt: { gt: now }
    }
    ```
  - If synced status is `PAID` $\rightarrow$ returns 200 `ALREADY_PAID`.
  - If synced status is `PROCESSING` $\rightarrow$ throws 409 `PAYMENT_PROCESSING`.
  - If synced status is `CREATED` or `FAILED` $\rightarrow$ reuses the existing Razorpay order and existing payment.
  - **Limitation today:** It does not inspect `durationMinutes`. If a user previously held a 15-min slot and retries with a 30-min slot for the same `startAt`, the existing logic would attempt to reuse the 15-min Razorpay order and 15-min booking!

### 1.3 `AdvocateBooking` Database Columns
- **File & Lines:** `prisma/schema.prisma:692-726`
- **Existing Columns:**
  - `id`: `String @id @default(uuid())`
  - `bookingId`: `String? @unique`
  - `userId`: `String`
  - `advocateId`: `String`
  - `mode`: `AdvocateBookingMode`
  - `startAt`: `DateTime`
  - `endAt`: `DateTime`
  - `durationMinutes`: `Int`
  - `subject`: `String?`
  - `ratePerMinutePaise`: `Int?`
  - `feePaise`: `Int`
  - `gstPercent`: `Int`
  - `gstPaise`: `Int`
  - `platformFeePaise`: `Int`
  - `totalPaise`: `Int`
  - `status`: `AdvocateBookingStatus @default(HOLD)`
  - `holdExpiresAt`: `DateTime`
- **Result:** Both `endAt` and `durationMinutes` already exist as strongly-typed database columns! No schema changes or migrations are needed.

### 1.4 Duration & End Time in Display Layers
- **My Bookings (`src/services/myBookings.service.js:200, 214-232`):**
  - Uses `item.durationMinutes` in the title: `${modeLabel} Consultation • ${item.durationMinutes} min`.
  - Returns `startAt: item.startAt`, `endAt: item.endAt`, `durationMinutes: item.durationMinutes`.
  - Financial breakdown displays stored snapshot `item.feePaise`, `item.gstPaise`, `item.totalPaise`.
- **My Appointments (`src/services/advocateBooking/advocateAppointment.service.js:107-109, 117-118`):**
  - Returns `startAt: b.startAt.toISOString()`, `endAt: b.endAt.toISOString()`, `durationMinutes: b.durationMinutes`.
  - Displays fee directly from `b.feePaise`.
- **Admin Bookings (`src/services/advocateBooking/adminAdvocateBooking.service.js:142-144, 159-162`):**
  - Returns `startAt: b.startAt.toISOString()`, `endAt: b.endAt.toISOString()`, `durationMinutes: b.durationMinutes`, and stored financial snapshot.
- **Booking Confirmation Emails (`src/templates/bookingEmail.template.js:113-116, 263-267`):**
  - Uses `formatBookingDateTimeIst(booking.startAt, booking.endAt)` to format the time range (e.g. `10:00 AM - 10:30 AM IST`).
  - Displays `${modeLabel} · ${booking.durationMinutes} min` and itemizes stored fee, GST, and platform fee.
- **Advocate Earnings (`src/services/advocateEarnings.service.js:1043-1049`):**
  - Credits `amountPaise: booking.feePaise` to the advocate's earning ledger upon appointment completion. An extended duration automatically yields the higher consultation fee to the advocate.
- **Advocate "Mark as Completed" (`src/services/advocateBooking/advocateAppointment.service.js:228-232`):**
  - Checks `if (now < booking.startAt)`: "You can mark this appointment completed only after it starts." This allows completion once `startAt` is reached regardless of duration.

### 1.5 Razorpay Per-Payment Maximum
- **File & Line:** `src/validators/advocate.validator.js:239`
- `RAZORPAY_MAX_PAYMENT_AMOUNT_RUPEES || '500000'` (₹5,00,000, i.e., 50,000,000 paise).
- Any booking whose `totalPaise` exceeds this limit must be rejected with 400 `AMOUNT_TOO_HIGH`.

---

## 2. Technical Design & Architecture

### 2.1 Business Rules & Sanity Validation
1. **Modes:**
   - `VOICE_CALL` and `VIDEO_CALL`: Can be extended in +15 min steps ($\ge 15$ min, multiple of 15).
   - `IN_PERSON`: Fixed length equal to advocate's `officeVisitDurationMinutes` (or default 60). NOT extendable.
2. **Pricing Calculation:**
   - Multiplier: `steps = durationMinutes / 15`.
   - `fee = pricePer15Min * steps`.
   - `feePaise = Math.round(fee * 100)`.
   - `gstPaise = Math.round((feePaise * 18) / 100)`.
   - `platformFeePaise = 2500` (flat ₹25 once per booking).
   - `totalPaise = feePaise + gstPaise + platformFeePaise`.
   - No discounts applied.
3. **Validation Errors & Error Codes:**
   - `durationMinutes < 15` or `durationMinutes % 15 !== 0`:
     $\rightarrow$ 400 `INVALID_DURATION` `"Duration must be in steps of 15 minutes."`
   - Booking crosses midnight in `Asia/Kolkata` (i.e. `endAt > nextMidnightIst`):
     $\rightarrow$ 400 `INVALID_DURATION` `"The booking must end on the same day."`
   - `IN_PERSON` sent with `durationMinutes` different from advocate's duration:
     $\rightarrow$ 400 `INVALID_DURATION` `"Office visit duration is fixed by the advocate."`
   - Total amount exceeds Razorpay maximum:
     $\rightarrow$ 400 `AMOUNT_TOO_HIGH` `"This booking is too long to pay in one payment. Please choose a shorter duration."`
   - Range not free:
     $\rightarrow$ 409 `SLOT_TAKEN` `"The advocate is not available for the full {N} minutes. Please choose a shorter duration or another time."`
   - User has overlapping booking:
     $\rightarrow$ 400 `USER_SLOT_CONFLICT` `"You already have another consultation scheduled during this time slot."`
4. **Backward Compatibility:**
   - If `durationMinutes` is undefined/omitted:
     - For `VOICE_CALL` / `VIDEO_CALL`: defaults to 15.
     - For `IN_PERSON`: defaults to advocate's `officeVisitDurationMinutes` (or 60).

### 2.2 HOLD Reuse & Replace on Duration/Mode Change
When a user calls checkout for `advocateId` and `startAt`:
1. Check for any active payment/hold by this user for the advocate and `startAt` with `status: 'HOLD'` and `expiresAt > now`.
2. If found, sync status from Razorpay:
   - Status `PAID` $\rightarrow$ Return 200 `ALREADY_PAID`.
   - Status `PROCESSING` $\rightarrow$ Throw 409 `PAYMENT_PROCESSING`.
   - Status `CREATED` or `FAILED`:
     - **Same duration and same mode:** Reuse existing Razorpay order and existing payment (existing behavior).
     - **Different duration OR different mode:**
       - The old Razorpay order amount and time interval do not match the new request.
       - In the checkout transaction, immediately release/cancel the old HOLD:
         `await tx.advocateBooking.update({ where: { id: existingPayment.advocateBookingId }, data: { status: 'EXPIRED' } })`
         `await tx.payment.update({ where: { id: existingPayment.id }, data: { status: 'FAILED' } })`
       - Marking the old booking `EXPIRED` instantly frees the slot for the transaction's `isSlotFree` and clears `checkUserSlotConflict`.
       - Create a new Razorpay order for the new amount and create the new booking with the requested duration and new `endAt`.

### 2.3 `booking-options` Additions
Add the required metadata fields to each mode in `calculatePricing` / `getBookableModes`:
- `VOICE_CALL` & `VIDEO_CALL`:
  - `"extendable": true`
  - `"stepMinutes": 15`
  - `"minDurationMinutes": 15`
  - `"pricePerStep": advocate.voiceCallPricePer15Min` (or video)
- `IN_PERSON`:
  - `"extendable": false`
  - `"stepMinutes": null`
  - `"minDurationMinutes": durationMinutes`
  - `"pricePerStep": null`
- Preserves all existing fields: `mode`, `label`, `priceLabel`, `durationMinutes`, `ratePerMinute`, `ratePerMinutePaise`, `fee`, `feePaise`, `gst`, `gstPercent`, `gstPaise`, `platformFee`, `platformFeePaise`, `total`, `totalPaise`.

---

## 3. Files to Change (Existing Files Only)

1. `src/validators/advocateBooking.validator.js`:
   - Add `durationMinutes: z.coerce.number().int().optional()` to `bookingQuoteSchema` and `advocateCheckoutSchema`.
2. `src/services/advocateBooking/pricing.js`:
   - Update `calculatePricing(advocate, mode, durationMinutes = null, startAt = null)`:
     - Calculates fee as `pricePer15Min * (durationMinutes / 15)`.
     - Validates against `RAZORPAY_MAX_PAYMENT_AMOUNT_RUPEES` $\rightarrow$ throws 400 `AMOUNT_TOO_HIGH`.
     - Appends `extendable`, `stepMinutes`, `minDurationMinutes`, `pricePerStep`, `durationMinutes`, and `endAt` (if `startAt` is provided).
   - Update `quote(advocate, mode, durationMinutes = null, startAt = null)` to forward parameters.
3. `src/services/advocateBooking/advocateBooking.service.js`:
   - In `quoteBookingSlot` and `createAdvocateBookingCheckout`:
     - Validate `durationMinutes` constraints (multiple of 15, $\ge 15$, same IST day, IN_PERSON fixed).
     - Calculate `endAt = new Date(startAt.getTime() + durationMinutes * 60 * 1000)`.
     - Forward `durationMinutes` to `pricing.quote` and `slotValidation.validateStart`.
     - Update slot conflict message if not free: `"The advocate is not available for the full {durationMinutes} minutes. Please choose a shorter duration or another time."`
     - Implement HOLD reuse/replace logic when duration or mode changes on retry.
4. `src/controllers/advocateBooking.controller.js`:
   - Forward `durationMinutes: validated.durationMinutes` from `advocateCheckoutSchema` to `createAdvocateBookingCheckout`.
5. `README.md`:
   - Update section 32 with +15 min extension rules, single-booking locking, same-day IST rule, price calculation without discount, request/response samples, error reference, and the 9-step Postman flow.

---

## 4. Before / After Request & Response Samples

### 4.1 `GET /api/advocates/:advocateId/booking-options`

#### Before:
```json
{
  "mode": "VIDEO_CALL",
  "label": "Video Call",
  "priceLabel": "₹510 / 15 min",
  "durationMinutes": 15,
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
```

#### After:
```json
{
  "mode": "VIDEO_CALL",
  "label": "Video Call",
  "priceLabel": "₹510 / 15 min",
  "durationMinutes": 15,
  "extendable": true,
  "stepMinutes": 15,
  "minDurationMinutes": 15,
  "pricePerStep": 510,
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
```

### 4.2 `POST /api/advocates/:advocateId/booking-quote` (30 min extension)

#### Request:
```json
{
  "mode": "VIDEO_CALL",
  "startAt": "2026-11-05T10:00:00.000Z",
  "durationMinutes": 30
}
```

#### Response (200 OK):
```json
{
  "success": true,
  "available": true,
  "startAt": "2026-11-05T10:00:00.000Z",
  "endAt": "2026-11-05T10:30:00.000Z",
  "durationMinutes": 30,
  "mode": "VIDEO_CALL",
  "breakdown": {
    "mode": "VIDEO_CALL",
    "label": "Video Call",
    "priceLabel": "₹510 / 15 min",
    "durationMinutes": 30,
    "extendable": true,
    "stepMinutes": 15,
    "minDurationMinutes": 15,
    "pricePerStep": 510,
    "fee": 1020,
    "feePaise": 102000,
    "gst": 183.6,
    "gstPercent": 18,
    "gstPaise": 18360,
    "platformFee": 25,
    "platformFeePaise": 2500,
    "total": 1228.6,
    "totalPaise": 122860
  }
}
```

### 4.3 Error Responses

#### Duration not a multiple of 15 / < 15:
```json
{
  "success": false,
  "code": "INVALID_DURATION",
  "message": "Duration must be in steps of 15 minutes."
}
```

#### Crosses midnight IST:
```json
{
  "success": false,
  "code": "INVALID_DURATION",
  "message": "The booking must end on the same day."
}
```

#### IN_PERSON with custom duration:
```json
{
  "success": false,
  "code": "INVALID_DURATION",
  "message": "Office visit duration is fixed by the advocate."
}
```

#### Partial slot occupied:
```json
{
  "success": false,
  "code": "SLOT_TAKEN",
  "message": "The advocate is not available for the full 30 minutes. Please choose a shorter duration or another time."
}
```

#### Total exceeds Razorpay maximum:
```json
{
  "success": false,
  "code": "AMOUNT_TOO_HIGH",
  "message": "This booking is too long to pay in one payment. Please choose a shorter duration."
}
```

---

## 5. Potential Risks & Mitigations

1. **Risk:** Concurrent checkout attempts for partially overlapping durations (e.g. User A booking 10:00-10:30 while User B tries 10:15-10:45).
   - **Mitigation:** The existing `SELECT id FROM "Advocate" WHERE id = ${advocateId} FOR UPDATE` row lock serializes checkout transactions, and `isSlotFree` checks the full `[startAt, endAt)` interval.
2. **Risk:** Floating point precision in fee / GST calculations.
   - **Mitigation:** All multiplications and percentages are performed strictly in integer paise (`Math.round(...)`), with float rupees derived only at the presentation boundary.
3. **Risk:** Backward compatibility with existing frontend builds that do not send `durationMinutes`.
   - **Mitigation:** `durationMinutes` is optional in Zod schema and defaults to 15 (Voice/Video) or the advocate's duration (In-Person), maintaining 100% backward compatibility.
4. **Risk:** Shared Neon production database mutation during tests.
   - **Mitigation:** All automated tests will strictly use mock/stubbed Prisma transactions and in-memory fixtures. No queries will touch the live Neon instance.

---

## 6. Answers to Open Questions

1. **Open Question 1:** *Does the `AdvocateBooking` table already store `durationMinutes`, or only `endAt`? If neither, stop and propose the smallest additive migration.*
   - **Answer:** `AdvocateBooking` in `prisma/schema.prisma` lines 698-700 **already stores both `endAt: DateTime` and `durationMinutes: Int`** as non-null fields. Both have been in the database schema since the advocate booking migration. **No Prisma migration or schema alteration is needed.**
2. **Open Question 2:** *Can the advocate's "Mark as Completed" stay as is (allowed after `startAt`)? Default: yes.*
   - **Answer:** **Yes, absolutely.** In `src/services/advocateBooking/advocateAppointment.service.js:228-232`, the check is `if (now < booking.startAt)`. Once the booking's `startAt` time has passed, the advocate is allowed to mark the appointment completed, whether it is 15 minutes or 45 minutes long.
