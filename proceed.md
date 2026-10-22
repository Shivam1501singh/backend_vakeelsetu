# Plan: "My Bookings" for Users (Consultancy Only)

## 1. Current Behaviour Analysis
- **Consultancy Feature:**
  - `ConsultancyRequest` exists in Prisma with fields:
    - `id` (UUID), `userId`, `callType` (`CALL | VIDEO_CALL`), `duration` (`15 | 30`), `price` (`Decimal(10,2)`), `phoneNumber`, `email`, `status` (`PENDING | COMPLETED | REFUNDED`), `completedAt`, `createdAt`, `updatedAt`.
    - Indexed on: `[userId]`, `[status]`, `[createdAt]`.
  - Existing endpoints:
    - `POST /api/user/consultancy` (blocked with `PAYMENT_REQUIRED` when `PAYMENTS_ENABLED=true`).
    - `GET /api/user/consultancy` (returns raw user requests with optional pagination).
    - `GET /api/user/consultancy/:id` (returns single user request).
    - `GET /api/admin/consultancy` & `PATCH /api/admin/consultancy/:id/status` (admin management).
- **Payment Feature Status:**
  - **CONFIRMED MERGED:** The Razorpay payment feature is already present and active in the repository:
    - Models `Payment`, `PaymentAttempt`, `PaymentWebhookEvent` exist in `prisma/schema.prisma`.
    - `Payment` has fields: `id`, `userId`, `callType`, `duration`, `phoneNumber`, `email`, `amount` (in paise), `currency` (`INR`), `status` (`CREATED | PROCESSING | PAID | FAILED | EXPIRED | REFUND_PENDING | REFUNDED`), `razorpayOrderId`, `consultancyRequestId` (unique relation to `ConsultancyRequest`), `paidAt`, `expiresAt`, `refundEligibleAt`, `refundId`, `refundedAt`, `refundReason`, `refundedById`, `refundedByType`, `failureReason`, `createdAt`, `updatedAt`.
    - Indexed on: `[userId]`, `[status]`, `[createdAt]`, `[refundEligibleAt]`.
    - `PaymentAttempt` records individual gateway transactions per order.
    - Endpoints `POST /api/user/consultancy/checkout`, `POST /api/user/consultancy/checkout/verify`, `GET /api/user/consultancy/checkout/:checkoutId/status`, and `GET /api/user/payments` are live.
  - Payment-to-Consultancy relationship:
    - A `ConsultancyRequest` is created exclusively upon successful payment capture (`status === 'PAID'`).
    - A `Payment` in `PROCESSING` (or `CREATED` with attempts) does not have a `ConsultancyRequest` linked yet (`consultancyRequestId` is `null`).
    - Legacy requests created before payment integration have `payment: null`.

---

## 2. Response Design Adapted to Real Fields

### 2.1 Single Booking Item Shape
```json
{
  "id": "e2a4df81-9b16-419b-82ef-d2f1f51cb322",
  "title": "Video Call Consultation • 30 min",
  "status": "CONFIRMED",
  "statusGroup": "UPCOMING",
  "statusLabel": "Confirmed – our team will call you",
  "callType": "VIDEO_CALL",
  "durationMinutes": 30,
  "price": 899,
  "currency": "INR",
  "contact": {
    "phoneNumber": "9876543210",
    "email": "user@example.com"
  },
  "payment": {
    "status": "PAID",
    "amount": 899,
    "paidAt": "2026-10-22T08:10:00.000Z",
    "razorpayOrderId": "order_XXXX",
    "razorpayPaymentId": "pay_XXXX",
    "refundEligibleAt": "2026-10-31T18:29:59.000Z",
    "refundedAt": null
  },
  "completedAt": null,
  "createdAt": "2026-10-22T08:10:05.000Z",
  "updatedAt": "2026-10-22T08:10:05.000Z",
  "actions": {
    "canViewReceipt": true,
    "refundEligibleNow": false
  }
}
```

### 2.2 Field Adaptations & Rules
- **`title`**:
  - `CALL`: `"Call Consultation • ${durationMinutes} min"`
  - `VIDEO_CALL`: `"Video Call Consultation • ${durationMinutes} min"`
- **`price` & `payment.amount`**:
  - Number in INR rupees (`Number(item.price)` for Decimal; `payment.amount / 100` for paise).
- **`payment`**:
  - `null` for legacy bookings without a payment record.
  - For paid/processing bookings, includes `razorpayOrderId` and `razorpayPaymentId` (extracted from captured attempt or most recent attempt).
- **`actions`**:
  - `canViewReceipt`: `true` if `payment` exists and its status is `PAID`, `REFUND_PENDING`, or `REFUNDED`; otherwise `false`.
  - `refundEligibleNow`: `true` if `payment.status === 'PAID'` AND `consultancy.status !== 'COMPLETED'` AND `now >= payment.refundEligibleAt` AND neither refunded nor refund-pending; otherwise `false`.
- **Status Mapping**:
  | Source State | `status` | `statusGroup` | `statusLabel` |
  |---|---|---|---|
  | Payment `PROCESSING` (or `CREATED` with $\ge 1$ attempt, no consultancy) | `PAYMENT_PROCESSING` | `PROCESSING` | Payment processing – don't pay again |
  | Consultancy `PENDING` + Payment `PAID` | `CONFIRMED` | `UPCOMING` | Confirmed – our team will call you |
  | Consultancy `PENDING` (Legacy, no payment) | `REQUESTED` | `UPCOMING` | Request received |
  | Payment `REFUND_PENDING` (Consultancy not completed) | `REFUND_IN_PROGRESS` | `REFUNDED` | Refund in progress |
  | Consultancy `REFUNDED` or Payment `REFUNDED` | `REFUNDED` | `REFUNDED` | Refunded |
  | Consultancy `COMPLETED` | `COMPLETED` | `COMPLETED` | Completed |

### 2.3 Detail Response with Timeline
`GET /api/user/bookings/:id` returns `{ success: true, booking: { ...booking, timeline } }`.
The `timeline` is an array of `{ at: ISOString, event: string }` sorted chronologically (`at` ASC):
- `PAYMENT_PAID`: `payment.paidAt`
- `BOOKING_CONFIRMED`: `consultancy.createdAt`
- `COMPLETED`: `consultancy.completedAt`
- `REFUND_INITIATED`: `payment.updatedAt` when `payment.status === 'REFUND_PENDING'`
- `REFUNDED`: `payment.refundedAt || payment.updatedAt` when `payment.status === 'REFUNDED'` or `consultancy.status === 'REFUNDED'`

---

## 3. Files to Create and Modify

1. **`src/validators/myBookings.validator.js`** (NEW):
   - `userBookingsQuerySchema`:
     - `status`: `z.enum(['UPCOMING', 'PROCESSING', 'COMPLETED', 'REFUNDED', 'ALL']).optional().default('ALL')`
     - `from`: `z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional()`
     - `to`: `z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional()`
     - `page`: `z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1)).optional().default('1')`
     - `limit`: `z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(50)).optional().default('10')`

2. **`src/services/myBookings.service.js`** (NEW):
   - `listUserBookings(userId, { status, from, to, page, limit })`:
     - Loads consultancy requests for `userId` with payment and attempts via Prisma (`where: { userId }`).
     - Loads `PAYMENT_PROCESSING` payments for `userId` (`consultancyRequestId: null`, status `PROCESSING` or `CREATED` with $\ge 1$ attempt).
     - Merges both streams in-memory (as allowed in the prompt since processing payments per user are few/negligible).
     - Filters by `statusGroup` (`ALL` includes everything; otherwise exact match on `statusGroup`).
     - Filters by `from` / `to` timestamps on `createdAt`.
     - Orders by `createdAt desc`, tie-breaker `id asc`.
     - Computes tab counts across all items for the user (`counts: { ALL, UPCOMING, PROCESSING, COMPLETED, REFUNDED }`).
     - Paginates and returns `{ bookings, pagination, counts }`.
   - `getUserBooking(userId, id)`:
     - Tries finding a `ConsultancyRequest` matching `id` and `userId`.
     - If not found, checks `Payment` matching `id` and `userId` that meets the `PAYMENT_PROCESSING` criteria.
     - If neither found, throws 404 `"Booking not found."`.
     - Formats booking and appends chronological `timeline`.
   - `getUserBookingCounts(userId)`:
     - Computes and returns `{ ALL, UPCOMING, PROCESSING, COMPLETED, REFUNDED }` for the user.

3. **`src/controllers/myBookings.controller.js`** (NEW):
   - `listUserBookings(req, res, next)`
   - `getUserBooking(req, res, next)`

4. **`src/routes/myBookings.routes.js`** (NEW):
   - Mounts `GET /` and `GET /:id` protected with:
     - `requireAuth`
     - `requireRole('USER')`
     - `generalLimiter`

5. **`src/server.js`** (MODIFY):
   - Mount router at `/api/user/bookings`:
     ```javascript
     import myBookingsRouter from './routes/myBookings.routes.js';
     ...
     app.use('/api/user/bookings', myBookingsRouter);
     ```

6. **`README.md`** (MODIFY):
   - Add **"## 30. My Bookings (User) — Postman Guide"** with all requested documentation: overview, endpoint table, booking object spec, status mapping, request/response samples, error table, and postman step-by-step verification flow.

---

## 4. Request / Response Samples

### 4.1 `GET /api/user/bookings` (Default / ALL)
**Request:**
```http
GET /api/user/bookings?page=1&limit=10
Authorization: Bearer <USER_JWT>
```
**Response (200 OK):**
```json
{
  "success": true,
  "bookings": [
    {
      "id": "c7a8b9c0-1111-2222-3333-444455556666",
      "title": "Video Call Consultation • 30 min",
      "status": "CONFIRMED",
      "statusGroup": "UPCOMING",
      "statusLabel": "Confirmed – our team will call you",
      "callType": "VIDEO_CALL",
      "durationMinutes": 30,
      "price": 899,
      "currency": "INR",
      "contact": {
        "phoneNumber": "9876543210",
        "email": "user@example.com"
      },
      "payment": {
        "status": "PAID",
        "amount": 899,
        "paidAt": "2026-10-22T08:10:00.000Z",
        "razorpayOrderId": "order_OXXXXX123456",
        "razorpayPaymentId": "pay_PXXXXX123456",
        "refundEligibleAt": "2026-10-31T18:29:59.000Z",
        "refundedAt": null
      },
      "completedAt": null,
      "createdAt": "2026-10-22T08:10:05.000Z",
      "updatedAt": "2026-10-22T08:10:05.000Z",
      "actions": {
        "canViewReceipt": true,
        "refundEligibleNow": false
      }
    },
    {
      "id": "b6a7b8c9-0000-1111-2222-333344445555",
      "title": "Call Consultation • 15 min",
      "status": "COMPLETED",
      "statusGroup": "COMPLETED",
      "statusLabel": "Completed",
      "callType": "CALL",
      "durationMinutes": 15,
      "price": 199,
      "currency": "INR",
      "contact": {
        "phoneNumber": "9876543210",
        "email": "user@example.com"
      },
      "payment": {
        "status": "PAID",
        "amount": 199,
        "paidAt": "2026-10-15T09:00:00.000Z",
        "razorpayOrderId": "order_OXXXXX999999",
        "razorpayPaymentId": "pay_PXXXXX999999",
        "refundEligibleAt": "2026-10-24T18:29:59.000Z",
        "refundedAt": null
      },
      "completedAt": "2026-10-15T10:30:00.000Z",
      "createdAt": "2026-10-15T09:00:05.000Z",
      "updatedAt": "2026-10-15T10:30:00.000Z",
      "actions": {
        "canViewReceipt": true,
        "refundEligibleNow": false
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 2,
    "totalPages": 1,
    "hasNextPage": false
  },
  "counts": {
    "ALL": 2,
    "UPCOMING": 1,
    "PROCESSING": 0,
    "COMPLETED": 1,
    "REFUNDED": 0
  }
}
```

### 4.2 `PAYMENT_PROCESSING` Item Sample (in List or Detail)
```json
{
  "id": "pay_uuid_12345678-aaaa-bbbb-cccc-ddddeeeeffff",
  "title": "Video Call Consultation • 30 min",
  "status": "PAYMENT_PROCESSING",
  "statusGroup": "PROCESSING",
  "statusLabel": "Payment processing – don't pay again",
  "callType": "VIDEO_CALL",
  "durationMinutes": 30,
  "price": 899,
  "currency": "INR",
  "contact": {
    "phoneNumber": "9876543210",
    "email": "user@example.com"
  },
  "payment": {
    "status": "PROCESSING",
    "amount": 899,
    "paidAt": null,
    "razorpayOrderId": "order_OXXXXXprocessing",
    "razorpayPaymentId": "pay_PXXXXXattempt1",
    "refundEligibleAt": null,
    "refundedAt": null
  },
  "completedAt": null,
  "createdAt": "2026-10-22T09:00:00.000Z",
  "updatedAt": "2026-10-22T09:01:00.000Z",
  "actions": {
    "canViewReceipt": false,
    "refundEligibleNow": false
  }
}
```

### 4.3 `GET /api/user/bookings/:id` (Detail with Timeline)
**Request:**
```http
GET /api/user/bookings/c7a8b9c0-1111-2222-3333-444455556666
Authorization: Bearer <USER_JWT>
```
**Response (200 OK):**
```json
{
  "success": true,
  "booking": {
    "id": "c7a8b9c0-1111-2222-3333-444455556666",
    "title": "Video Call Consultation • 30 min",
    "status": "CONFIRMED",
    "statusGroup": "UPCOMING",
    "statusLabel": "Confirmed – our team will call you",
    "callType": "VIDEO_CALL",
    "durationMinutes": 30,
    "price": 899,
    "currency": "INR",
    "contact": {
      "phoneNumber": "9876543210",
      "email": "user@example.com"
    },
    "payment": {
      "status": "PAID",
      "amount": 899,
      "paidAt": "2026-10-22T08:10:00.000Z",
      "razorpayOrderId": "order_OXXXXX123456",
      "razorpayPaymentId": "pay_PXXXXX123456",
      "refundEligibleAt": "2026-10-31T18:29:59.000Z",
      "refundedAt": null
    },
    "completedAt": null,
    "createdAt": "2026-10-22T08:10:05.000Z",
    "updatedAt": "2026-10-22T08:10:05.000Z",
    "actions": {
      "canViewReceipt": true,
      "refundEligibleNow": false
    },
    "timeline": [
      {
        "at": "2026-10-22T08:10:00.000Z",
        "event": "PAYMENT_PAID"
      },
      {
        "at": "2026-10-22T08:10:05.000Z",
        "event": "BOOKING_CONFIRMED"
      }
    ]
  }
}
```

---

## 5. Potential Risks & Mitigations

1. **Information Leakage across Users:**
   - *Risk:* User probing booking IDs might see whether an ID exists belonging to someone else.
   - *Mitigation:* Always enforce `userId` filtering directly in the Prisma query. Return uniform 404 `"Booking not found."` regardless of whether the ID belongs to another user or does not exist at all.
2. **N+1 Query Overhead:**
   - *Risk:* Loading payments or payment attempts in a loop could slow down responses.
   - *Mitigation:* Load `payment: { include: { attempts: true } }` directly inside the primary `prisma.consultancyRequest.findMany` call in a single SQL join/batched query.
3. **Database Performance & Indexes:**
   - *Verification:* Verified `schema.prisma`. Both `ConsultancyRequest` and `Payment` already contain indexed `userId` columns (`@@index([userId])`), providing optimal filter speeds.
4. **Impact on Existing Routes:**
   - *Risk:* Colliding with `GET /api/user/consultancy` or other `/api/user/*` routes.
   - *Mitigation:* `myBookings.routes.js` is mounted at `/api/user/bookings`, leaving `/api/user/consultancy` completely untouched and unaffected.

---

## 6. Answers to OPEN QUESTIONS

### Question 1: Processing payments — include `PAYMENT_PROCESSING` items in My Bookings?
- **Recommendation:** **YES (Include them, default behavior).**
- **Rationale:**
  - When a user authorizes payment via Netbanking or UPI, the gateway can take several minutes to settle and emit the webhook. During this window, the payment status is `PROCESSING`, but no `ConsultancyRequest` row exists yet.
  - If "My Bookings" only showed `ConsultancyRequest` rows, the user would see an empty screen or assume their booking failed, leading them to pay a second time.
  - Including `PAYMENT_PROCESSING` with `statusLabel: "Payment processing – don't pay again"` provides immediate feedback, prevents accidental double payments, and seamlessly transitions to `CONFIRMED` once the webhook or verify call fires.
  - Checkouts in `CREATED` with 0 attempts, `FAILED`, or `EXPIRED` status remain strictly in "My Payments" to avoid cluttering active bookings.

### Question 2: Cancel booking — should the user get a "Cancel booking" action later?
- **Recommendation:** **NOT in this task (Future scope only).**
- **Rationale:**
  - Under current platform business logic, consultations involve fixed scheduling SLAs and administrative review. Refunds are subject to the 7 working-day SLA and can only be executed by administrators (`POST /api/admin/payments/:id/refund`).
  - Allowing user-initiated cancellations requires establishing refund policies, cancellation fees, advocate notifications, and automatic Razorpay reverse-transfers.
  - `actions.refundEligibleNow` provides informational visibility without exposing an unsupported self-service refund/cancellation endpoint.
