# Implementation Plan: Advocate Profile Change Approval

## 0. Database Host Verification
- **DATABASE_URL Host:** `ep-weathered-hat-b47xszyr-pooler.c-6.us-east-2.aws.neon.tech`
- **Database / Path:** `/neondb`
> **SAFETY NOTICE:**
> - DB Host has been verified.
> - **Zero database writes, migrations, or Cloudinary uploads** have been executed.
> - Execution is stopped at STEP 0 awaiting your explicit typed `"approved"`.
> - After your approval, the migration SQL will be presented for your "OK" before running `migrate deploy`.
> - Never run integration tests or create test records against the shared Neon DB (production). All testing will use stubbed Prisma/Cloudinary unit tests.

---

## 1. Database Row Audit (`officeChangeStatus`)
We executed read-only queries against `ep-weathered-hat-b47xszyr-pooler.c-6.us-east-2.aws.neon.tech`:
- **Rows where `officeChangeStatus IS NOT NULL`:** `0` rows.
- **Rows where `pendingOfficeChange IS NOT NULL`:** `0` rows.
- **Result:** There are NO production or test records with active/historical `officeChangeStatus` or `pendingOfficeChange`. No data migration or conversion of pending office changes is required.

---

## 2. Current Codebase Behaviour & Findings

1. **`PATCH /api/advocate/profile` (`updateProfile`):**
   - Uses `advocateProfileUpdateSchema` which has `validateNoAddressOrOfficeFields`. It rejects `officeLatitude`, `officeLongitude`, `city`, `state`, `pincode`, `latitude`, `longitude`.
   - Allows direct scalar updates for `fullName`, `gender`, `barCouncilId`, `aadhaarNumber`, `email`, `about` / `bio`, `completeAddress`, `offlineVisitingFee`, `casesHandled`, `bestPracticeArea`, `topCourtPractised`, `practiceAreas`, `experienceYears` / `experience`, `videoCallChargePerMinute` / `videoChargePerMinute`, `voiceCallChargePerMinute` / `voiceChargePerMinute`, `languagesSpoken` / `languages`, `courtPractice`.
   - No approval gate: Approved advocates can currently change their fees, experience, and about directly.
   - Only accepts JSON (no `multer` middleware on `PATCH /`).

2. **`POST /api/advocate/profile/photo` (`uploadProfilePhoto`):**
   - Accepts multipart `profilePhoto` (`upload.single('profilePhoto')`), validates via `validateUploadedPhoto`.
   - Uploads directly to Cloudinary, updates `profilePhotoUrl` / `profilePhotoPublicId` immediately, and deletes the old live photo. No approval gate for approved advocates.

3. **`PUT /api/advocate/profile/office` (`requestOfficeChange`):**
   - Previously implemented as a separate endpoint for office updates.
   - For non-approved advocates: applied directly to live office fields.
   - For approved advocates: stored in `pendingOfficeChange` with `officeChangeStatus = 'PENDING'`.

4. **`POST /api/advocate/profile/submit-for-approval` (`submitForApproval`):**
   - Used only for initial profile submission.
   - If `advocate.approvalStatus === 'APPROVED'`, it returns `400 Bad Request` ("Profile is already approved.").

5. **Admin Office Change Endpoints:**
   - `GET /api/admin/advocates/office-changes` (`listOfficeChangeRequests`)
   - `GET /api/admin/advocates/:advocateId/office-change` (`getAdvocateOfficeChangeDetails`)
   - `POST /api/admin/advocates/:advocateId/office-change/approve` (`approveAdvocateOfficeChange`)
   - `POST /api/admin/advocates/:advocateId/office-change/reject` (`rejectAdvocateOfficeChange`)

6. **Advocate Bookings & Fees:**
   - `AdvocateBooking` records store complete price snapshots at creation time: `ratePerMinutePaise`, `feePaise`, `gstPercent`, `gstPaise`, `platformFeePaise`, `totalPaise` (stored in paise, currency INR).
   - `getAdvocateBookingOptions`, `quoteBookingSlot`, and `createAdvocateBookingCheckout` query the `Advocate` record live columns (`voiceCallChargePerMinute`, `videoCallChargePerMinute`, `offlineVisitingFee`).
   - Bookings already created keep their price snapshot permanently.
   - Public profile and listings (`listAdvocates`, `getAdvocateDetailsPublic`) only select live columns.

7. **Advocate Deletion (`advocateDeletion.service.js`):**
   - Cleans up `profilePhotoPublicId`, `officePhotoPublicId`, and `pendingOfficeChange.officePhotoPublicId`.

---

## 3. Adapted Architecture & Detailed Design

### 3.1 Field Classification
- **Approval Fields** (sensitive fields requiring admin review for an **APPROVED** advocate):
  1. `experienceYears` (alias `experience`)
  2. `about` (alias `bio`)
  3. `videoCallChargePerMinute` (alias `videoChargePerMinute`)
  4. `voiceCallChargePerMinute` (alias `voiceChargePerMinute`)
  5. `offlineVisitingFee`
  6. `profilePhoto` (file in multipart)
  7. `officeAddress`
  8. `pincode`
  9. `city`
  10. `state`
  11. `officeLatitude`
  12. `officeLongitude`
  13. `officePhoto` (file in multipart)
- **Direct Fields** (always live immediately, even for approved advocates):
  - `casesHandled`, `practiceAreas`, `practiceAreaIds`, `bestPracticeArea`, `topCourtPractised`, `courtPractice`, `languagesSpoken`, `languages`, `completeAddress`, `fullName`, `gender`.

---

### 3.2 Schema Additions (`Advocate` model in `prisma/schema.prisma`)
Add the following nullable columns (leaving old `officeChange*` columns untouched):
```prisma
pendingProfileChange         Json?      // { field: requestedValue, ... } only changed approval fields; photos as { url, publicId }
profileChangeStatus          String?    // null | "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED"
profileChangeUpdatedAt       DateTime?
profileChangeSubmittedAt     DateTime?
profileChangeReviewedAt      DateTime?
profileChangeRejectionReason String?
profileChangeReviewedBy      String?    // admin/staff id or "env-admin"
```

---

### 3.3 Edit Profile: Single Unified API (`PATCH /api/advocate/profile`)
1. **Route middleware:**
   - Add `upload.fields([{ name: 'profilePhoto', maxCount: 1 }, { name: 'officePhoto', maxCount: 1 }])` to `PATCH /api/advocate/profile`.
   - JSON bodies continue to work seamlessly (multer passes through non-multipart requests).
2. **Validation (`src/validators/advocate.validator.js`):**
   - **Remove `validateNoAddressOrOfficeFields`.**
   - Accept `officeAddress` (10–500 chars), `city` (2–100), `state` (2–100), `pincode` (6 digits), `officeLatitude`, `officeLongitude`.
   - Reject old `latitude` / `longitude` with `400 Bad Request`: `"Use officeLatitude/officeLongitude."`
   - Validate coordinate pairs: `officeLatitude` and `officeLongitude` must be provided together.
   - Validate location pairs: `pincode`, `city`, and `state` must be provided together when updating address.
   - Validate uploaded photos using `validateUploadedPhoto` (max 5MB, JPEG/PNG/WEBP).
   - Support numeric strings from `multipart/form-data` for numbers/integers (`experienceYears`, `casesHandled`, `videoCallChargePerMinute`, `voiceCallChargePerMinute`, `offlineVisitingFee`, `officeLatitude`, `officeLongitude`).
3. **Execution Logic:**
   - **Advocate NOT approved (`approvalStatus !== 'APPROVED'`):**
     - Direct save for all fields.
     - Files: upload to Cloudinary, replace live URL/publicId, and delete old live photo from Cloudinary after DB commit.
     - If office coordinates provided, also set `latitude = officeLatitude`, `longitude = officeLongitude`, `officeLocationUpdatedAt = now()`.
     - Return updated profile with message `"Profile updated successfully"`.
   - **Advocate IS approved (`approvalStatus === 'APPROVED'`):**
     - **Submitted Lock Check:** If `profileChangeStatus === 'SUBMITTED'`:
       - Reject the entire request with `409 Conflict`:
         `"Your profile changes are waiting for admin approval. Withdraw the request to edit again."`
     - Split request body & files into **direct fields** and **approval fields**.
     - If direct fields are present:
       - Update live advocate record directly in DB.
     - If approval fields are present:
       - Compare each requested approval field against the current live value:
         - Numerical fields: compare values (handling Decimal/number comparison).
         - String fields: trimmed equality comparison.
         - If a requested value is identical to the live value: omit it (or remove it from draft if it reverted to live).
       - Files: upload new photo to Cloudinary:
         - If the existing draft in `pendingProfileChange` already has that photo (`url`, `publicId`), delete the old draft photo from Cloudinary after DB commit.
         - Store `{ url, publicId }` in `pendingProfileChange`.
       - Merge changed fields into `pendingProfileChange`.
       - If the draft is not empty:
         - Set `profileChangeStatus = 'DRAFT'`.
         - Set `profileChangeUpdatedAt = now()`.
         - Clear `profileChangeRejectionReason = null` (starts a new draft if previously REJECTED).
       - If all requested fields matched live and the draft is now empty:
         - Set `pendingProfileChange = null`.
         - Set `profileChangeStatus = null`.
     - **Response:**
       - If only direct fields updated: `"Profile updated."`
       - If approval fields updated into draft: `"Changes saved as draft. Submit for approval to publish them."`
       - Include `profileChange` summary object in the response (see Section 3.6).

4. **`POST /api/advocate/profile/photo`:**
   - Keep route as an alias to `PATCH /api/advocate/profile` with `profilePhoto`.
   - If advocate is approved, uploads file to Cloudinary and saves into draft `pendingProfileChange.profilePhoto`.
   - If advocate is not approved, updates live photo directly.
   - Documented in README as an alias.

5. **`PUT /api/advocate/profile/office`:**
   - Removed completely from `advocate.profile.routes.js` and `advocate.profile.controller.js`.

---

### 3.4 Draft Lifecycle: Submit, Withdraw, Discard
1. **`POST /api/advocate/profile/submit-for-approval` (Extended):**
   - If advocate is NOT approved: retains existing profile verification submission logic unchanged.
   - If advocate IS approved:
     - Check: requires `profileChangeStatus === 'DRAFT'` and `pendingProfileChange` with at least one changed field.
     - If not met: return `400 Bad Request`: `"No changes to submit."`
     - Update:
       - `profileChangeStatus = 'SUBMITTED'`
       - `profileChangeSubmittedAt = new Date()`
     - Return `200 OK`: `"Changes sent for admin approval."`

2. **`POST /api/advocate/profile/changes/withdraw` (New route in existing file):**
   - Requires `profileChangeStatus === 'SUBMITTED'`.
   - If not SUBMITTED: return `409 Conflict`: `"No submitted changes to withdraw."`
   - Update:
     - `profileChangeStatus = 'DRAFT'`
   - Return `200 OK`: `"Profile change request withdrawn. You can now edit your draft."`

3. **`DELETE /api/advocate/profile/changes` (New route in existing file):**
   - If `profileChangeStatus === 'SUBMITTED'`: return `409 Conflict`: `"Withdraw first before discarding changes."`
   - If no draft or not approved: return `400 Bad Request`: `"No changes to discard."`
   - If `profileChangeStatus === 'DRAFT'` or `'REJECTED'`:
     - Delete draft photos from Cloudinary (`pendingProfileChange.profilePhoto.publicId`, `pendingProfileChange.officePhoto.publicId`).
     - Clear:
       - `pendingProfileChange = null`
       - `profileChangeStatus = null`
       - `profileChangeUpdatedAt = null`
       - `profileChangeSubmittedAt = null`
       - `profileChangeReviewedAt = null`
       - `profileChangeRejectionReason = null`
       - `profileChangeReviewedBy = null`
     - Return `200 OK`: `"Profile changes discarded."`

---

### 3.5 Admin Endpoints (Replacing Office-Change Endpoints)
Routes in `src/routes/admin.routes.js` (protected with `advocates:edit`, placed before `/:advocateId`):

1. **`GET /api/admin/advocates/profile-changes?status=SUBMITTED|APPROVED|REJECTED|ALL&page&limit&search`**
   - Default status: `SUBMITTED`.
   - Returns paginated list of advocates with profile change requests.
   - Each item includes:
     - `advocate`: `{ id, fullName, email, phone, barCouncilId, profilePhotoUrl }`
     - `changedFields`: array of field names changed (e.g. `["experienceYears", "about", "officeAddress"]`)
     - `submittedAt`: `profileChangeSubmittedAt`
     - `reviewedAt`: `profileChangeReviewedAt`
     - `status`: `profileChangeStatus`
     - `rejectionReason`: `profileChangeRejectionReason`
   - Summary counts: `counts: { SUBMITTED, APPROVED, REJECTED, total }`.

2. **`GET /api/admin/advocates/:advocateId/profile-change`**
   - Returns side-by-side comparison of current vs requested for only the changed fields:
     ```json
     {
       "success": true,
       "status": "SUBMITTED",
       "submittedAt": "2026-10-29T18:00:00.000Z",
       "reviewedAt": null,
       "rejectionReason": null,
       "changes": [
         { "field": "videoCallChargePerMinute", "label": "Video call fee (₹/min)", "current": 34, "requested": 40 },
         { "field": "about", "label": "About", "current": "Old bio...", "requested": "New bio..." },
         { "field": "officePhoto", "label": "Office photo", "current": "https://res.cloudinary.../live.jpg", "requested": "https://res.cloudinary.../draft.jpg" }
       ],
       "officeMapUrls": {
         "current": "https://www.google.com/maps?q=28.58,77.33",
         "requested": "https://www.google.com/maps?q=28.60,77.35"
       }
     }
     ```
   - Labels mapped user-friendly for all 13 approval fields.
   - `officeMapUrls` included if `officeLatitude` / `officeLongitude` are changed or present.
   - Never exposes Cloudinary `publicId`.

3. **`POST /api/admin/advocates/:advocateId/profile-change/approve`**
   - Requires `profileChangeStatus === 'SUBMITTED'` and non-empty `pendingProfileChange`; otherwise `409 Conflict`: `"No submitted profile changes."`
   - Database transaction:
     - Copy every requested scalar value to live fields.
     - If `officeLatitude` / `officeLongitude` changed: update `officeLatitude`, `officeLongitude`, `latitude`, `longitude`, `officeLocationUpdatedAt = now()`.
     - If `profilePhoto` changed: update `profilePhotoUrl`, `profilePhotoPublicId`.
     - If `officePhoto` changed: update `officePhotoUrl`, `officePhotoPublicId`.
     - Update status:
       - `profileChangeStatus = 'APPROVED'`
       - `profileChangeReviewedAt = now()`
       - `profileChangeReviewedBy = req.user.id || req.user.email || 'env-admin'`
       - `pendingProfileChange = null`
       - `profileChangeRejectionReason = null`
   - After transaction commits:
     - If `profilePhoto` was replaced and old live photo existed, delete old live photo from Cloudinary.
     - If `officePhoto` was replaced and old live photo existed, delete old live photo from Cloudinary.
   - Return `200 OK`: `"Profile changes approved successfully."`

4. **`POST /api/admin/advocates/:advocateId/profile-change/reject`**
   - Validates body `{ "reason": "..." }` with 5–500 chars string.
   - Requires `profileChangeStatus === 'SUBMITTED'`; otherwise `409 Conflict`.
   - Update:
     - `profileChangeStatus = 'REJECTED'`
     - `profileChangeRejectionReason = validated.reason`
     - `profileChangeReviewedAt = now()`
     - `profileChangeReviewedBy = req.user.id || req.user.email || 'env-admin'`
     - **Keeps `pendingProfileChange` intact** so the advocate sees what was rejected, edits, and resubmits.
     - Live fields remain untouched.
   - Return `200 OK`: `"Profile changes rejected."`

5. **Admin Advocate Details (`getAdvocateReviewProfile`):**
   - Include `profileChange: advocate.profileChangeStatus ? { status: advocate.profileChangeStatus, submittedAt: advocate.profileChangeSubmittedAt, changedFields: advocate.pendingProfileChange ? Object.keys(advocate.pendingProfileChange) : [] } : null`.
   - Allows the admin panel to display a "Changes pending approval" badge.

6. **Admin Edit Advocate (`updateAdvocateProfileByAdmin`):**
   - Continues direct editing. Does not interfere with any existing draft in `pendingProfileChange`.

7. **Remove Old Admin Office Change Routes & Controllers:**
   - Remove `listOfficeChangeRequests`, `getAdvocateOfficeChangeDetails`, `approveAdvocateOfficeChange`, `rejectAdvocateOfficeChange`.

---

### 3.6 Response Formatting
1. **`GET /api/advocate/profile`:**
   - Safe advocate live values + office details (same as today).
   - If advocate is approved and has `profileChangeStatus`:
     ```json
     "profileChange": {
       "status": "DRAFT",
       "updatedAt": "2026-10-29T18:00:00.000Z",
       "submittedAt": null,
       "reviewedAt": null,
       "rejectionReason": null,
       "changes": [
         { "field": "about", "label": "About", "current": "Old bio...", "requested": "New bio..." }
       ],
       "approvalFields": [
         "experienceYears", "about", "videoCallChargePerMinute", "voiceCallChargePerMinute",
         "offlineVisitingFee", "profilePhoto", "officeAddress", "pincode", "city",
         "state", "officeLatitude", "officeLongitude", "officePhoto"
       ]
     }
     ```
   - If advocate is not approved or has no draft/changes: `profileChange: null`.
2. **Public Advocate Listing & Profile (`listAdvocates`, `getAdvocateDetailsPublic`):**
   - Never exposes `pendingProfileChange`, `profileChange*`, or `*PublicId`.
   - Strictly reads live fields.
3. **Booking Endpoints (`booking-options`, `booking-quote`, `checkout`):**
   - Strictly read live fee columns (`voiceCallChargePerMinute`, `videoCallChargePerMinute`, `offlineVisitingFee`).
   - Price snapshots stored in paise at booking creation remain untouched.

---

### 3.7 Cleanup (`src/services/advocateDeletion.service.js`)
On permanent deletion:
- Delete live photos (`profilePhotoPublicId`, `officePhotoPublicId`).
- Delete draft photos if present:
  - `advocate.pendingProfileChange?.profilePhoto?.publicId`
  - `advocate.pendingProfileChange?.officePhoto?.publicId`
- Retain existing `pendingOfficeChange` cleanup for legacy safety.

---

## 4. Files to Change (Inside Existing Flow)

| File | Purpose of Change |
|---|---|
| `prisma/schema.prisma` | Add 7 nullable columns to model `Advocate` (`pendingProfileChange`, `profileChangeStatus`, `profileChangeUpdatedAt`, `profileChangeSubmittedAt`, `profileChangeReviewedAt`, `profileChangeRejectionReason`, `profileChangeReviewedBy`). |
| `src/routes/advocate.profile.routes.js` | Add `upload.fields` on `PATCH /`; add `POST /changes/withdraw` and `DELETE /changes`; remove `PUT /office`. |
| `src/validators/advocate.validator.js` | Remove `validateNoAddressOrOfficeFields`; restore office/address schemas to `advocateProfileUpdateSchema`; add rejection schema / coordinate pair validator; reject legacy `latitude`/`longitude`. |
| `src/controllers/advocate.profile.controller.js` | Implement draft diffing and merging on `PATCH /`; update `submitForApproval` to handle approved advocates; implement `withdrawProfileChanges`, `discardProfileChanges`; remove `requestOfficeChange`; format `profileChange` on `getProfile`. |
| `src/routes/admin.routes.js` | Replace 4 office-change routes with 4 profile-change routes (`/advocates/profile-changes`, `/:advocateId/profile-change`, `/:advocateId/profile-change/approve`, `/:advocateId/profile-change/reject`). |
| `src/validators/admin.validator.js` | Add `rejectProfileChangeSchema` (5–500 chars); remove/replace `rejectOfficeChangeSchema`. |
| `src/controllers/admin.controller.js` | Implement `listProfileChangeRequests`, `getAdvocateProfileChangeDetails`, `approveAdvocateProfileChange`, `rejectAdvocateProfileChange`; update `formatAdvocateReviewData` with `profileChange`; remove 4 office change methods. |
| `src/services/advocateDeletion.service.js` | Cleanup draft photos in `pendingProfileChange` on permanent deletion. |
| `README.md` | Rewrite section 34 / add section 35 with complete Postman guide, status flow diagram, examples, error table, booking fee policy, and removed endpoints. |

*No new routes, controllers, or service files will be created.* The only new folder will be the Prisma migration directory:
`prisma/migrations/20261029190000_advocate_profile_change_request/migration.sql`.

---

## 5. Migration SQL
Target migration folder: `prisma/migrations/20261029190000_advocate_profile_change_request/migration.sql`

```sql
-- AlterTable
ALTER TABLE "Advocate" ADD COLUMN     "pendingProfileChange" JSONB,
ADD COLUMN     "profileChangeRejectionReason" TEXT,
ADD COLUMN     "profileChangeReviewedAt" TIMESTAMP(3),
ADD COLUMN     "profileChangeReviewedBy" TEXT,
ADD COLUMN     "profileChangeStatus" TEXT,
ADD COLUMN     "profileChangeSubmittedAt" TIMESTAMP(3),
ADD COLUMN     "profileChangeUpdatedAt" TIMESTAMP(3);
```
- Only adds 7 nullable columns.
- Does not drop or rename any columns.
- Will be deployed only after your approval.

---

## 6. Request & Response Samples

### 6.1 Advocate Edits Profile (Multipart or JSON)
`PATCH /api/advocate/profile`
```http
Content-Type: multipart/form-data
Authorization: Bearer <advocate_jwt>

about: Experienced Supreme Court litigation advocate with 12+ years of high-stakes commercial arbitration experience across multiple high courts in India.
videoCallChargePerMinute: 40
officeAddress: 402, Supreme Enclave, Sector 18, Noida
pincode: 201301
city: Noida
state: Uttar Pradesh
officeLatitude: 28.5700
officeLongitude: 77.3200
languages: ["English", "Hindi"]
```
**Response (200 OK):**
```json
{
  "success": true,
  "message": "Changes saved as draft. Submit for approval to publish them.",
  "advocate": {
    "id": "e6a2b5...",
    "fullName": "Adv. Ramesh Sharma",
    "about": "Old live about text...",
    "videoCallChargePerMinute": 30,
    "languagesSpoken": ["English", "Hindi"],
    "profileChange": {
      "status": "DRAFT",
      "updatedAt": "2026-10-29T18:30:00.000Z",
      "submittedAt": null,
      "reviewedAt": null,
      "rejectionReason": null,
      "changes": [
        { "field": "about", "label": "About", "current": "Old live about text...", "requested": "Experienced Supreme Court litigation advocate..." },
        { "field": "videoCallChargePerMinute", "label": "Video call fee (₹/min)", "current": 30, "requested": 40 },
        { "field": "officeAddress", "label": "Office Address", "current": "101, Old Court Rd", "requested": "402, Supreme Enclave, Sector 18, Noida" }
      ],
      "approvalFields": [
        "experienceYears", "about", "videoCallChargePerMinute", "voiceCallChargePerMinute",
        "offlineVisitingFee", "profilePhoto", "officeAddress", "pincode", "city",
        "state", "officeLatitude", "officeLongitude", "officePhoto"
      ]
    }
  }
}
```

### 6.2 Advocate Submits Profile Changes for Approval
`POST /api/advocate/profile/submit-for-approval`
```json
// Response: 200 OK
{
  "success": true,
  "message": "Changes sent for admin approval."
}
```

### 6.3 Advocate Tries to Edit while SUBMITTED (Locked)
`PATCH /api/advocate/profile`
```json
// Response: 409 Conflict
{
  "success": false,
  "message": "Your profile changes are waiting for admin approval. Withdraw the request to edit again."
}
```

### 6.4 Advocate Withdraws Profile Changes
`POST /api/advocate/profile/changes/withdraw`
```json
// Response: 200 OK
{
  "success": true,
  "message": "Profile change request withdrawn. You can now edit your draft."
}
```

### 6.5 Advocate Discards Draft Changes
`DELETE /api/advocate/profile/changes`
```json
// Response: 200 OK
{
  "success": true,
  "message": "Profile changes discarded."
}
```

### 6.6 Admin List Profile Change Requests
`GET /api/admin/advocates/profile-changes?status=SUBMITTED`
```json
{
  "success": true,
  "data": [
    {
      "advocate": {
        "id": "e6a2b5...",
        "fullName": "Adv. Ramesh Sharma",
        "phone": "+919876543210",
        "email": "ramesh@example.com",
        "barCouncilId": "D/1234/2012",
        "profileImage": "https://res.cloudinary.../photo.jpg"
      },
      "changedFields": ["about", "videoCallChargePerMinute", "officeAddress"],
      "submittedAt": "2026-10-29T18:35:00.000Z",
      "status": "SUBMITTED"
    }
  ],
  "counts": {
    "SUBMITTED": 1,
    "APPROVED": 0,
    "REJECTED": 0,
    "total": 1
  },
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

### 6.7 Admin Detail View (Current vs Requested)
`GET /api/admin/advocates/:advocateId/profile-change`
```json
{
  "success": true,
  "status": "SUBMITTED",
  "submittedAt": "2026-10-29T18:35:00.000Z",
  "reviewedAt": null,
  "rejectionReason": null,
  "changes": [
    { "field": "videoCallChargePerMinute", "label": "Video call fee (₹/min)", "current": 30, "requested": 40 },
    { "field": "about", "label": "About", "current": "Old live about text...", "requested": "Experienced Supreme Court litigation advocate..." },
    { "field": "officeAddress", "label": "Office Address", "current": "101, Old Court Rd", "requested": "402, Supreme Enclave, Sector 18, Noida" }
  ],
  "officeMapUrls": {
    "current": "https://www.google.com/maps?q=28.58,77.33",
    "requested": "https://www.google.com/maps?q=28.57,77.32"
  }
}
```

### 6.8 Admin Approves Profile Changes
`POST /api/admin/advocates/:advocateId/profile-change/approve`
```json
// Response: 200 OK
{
  "success": true,
  "message": "Profile changes approved successfully."
}
```

### 6.9 Admin Rejects Profile Changes
`POST /api/admin/advocates/:advocateId/profile-change/reject`
```json
{
  "reason": "The uploaded office photo is blurry and does not show the office name board."
}
```
**Response (200 OK):**
```json
{
  "success": true,
  "message": "Profile changes rejected."
}
```

---

## 7. Risks & Mitigations

1. **Risk:** An approved advocate sends a multipart request updating both direct fields (`languages`) and approval fields (`videoCallChargePerMinute`) while `profileChangeStatus === 'SUBMITTED'`.
   - **Mitigation:** Reject the entire request with `409 Conflict`. Direct fields are not applied partially, avoiding unexpected partial state.
2. **Risk:** Draft photos uploaded to Cloudinary become orphaned if the advocate discards their draft or replaces the photo multiple times.
   - **Mitigation:**
     - On photo replacement in draft: immediately delete the superseded draft photo from Cloudinary after DB commit.
     - On `DELETE /api/advocate/profile/changes` (discard): delete draft photos from Cloudinary.
     - On account deletion: `advocateDeletion.service.js` deletes draft photos.
3. **Risk:** Booking quote or checkout reading draft fees instead of live fees.
   - **Mitigation:** Booking code queries `Advocate` scalar columns directly (`voiceCallChargePerMinute`, `videoCallChargePerMinute`, `offlineVisitingFee`). `pendingProfileChange` is never inspected in any booking code. Unit test will explicitly verify this guarantee.
4. **Risk:** Legacy `latitude` / `longitude` fields in body.
   - **Mitigation:** Strict validation explicitly rejects them with 400 "Use officeLatitude/officeLongitude."

---

## 8. Answers to OPEN QUESTIONS

1. **In one PATCH from an approved advocate that mixes direct and approval fields while SUBMITTED: reject the whole request (409)?**
   - **Recommendation: YES.** Rejecting the whole request keeps frontend error handling deterministic and simple. The advocate is clearly instructed: *"Your profile changes are waiting for admin approval. Withdraw the request to edit again."*
2. **Should the advocate get any notification (email) on approve/reject?**
   - **Recommendation: NO (Default).** Keep this task focused on the approval workflow and schema changes without introducing email delivery dependencies or templates.
3. **Anything in the existing code that already blocks approved advocates from editing some of these fields?**
   - **Finding:** Currently, approved advocates were ONLY blocked from editing office fields via `validateNoAddressOrOfficeFields`. Other fields (`experienceYears`, `about`, `videoCallChargePerMinute`, `voiceCallChargePerMinute`, `offlineVisitingFee`, `profilePhoto`) were NOT gated by approval status. Implementing this workflow properly gates all 13 approval fields behind admin review for approved advocates, while leaving non-approved advocates on direct updates.

---

## 9. Next Steps (Awaiting User Action)
We are stopped at **STEP 0**. Please review this plan and type **`approved`** to proceed to implementation.
