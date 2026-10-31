# Migration & Implementation Plan: Advocate Pricing (Per 15 Min & Office Visit Duration)

## Database Host
**Neon PostgreSQL Host:** `ep-weathered-hat-b47xszyr-pooler.c-6.us-east-2.aws.neon.tech`  
**Database Name:** `neondb`

---

## 1. Exhaustive Usage List (`file:line`)

### Current Column Types
In PostgreSQL (`Advocate` & `DeletedAdvocate` tables):
- `voiceCallChargePerMinute`: `DECIMAL(65,30)` (`Decimal?` in Prisma)
- `videoCallChargePerMinute`: `DECIMAL(65,30)` (`Decimal?` in Prisma)
- `offlineVisitingFee`: `DECIMAL(65,30)` (`Decimal?` in Prisma)

### All References Across Codebase

#### A. `voiceCallChargePerMinute`
- `prisma/schema.prisma:197` — `DeletedAdvocate.voiceCallChargePerMinute Decimal?`
- `prisma/schema.prisma:257` — `Advocate.voiceCallChargePerMinute Decimal?`
- `prisma/seed.js:301, 332, 363, 394, 425, 456, 573, 1869, 1909` — Seed advocate pricing
- `src/services/advocateBooking/pricing.js:58, 61` — Per-minute pricing calculation
- `src/services/advocateBooking/advocateBooking.service.js:34` — Select in `getAdvocateBookingOptions`
- `src/services/advocateDeletion.service.js:128` — Copy to `DeletedAdvocate`
- `src/services/advocate.service.js:187` — Select in `listAdvocates`
- `src/services/advocate.service.js:436` — Return in advocate detail response
- `src/services/savedLawyer.service.js:75` — Saved lawyer response mapping
- `src/services/advocateLike.service.js:136` — Liked advocate response mapping
- `src/services/auth.service.js:946` — Advocate profile mapping in `getCurrentUserProfile`
- `src/controllers/admin.controller.js:962, 963, 964` — Direct advocate update in `adminUpdateAdvocate`
- `src/controllers/admin.controller.js:982` — `decimalFields` array for change detection
- `src/controllers/admin.controller.js:1597` — `scalarFields` for profile-change approval
- `src/controllers/advocate.profile.controller.js:13` — `APPROVAL_FIELDS` list
- `src/controllers/advocate.profile.controller.js:32` — `FIELD_LABELS` map
- `src/controllers/advocate.profile.controller.js:154` — `isEqualValue` decimal comparison
- `src/controllers/advocate.profile.controller.js:482` — Alias normalization `voiceChargePerMinute`
- `src/controllers/advocate.profile.controller.js:490` — `approvalScalarKeys` list
- `src/controllers/advocate.profile.controller.js:857` — Return in `getProfileApprovalStatus`
- `src/validators/advocate.validator.js:266` — Validation schema
- `src/validators/advocate.validator.js:280` — Alias `voiceChargePerMinute`
- `tests/advocateProfileChange.test.js:483, 488` — Unit test mock data
- `README.md:863, 886, 904, 931, 967, 1497, 1537, 1926, 3200, 4317, 4791, 10442, 11895, 12581, 12691, 12888`

#### B. `videoCallChargePerMinute`
- `prisma/schema.prisma:196` — `DeletedAdvocate.videoCallChargePerMinute Decimal?`
- `prisma/schema.prisma:256` — `Advocate.videoCallChargePerMinute Decimal?`
- `prisma/seed.js:300, 331, 362, 393, 424, 455, 572, 1868, 1908` — Seed pricing
- `src/services/advocateBooking/pricing.js:65, 68` — Pricing calculation
- `src/services/advocateBooking/advocateBooking.service.js:35` — Select in `getAdvocateBookingOptions`
- `src/services/advocateDeletion.service.js:127` — Copy to `DeletedAdvocate`
- `src/services/advocate.service.js:186` — Select in `listAdvocates`
- `src/services/advocate.service.js:435` — Return in advocate detail response
- `src/services/savedLawyer.service.js:74` — Saved lawyer response mapping
- `src/services/advocateLike.service.js:135` — Liked advocate response mapping
- `src/services/auth.service.js:945` — Profile mapping in `getCurrentUserProfile`
- `src/controllers/admin.controller.js:956, 957, 958` — Update in `adminUpdateAdvocate`
- `src/controllers/admin.controller.js:982` — `decimalFields` array
- `src/controllers/admin.controller.js:1597` — `scalarFields` array
- `src/controllers/advocate.profile.controller.js:12` — `APPROVAL_FIELDS`
- `src/controllers/advocate.profile.controller.js:31` — `FIELD_LABELS`
- `src/controllers/advocate.profile.controller.js:154` — `isEqualValue`
- `src/controllers/advocate.profile.controller.js:481` — Alias normalization `videoChargePerMinute`
- `src/controllers/advocate.profile.controller.js:490` — `approvalScalarKeys`
- `src/controllers/advocate.profile.controller.js:856` — Return in `getProfileApprovalStatus`
- `src/validators/advocate.validator.js:265` — Validation schema
- `src/validators/advocate.validator.js:279` — Alias `videoChargePerMinute`
- `tests/advocateProfileChange.test.js:163, 183, 195, 243, 255, 265, 303, 406, 437, 454, 484, 489`
- `README.md:862, 885, 903, 930, 967, 1496, 1536, 1925, 3199, 4316, 4790, 10442, 11896, 12581, 12691, 12721, 12749, 12769`

#### C. `offlineVisitingFee`
- `prisma/schema.prisma:198` — `DeletedAdvocate.offlineVisitingFee Decimal?`
- `prisma/schema.prisma:258` — `Advocate.offlineVisitingFee Decimal?`
- `prisma/seed.js:302, 333, 364, 395, 426, 457, 574, 1870, 1910`
- `src/services/advocateBooking/pricing.js:72, 75`
- `src/services/advocateBooking/advocateBooking.service.js:36`
- `src/services/advocateDeletion.service.js:129`
- `src/services/advocate.service.js:188, 437`
- `src/services/savedLawyer.service.js:76`
- `src/services/advocateLike.service.js:137`
- `src/services/auth.service.js:947`
- `src/controllers/admin.controller.js:936, 982, 1598`
- `src/controllers/advocate.profile.controller.js:14, 33, 154, 491, 858`
- `src/validators/advocate.validator.js:267`
- `tests/advocateProfileChange.test.js:485, 490`
- `README.md:864, 887, 905, 932, 967, 1498, 1538, 1927, 3201, 4318, 4792, 10441, 11897, 12581, 12691, 12889`

#### D. `inPersonMinutes`
- `src/services/advocateBooking/advocateBooking.service.js:50` — `parseInt(process.env.ADVOCATE_IN_PERSON_MINUTES || '60', 10)`
- `src/services/advocateBooking/advocateBooking.service.js:66` — Returned in options

#### E. `slotMinutes`
- `src/services/advocateBooking/slotValidation.js:35, 56, 58` — 15-minute grid alignment
- `src/services/advocateBooking/advocateBooking.service.js:49, 65` — Options response

---

## 2. Read-Only Aggregate Queries (DB Inspection)

The following read-only SQL queries will be run to inspect existing data:

```sql
-- 1. Count advocates with fees set
SELECT 
  count(*) AS total_advocates,
  count("voiceCallChargePerMinute") AS with_voice_fee,
  count("videoCallChargePerMinute") AS with_video_fee,
  count("offlineVisitingFee") AS with_offline_fee
FROM "Advocate";

-- 2. Count drafts containing legacy keys
SELECT 
  count(*) FILTER (WHERE "pendingProfileChange" IS NOT NULL AND "pendingProfileChange"::jsonb ? 'voiceCallChargePerMinute') AS drafts_with_voice,
  count(*) FILTER (WHERE "pendingProfileChange" IS NOT NULL AND "pendingProfileChange"::jsonb ? 'videoCallChargePerMinute') AS drafts_with_video,
  count(*) FILTER (WHERE "pendingProfileChange" IS NOT NULL AND "pendingProfileChange"::jsonb ? 'offlineVisitingFee') AS drafts_with_offline
FROM "Advocate";
```

*(Note: Execution is purely read-only and uses aggregates only).*

---

## 3. Design & Architecture

### A. Data Model (`schema.prisma`)
Add to `Advocate` and `DeletedAdvocate`:
```prisma
model Advocate {
  ...
  /// DEPRECATED — unused, dropped in phase B
  videoCallChargePerMinute    Decimal?
  /// DEPRECATED — unused, dropped in phase B
  voiceCallChargePerMinute    Decimal?
  offlineVisitingFee          Decimal?
  voiceCallPricePer15Min      Decimal?
  videoCallPricePer15Min      Decimal?
  officeVisitDurationMinutes  Int?
  ...
}

model DeletedAdvocate {
  ...
  /// DEPRECATED — unused, dropped in phase B
  videoCallChargePerMinute    Decimal?
  /// DEPRECATED — unused, dropped in phase B
  voiceCallChargePerMinute    Decimal?
  offlineVisitingFee          Decimal?
  voiceCallPricePer15Min      Decimal?
  videoCallPricePer15Min      Decimal?
  officeVisitDurationMinutes  Int?
  ...
}
```

### B. Pricing Math (`pricing.js`)
- Voice call:
  - If `voiceCallPricePer15Min` is null or <= 0: mode not offered (`null`).
  - `fee = voiceCallPricePer15Min * (slotMinutes / 15)`. With default `slotMinutes = 15`, `fee = voiceCallPricePer15Min`.
  - `feePaise = Math.round(fee * 100)`.
- Video call:
  - If `videoCallPricePer15Min` is null or <= 0: mode not offered (`null`).
  - `fee = videoCallPricePer15Min * (slotMinutes / 15)`. With default `slotMinutes = 15`, `fee = videoCallPricePer15Min`.
  - `feePaise = Math.round(fee * 100)`.
- In-person (Office visit):
  - If `offlineVisitingFee` or `officeVisitDurationMinutes` is null or <= 0: mode not offered (`null`).
  - `fee = offlineVisitingFee`, `durationMinutes = advocate.officeVisitDurationMinutes`.
  - `feePaise = Math.round(fee * 100)`.
- Single paise rounding:
  - `gstPercent = 18`
  - `gstPaise = Math.round((feePaise * 18) / 100)`
  - `platformFeePaise = 2500` (₹25)
  - `totalPaise = feePaise + gstPaise + platformFeePaise`
  - `fee = feePaise / 100`, `gst = gstPaise / 100`, `platformFee = 25`, `total = totalPaise / 100`
  - `priceLabel`: e.g., `"₹510 / 15 min"`, `"₹1,000 / 45 min"`

### C. Booking & Slot Alignment (`slotValidation.js` + `advocateBooking.service.js`)
- **Grid alignment:** `startAt` must always fall on a 15-minute grid (`minute % 15 === 0`, `seconds === 0`, `ms === 0`) for **all modes** (including `IN_PERSON`).
- **Slot duration & endAt:**
  - `endAt = new Date(startAt.getTime() + durationMinutes * 60 * 1000)`.
  - For office visit, `durationMinutes` is the advocate's `officeVisitDurationMinutes` (e.g. 37 min, 45 min, 60 min).
- **Overlap check:**
  - `startAt: { lt: endAt }, endAt: { gt: startAt }`.
  - The interval check in `isSlotFree` already checks `startAt < requestedEnd && endAt > requestedStart`, which works seamlessly with variable-length slots without assuming any fixed length!
- **Snapshot in `AdvocateBooking`:**
  - `AdvocateBooking` already permanently stores `durationMinutes`, `startAt`, `endAt`, `feePaise`, `gstPercent`, `gstPaise`, `platformFeePaise`, `totalPaise`.
  - `ratePerMinutePaise` will simply be `null` for new bookings. Existing bookings remain completely unaffected.

### D. Validation Rules (`advocate.validator.js` & `admin.validator.js`)
- **Old fields rejected:**
  - If `voiceCallChargePerMinute` or `voiceChargePerMinute` is present in body -> 400 `"voiceCallChargePerMinute is no longer supported. Use voiceCallPricePer15Min."`
  - If `videoCallChargePerMinute` or `videoChargePerMinute` is present in body -> 400 `"videoCallChargePerMinute is no longer supported. Use videoCallPricePer15Min."`
- **New fields accepted:**
  - `voiceCallPricePer15Min`: positive number, at most 2 decimals, or `null`.
  - `videoCallPricePer15Min`: positive number, at most 2 decimals, or `null`.
  - `offlineVisitingFee`: positive number, at most 2 decimals, or `null`.
  - `officeVisitDurationMinutes`: integer, 1 to 1440, or `null`.
- **Razorpay Upper Limit Check:**
  - Max total payable per payment = ₹5,00,000 (from `process.env.RAZORPAY_MAX_PAYMENT_AMOUNT_RUPEES || 500000`).
  - `price + (price * 0.18) + 25 <= 500000` -> `price <= (500000 - 25) / 1.18 = ~423,707.62`.
- **Pair Rule for Office Visit:**
  - `offlineVisitingFee` and `officeVisitDurationMinutes` must be both set (positive), or both null.
  - In `PATCH /api/advocate/profile`, the validation is performed against the **merged state** (payload merged with currently saved DB values). If an advocate sends only duration, but fee is already saved in DB (or vice versa), the pair is valid. If duration is sent with no fee saved and no fee sent, 400 is returned.

### E. Profile Change Approval
- Approval fields:
  - `voiceCallPricePer15Min`, `videoCallPricePer15Min`, `offlineVisitingFee`, `officeVisitDurationMinutes`.
  - Old per-minute keys removed from `APPROVAL_FIELDS` and `approvalScalarKeys`.
- Human labels:
  - `voiceCallPricePer15Min`: `'Voice call price (15 min)'`
  - `videoCallPricePer15Min`: `'Video call price (15 min)'`
  - `offlineVisitingFee`: `'Office visit price'`
  - `officeVisitDurationMinutes`: `'Office visit duration (min)'`

### F. Pricing Helper Response Object
Everywhere advocate profile / detail / options are returned:
```json
"pricing": {
  "voiceCall": { "price": 510, "durationMinutes": 15, "label": "₹510 / 15 min" },
  "videoCall": { "price": 700, "durationMinutes": 15, "label": "₹700 / 15 min" },
  "officeVisit": { "price": 1000, "durationMinutes": 45, "label": "₹1,000 / 45 min" }
}
```
If a mode is not offered (fee is null or duration is null), that mode in `pricing` is `null`.

---

## 4. Full Phase A Migration SQL

File: `prisma/migrations/20261031120000_advocate_pricing_per_15_min/migration.sql`

```sql
-- AlterTable Advocate: Add new pricing and duration columns
ALTER TABLE "Advocate" 
  ADD COLUMN "voiceCallPricePer15Min" DECIMAL(65,30),
  ADD COLUMN "videoCallPricePer15Min" DECIMAL(65,30),
  ADD COLUMN "officeVisitDurationMinutes" INTEGER;

-- AlterTable DeletedAdvocate: Add new pricing and duration columns for snapshot integrity
ALTER TABLE "DeletedAdvocate" 
  ADD COLUMN "voiceCallPricePer15Min" DECIMAL(65,30),
  ADD COLUMN "videoCallPricePer15Min" DECIMAL(65,30),
  ADD COLUMN "officeVisitDurationMinutes" INTEGER;

-- Data copy for Advocate: voiceCallPricePer15Min = voiceCallChargePerMinute * 15
UPDATE "Advocate" 
  SET "voiceCallPricePer15Min" = "voiceCallChargePerMinute" * 15
  WHERE "voiceCallChargePerMinute" IS NOT NULL AND "voiceCallPricePer15Min" IS NULL;

-- Data copy for Advocate: videoCallPricePer15Min = videoCallChargePerMinute * 15
UPDATE "Advocate" 
  SET "videoCallPricePer15Min" = "videoCallChargePerMinute" * 15
  WHERE "videoCallChargePerMinute" IS NOT NULL AND "videoCallPricePer15Min" IS NULL;

-- Data copy for Advocate: officeVisitDurationMinutes = 60 if offlineVisitingFee is set
UPDATE "Advocate" 
  SET "officeVisitDurationMinutes" = 60
  WHERE "offlineVisitingFee" IS NOT NULL AND "officeVisitDurationMinutes" IS NULL;

-- Data copy for DeletedAdvocate snapshot
UPDATE "DeletedAdvocate" 
  SET "voiceCallPricePer15Min" = "voiceCallChargePerMinute" * 15
  WHERE "voiceCallChargePerMinute" IS NOT NULL AND "voiceCallPricePer15Min" IS NULL;

UPDATE "DeletedAdvocate" 
  SET "videoCallPricePer15Min" = "videoCallChargePerMinute" * 15
  WHERE "videoCallChargePerMinute" IS NOT NULL AND "videoCallPricePer15Min" IS NULL;

UPDATE "DeletedAdvocate" 
  SET "officeVisitDurationMinutes" = 60
  WHERE "offlineVisitingFee" IS NOT NULL AND "officeVisitDurationMinutes" IS NULL;

-- Update pendingProfileChange in drafts: voiceCallChargePerMinute -> voiceCallPricePer15Min (* 15)
UPDATE "Advocate"
  SET "pendingProfileChange" = (
    ("pendingProfileChange"::jsonb - 'voiceCallChargePerMinute' - 'voiceChargePerMinute')
    || CASE
         WHEN "pendingProfileChange"::jsonb -> 'voiceCallChargePerMinute' IS NOT NULL 
              AND "pendingProfileChange"::jsonb ->> 'voiceCallChargePerMinute' IS NOT NULL
              AND jsonb_typeof("pendingProfileChange"::jsonb -> 'voiceCallChargePerMinute') <> 'null'
         THEN jsonb_build_object('voiceCallPricePer15Min', (("pendingProfileChange"::jsonb ->> 'voiceCallChargePerMinute')::numeric * 15))
         WHEN "pendingProfileChange"::jsonb -> 'voiceChargePerMinute' IS NOT NULL 
              AND "pendingProfileChange"::jsonb ->> 'voiceChargePerMinute' IS NOT NULL
              AND jsonb_typeof("pendingProfileChange"::jsonb -> 'voiceChargePerMinute') <> 'null'
         THEN jsonb_build_object('voiceCallPricePer15Min', (("pendingProfileChange"::jsonb ->> 'voiceChargePerMinute')::numeric * 15))
         ELSE jsonb_build_object('voiceCallPricePer15Min', null)
       END
  )
  WHERE "pendingProfileChange" IS NOT NULL 
    AND ("pendingProfileChange"::jsonb ? 'voiceCallChargePerMinute' OR "pendingProfileChange"::jsonb ? 'voiceChargePerMinute');

-- Update pendingProfileChange in drafts: videoCallChargePerMinute -> videoCallPricePer15Min (* 15)
UPDATE "Advocate"
  SET "pendingProfileChange" = (
    ("pendingProfileChange"::jsonb - 'videoCallChargePerMinute' - 'videoChargePerMinute')
    || CASE
         WHEN "pendingProfileChange"::jsonb -> 'videoCallChargePerMinute' IS NOT NULL 
              AND "pendingProfileChange"::jsonb ->> 'videoCallChargePerMinute' IS NOT NULL
              AND jsonb_typeof("pendingProfileChange"::jsonb -> 'videoCallChargePerMinute') <> 'null'
         THEN jsonb_build_object('videoCallPricePer15Min', (("pendingProfileChange"::jsonb ->> 'videoCallChargePerMinute')::numeric * 15))
         WHEN "pendingProfileChange"::jsonb -> 'videoChargePerMinute' IS NOT NULL 
              AND "pendingProfileChange"::jsonb ->> 'videoChargePerMinute' IS NOT NULL
              AND jsonb_typeof("pendingProfileChange"::jsonb -> 'videoChargePerMinute') <> 'null'
         THEN jsonb_build_object('videoCallPricePer15Min', (("pendingProfileChange"::jsonb ->> 'videoChargePerMinute')::numeric * 15))
         ELSE jsonb_build_object('videoCallPricePer15Min', null)
       END
  )
  WHERE "pendingProfileChange" IS NOT NULL 
    AND ("pendingProfileChange"::jsonb ? 'videoCallChargePerMinute' OR "pendingProfileChange"::jsonb ? 'videoChargePerMinute');

-- Backfill draft officeVisitDurationMinutes to 60 if offlineVisitingFee is drafted without duration
UPDATE "Advocate"
  SET "pendingProfileChange" = "pendingProfileChange"::jsonb || jsonb_build_object('officeVisitDurationMinutes', 60)
  WHERE "pendingProfileChange" IS NOT NULL
    AND "pendingProfileChange"::jsonb ? 'offlineVisitingFee'
    AND jsonb_typeof("pendingProfileChange"::jsonb -> 'offlineVisitingFee') <> 'null'
    AND NOT ("pendingProfileChange"::jsonb ? 'officeVisitDurationMinutes');
```

---

## 5. Files to Change (Existing Code Flow Only)

1. `prisma/schema.prisma`
   - Add `voiceCallPricePer15Min Decimal?`, `videoCallPricePer15Min Decimal?`, `officeVisitDurationMinutes Int?` to `Advocate` and `DeletedAdvocate`.
   - Mark `voiceCallChargePerMinute` and `videoCallChargePerMinute` with `/// DEPRECATED — unused, dropped in phase B`.
2. `src/services/advocateBooking/pricing.js`
   - Update `calculatePricing`, `getModeDurationMinutes`, `quote`, `getBookableModes`.
   - Add helper `formatPricingObject(advocate)`.
   - Calculate fees using `pricePer15Min` (slotMinutes / 15) and advocate's `officeVisitDurationMinutes`.
3. `src/services/advocateBooking/slotValidation.js`
   - Pass duration to `validateStart(mode, startAtInput, durationMinutes)`.
   - Enforce 15-minute grid alignment for all modes.
4. `src/services/advocateBooking/advocateBooking.service.js`
   - Update `getAdvocateBookingOptions` to select new fields, return `inPersonMinutes: advocate.officeVisitDurationMinutes || 60`, `pricing`, and individual fee fields.
   - Update `quoteBookingSlot` and `createAdvocateBookingCheckout` to pass custom duration into `validateStart`.
5. `src/validators/advocate.validator.js`
   - Add new fields: `voiceCallPricePer15Min`, `videoCallPricePer15Min`, `offlineVisitingFee`, `officeVisitDurationMinutes`.
   - Intercept old per-minute fields and reject with 400.
   - Enforce technical sanity (decimals <= 2, positive, Razorpay max).
   - Enforce office-visit pair rule.
6. `src/validators/admin.validator.js`
   - Ensure `adminAdvocateProfileUpdateSchema` inherits the new fields, validations, and rejection of old fields.
7. `src/controllers/advocate.profile.controller.js`
   - Update `APPROVAL_FIELDS`, `FIELD_LABELS`, `isEqualValue`, `getProfile`, `updateProfile`, `getProfileApprovalStatus`.
   - Remove legacy per-minute fields from responses; include `pricing` object and new fields.
   - Pair-validation against DB-merged state for office visit.
8. `src/controllers/admin.controller.js`
   - Update `adminUpdateAdvocate`, `formatAdvocateReviewData`, `approveAdvocateProfileChange`.
   - Update `decimalFields` and `scalarFields`.
   - Reject old fields with 400.
9. `src/services/advocate.service.js`
   - Update `listAdvocates` and `formatAdvocateDetail` / `formatAdvocateListItem` to select and return new fields + `pricing` object, without legacy fields.
10. `src/services/auth.service.js`
    - Update `getCurrentUserProfile` for advocate role to return new fields + `pricing`.
11. `src/services/savedLawyer.service.js` & `src/services/advocateLike.service.js`
    - Update advocate formatting to return new fields + `pricing`.
12. `src/services/advocateDeletion.service.js`
    - Copy new fields to `DeletedAdvocate`.
13. `prisma/seed.js`
    - Replace old per-minute values with `voiceCallPricePer15Min = old * 15`, `videoCallPricePer15Min = old * 15`, `officeVisitDurationMinutes = 60`.
14. `tests/advocateProfileChange.test.js`
    - Update test fixtures to use the new fields.
    - Add comprehensive unit tests (stubbed Prisma) for pricing calculations, slot alignment, overlap check, pair validation, draft approval, and snapshot preservation.
15. `README.md`
    - Update all request/response samples, section 32, approval fields, and add the new "Advocate pricing" subsection.

---

## 6. Before / After Samples

### Profile Response (`GET /api/advocate/profile` & Public Advocate Detail)
**Before:**
```json
{
  "voiceCallChargePerMinute": 34.0,
  "videoCallChargePerMinute": 46.67,
  "offlineVisitingFee": 1000.0
}
```

**After:**
```json
{
  "voiceCallPricePer15Min": 510.0,
  "videoCallPricePer15Min": 700.0,
  "offlineVisitingFee": 1000.0,
  "officeVisitDurationMinutes": 45,
  "pricing": {
    "voiceCall": { "price": 510.0, "durationMinutes": 15, "label": "₹510 / 15 min" },
    "videoCall": { "price": 700.0, "durationMinutes": 15, "label": "₹700 / 15 min" },
    "officeVisit": { "price": 1000.0, "durationMinutes": 45, "label": "₹1,000 / 45 min" }
  }
}
```

### Booking Quote Breakdown (`POST /api/advocate-bookings/quote`)
**Before (Voice Call):**
```json
{
  "fee": 510.0,
  "feePaise": 51000,
  "ratePerMinute": 34.0,
  "ratePerMinutePaise": 3400,
  "gst": 91.8,
  "gstPaise": 9180,
  "platformFee": 25,
  "platformFeePaise": 2500,
  "total": 626.8,
  "totalPaise": 62680
}
```

**After (Voice Call):**
```json
{
  "mode": "VOICE_CALL",
  "label": "Voice Call",
  "priceLabel": "₹510 / 15 min",
  "durationMinutes": 15,
  "fee": 510.0,
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

### Profile Update Request (`PATCH /api/advocate/profile`)
**Sending Old Fields (Rejected):**
```json
{
  "voiceCallChargePerMinute": 30
}
```
**Response (400 Bad Request):**
```json
{
  "success": false,
  "message": "voiceCallChargePerMinute is no longer supported. Use voiceCallPricePer15Min."
}
```

---

## 7. Risks & Mitigations

1. **Precision / Decimal Rounding:**
   - *Risk:* Old per-minute prices with fractions (e.g. 33.33 × 15 = 499.95) could result in odd pricing.
   - *Mitigation:* `DECIMAL(65,30)` stores exact values. `Math.round(price * 100)` converts to exact integer paise once.
2. **Existing Bookings Consistency:**
   - *Risk:* Changing pricing logic could corrupt historical appointment receipts or ongoing appointments.
   - *Mitigation:* `AdvocateBooking` already stores immutable financial snapshots (`feePaise`, `gstPaise`, `platformFeePaise`, `totalPaise`, `startAt`, `endAt`, `durationMinutes`). All displays and receipts read from the booking record directly.
3. **Office Visit Durations & Variable Slot Overlaps:**
   - *Risk:* Advocates setting arbitrary durations (e.g. 37 min) causing overlaps with standard 15-minute slots.
   - *Mitigation:* The availability check `startAt < slotEnd && endAt > slotStart` evaluates absolute datetime ranges. A 37-minute booking from 10:00 to 10:37 will correctly block any slot overlapping that range.
4. **Draft Migration Safety:**
   - *Risk:* Pending unapproved profile drafts in `pendingProfileChange` JSONB containing old keys.
   - *Mitigation:* Idempotent migration SQL migrates both `voiceCallChargePerMinute` and `videoCallChargePerMinute` to `* 15`, safely handling JSON nulls and stripping deprecated keys.

---

## 8. Answers to OPEN QUESTIONS

1. **In-person start times on the 15-min grid for any duration (e.g. 37 min → 10:00–10:37, next start 10:45): OK?**
   - **Answer:** **Yes**. All appointments (voice, video, and in-person) will start on the 15-minute grid (`:00`, `:15`, `:30`, `:45`). The slot duration will be the advocate's configured `officeVisitDurationMinutes`. The next bookable time on the 15-minute grid that does not overlap `[startAt, endAt)` will be available.
2. **Does anything else depend on a per-minute price (e.g. future billing by actual call minutes)? List it.**
   - **Answer:** **Nothing**. We searched the complete codebase. Consultancy packages use fixed prices (`consultancyPricing.js`). `AdvocateBooking` records store permanent integer paise totals. Call availability does not meter live per-minute calls. No other service depends on per-minute advocate rates.
3. **Old prices with decimals per minute (× 15 gives non-round prices like ₹502.50): keep the exact value?**
   - **Answer:** **Yes, keep the exact value**. PostgreSQL `DECIMAL(65,30)` and `numeric` preserve the exact value, and integer paise conversion `Math.round(price * 100)` avoids any floating point inaccuracy.

---

## 9. Deploy Order (to be documented in README)
1. Execute `prisma migrate deploy` to create the columns, copy `old * 15`, and migrate drafts. (Old application code continues working normally because old columns remain intact).
2. Deploy the backend and frontend together immediately.
3. Phase B (drop old columns) will occur in a separate task only after backup confirmation.
