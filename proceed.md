# Implementation Plan: One Office per Advocate (Registration, Profile Cleanup, Admin Office Change Approval)

## 0. Database Host Verification
- **DATABASE_URL Host:** `ep-weathered-hat-b47xszyr-pooler.c-6.us-east-2.aws.neon.tech`
- **Database / Path:** `/neondb`
> **SAFETY NOTICE:** No database migrations, DB mutations, or Cloudinary uploads have been performed. Execution is stopped awaiting your explicit approval.

---

## 1. Current Codebase Behaviour & Findings

### Registration Flow Today
1. **Session & Steps:**
   - Registration begins at `POST /api/auth/advocate/register/start`.
   - `RegistrationSession` stores temporary registration progress (`fullName`, `email`, `phone`, `gender`, `profilePhotoUrl`, `profilePhotoPublicId`, `aadhaarVerified`, etc.).
   - OTP steps: `POST /send-email-otp`, `POST /verify-email`, `POST /send-phone-otp`, `POST /verify-phone`.
   - Aadhaar verification: `POST /aadhaar/otp/generate`, `POST /aadhaar/otp/verify`.
2. **Address & Profile Finalization (The Current Discrepancy):**
   - In `user.auth.routes.js`, `POST /api/auth/user/profile` calls `completeProfileForRegistration({ registrationId, city, state, pincode, latitude, longitude })`.
   - In `advocate.auth.routes.js`, `POST /api/auth/advocate/profile` currently calls `completeProfile` -> `completeAdvocateRegistration` which creates the `Advocate` record directly using `barCouncilId`, `aadhaarNumber`, `password`, `languagesSpoken`, `state`, `city`, `pincode`, `latitude`, `longitude`, `about`.
   - There was **no intermediate address step** for advocates; address fields were submitted together with credentials at `POST /api/auth/advocate/profile`.
3. **Pincode to City/State Lookup:**
   - The backend currently does **not** have an API endpoint to look up city and state from a pincode.
   - The frontend manages this lookup and supplies `pincode` (6 digits), `city`, and `state`.
   - Nearby advocate search coordinates are resolved via `resolvePincodeCoordinates` in `src/services/advocate.service.js`.

### Last Task (README Section 34) & Complete Profile Today
1. `Advocate` currently has:
   - `officePhotoUrl`, `officePhotoPublicId`, `officeLatitude`, `officeLongitude`, `officeLocationUpdatedAt`.
2. `POST /api/advocate/profile/office-photo` uploads an office photo and cleans up the previous photo from Cloudinary.
3. `PATCH /api/advocate/profile` accepts `officeLatitude` and `officeLongitude` (alongside `state`, `city`, `pincode`, `completeAddress`).
4. `POST /api/advocate/profile/submit-for-approval` currently enforces `missingFields: ["officePhoto", "officeLocation"]` before allowing submission.
5. Public profile and admin detail formats format office data via `formatOfficeDetails` and `formatAdvocateReviewData`.

### Admin Today
1. Routes in `src/routes/admin.routes.js` handle advocate review:
   - `GET /advocates/pending`, `GET /advocates/rejected`, `GET /advocates`, `GET /advocates/:advocateId`.
   - Approval/Rejection: `PATCH /advocates/:advocateId/approve`, `PATCH /advocates/:advocateId/reject`.
   - Direct edit: `PATCH /advocates/:advocateId/profile` using permission `advocates:edit`.

---

## 2. Adapted Design

### Goal 1 & 2: Registration Address Step (Multipart)
- **Endpoint:** `POST /api/auth/advocate/profile` (preserving the existing route).
- **Multipart Form-Data:** handled by `upload.single('officePhoto')`.
- **Payload:**
  - `registrationId` (UUID, required)
  - `pincode` (6 digits regex, required)
  - `city` (string 2-100 chars, required)
  - `state` (string 2-100 chars, required)
  - `officeAddress` (string 10-500 chars, trimmed, required)
  - `officeLatitude`, `officeLongitude` (valid coordinate strings or numbers, both required)
  - `officePhoto` (file, required on first save; optional on subsequent updates if session already has `officePhotoUrl`). Validated with `validateUploadedPhoto` (JPEG/JPG/PNG/WEBP, ≤ 5MB).
- **Session Persistence:**
  - Saves `officeAddress`, `officePhotoUrl`, `officePhotoPublicId`, `officeLatitude`, `officeLongitude`, `city`, `state`, `pincode` onto `RegistrationSession`.
  - Also sets `latitude = officeLatitude` and `longitude = officeLongitude` on `RegistrationSession` so nearby search uses the office location seamlessly.
  - If replaced, deletes the old session office photo from Cloudinary.
- **Session Resume:**
  - `GET /api/auth/advocate/register/session/:registrationId` returns `officeAddress`, `officePhotoUrl`, `officeLatitude`, `officeLongitude`, `city`, `state`, `pincode` (never `officePhotoPublicId`).

### Goal 3: Registration Completion
- Endpoint: `POST /api/auth/advocate/register/complete` (and compatibility alias on `POST /api/auth/advocate/profile` when JSON registration body is sent).
- When creating `Advocate`:
  - Validates that the session has `officeAddress`, `officePhotoUrl`, `officeLatitude`, and `officeLongitude`.
  - If missing, returns `400 Bad Request`:
    ```json
    {
      "success": false,
      "message": "Please complete your address and office details.",
      "missingFields": ["officeAddress", "officePhoto", "officeLocation"]
    }
    ```
  - Copies to `Advocate`:
    - `officeAddress = session.officeAddress`
    - `officePhotoUrl = session.officePhotoUrl`
    - `officePhotoPublicId = session.officePhotoPublicId`
    - `officeLatitude = session.officeLatitude`
    - `officeLongitude = session.officeLongitude`
    - `latitude = session.officeLatitude`
    - `longitude = session.officeLongitude`
    - `city = session.city`
    - `state = session.state`
    - `pincode = session.pincode`
    - `officeLocationUpdatedAt = new Date()`
  - Note: Session deletion cleans up `RegistrationSession` in DB; the Cloudinary office photo is preserved because it now belongs to the newly created `Advocate`.

### Goal 4: Complete Profile Cleanup
1. **`PATCH /api/advocate/profile`:**
   - Remove `officeLatitude`, `officeLongitude`, `city`, `state`, `pincode`, `latitude`, `longitude` from allowed updates.
   - If any of these fields are sent, return `400 Bad Request`:
     ```json
     {
       "success": false,
       "message": "Office/address can't be changed here. Use the office change request."
     }
     ```
2. **`POST /api/advocate/profile/office-photo`:**
   - Removed entirely. Calling it returns 404.
3. **`POST /api/advocate/profile/submit-for-approval`:**
   - Remove the office photo and office location requirement check.
   - Old advocates without office details are **not blocked** from submitting.
4. **`officeDetailsComplete`:** Kept in `getProfile` as informational only.
5. **Admin Edit Advocate (`PATCH /api/admin/advocates/:advocateId/profile`):**
   - Preserved and extended: Admin can edit `officeLatitude`, `officeLongitude`, and `officeAddress` directly with immediate application (no approval workflow required).

### Goal 5 & 6: Advocate Office Change Request & Admin Approval
#### Advocate Flow (`PUT /api/advocate/profile/office`)
- Multipart endpoint (`upload.single('officePhoto')`), advocate authenticated.
- **Fields:** `officeAddress`, `pincode`, `city`, `state`, `officeLatitude`, `officeLongitude` + `officePhoto` (live photo file required).
- **If Advocate `approvalStatus !== 'APPROVED'` (Draft / PENDING / REJECTED):**
  - Applied directly to live fields (`officeAddress`, `officePhotoUrl`, `officePhotoPublicId`, `officeLatitude`, `officeLongitude`, `latitude`, `longitude`, `city`, `state`, `pincode`, `officeLocationUpdatedAt = now()`).
  - Deletes the old live office photo from Cloudinary after DB update.
  - Response: `{ "success": true, "message": "Office details updated." }`.
- **If Advocate `approvalStatus === 'APPROVED'`:**
  - Old live fields remain unchanged (advocate remains approved, visible, and bookable).
  - Uploads new photo to Cloudinary.
  - If a previous `pendingOfficeChange` exists, its photo is deleted from Cloudinary.
  - Updates DB:
    - `pendingOfficeChange`: JSON object containing `{ officeAddress, pincode, city, state, officeLatitude, officeLongitude, officePhotoUrl, officePhotoPublicId }`
    - `officeChangeStatus = "PENDING"`
    - `officeChangeRequestedAt = new Date()`
    - `officeChangeRejectionReason = null`
  - Response:
    ```json
    {
      "success": true,
      "message": "Office change sent for admin approval.",
      "officeChange": {
        "status": "PENDING",
        "requestedAt": "2026-...",
        "requested": {
          "officeAddress": "...",
          "pincode": "...",
          "city": "...",
          "state": "...",
          "officeLatitude": 28.6304,
          "officeLongitude": 77.2177,
          "officePhotoUrl": "https://..."
        }
      }
    }
    ```
- **`GET /api/advocate/profile`:** Returns `officeChange` object (`status`, `requestedAt`, `reviewedAt`, `rejectionReason`, `requested` without publicId) or `null`.

#### Admin Flow
1. **`GET /api/admin/advocates/office-changes?status=PENDING|APPROVED|REJECTED&page=1&limit=20&search=...`**
   - Permission: `advocates:edit` (or Admin bypass).
   - Route order: placed **before** `/advocates/:advocateId` to prevent route collisions.
   - Returns paginated list of changes with `advocate` summary (id, fullName, phone, barCouncilId, email), `requestedAt`, `status`, and `counts` for PENDING, APPROVED, REJECTED, total.
2. **`GET /api/admin/advocates/:advocateId/office-change`**
   - Permission: `advocates:edit` (or `advocates:view`).
   - Returns current office side by side with requested office (each with calculated `officeMapUrl`).
3. **`POST /api/admin/advocates/:advocateId/office-change/approve`**
   - Permission: `advocates:edit`.
   - If `officeChangeStatus !== 'PENDING'`: returns `409 Conflict` ("No pending office change.").
   - In transaction:
     - Copies requested values to live fields (`officeAddress`, `officePhotoUrl`, `officePhotoPublicId`, `officeLatitude`, `officeLongitude`, `latitude`, `longitude`, `city`, `state`, `pincode`, `officeLocationUpdatedAt = now()`).
     - Sets `officeChangeStatus = "APPROVED"`, `officeChangeReviewedAt = now()`, `pendingOfficeChange = null`.
     - After commit: deletes old live office photo from Cloudinary.
4. **`POST /api/admin/advocates/:advocateId/office-change/reject`**
   - Permission: `advocates:edit`.
   - Body: `{ "reason": "..." }` (5-500 chars).
   - If not PENDING: returns `409 Conflict`.
   - Sets `officeChangeStatus = "REJECTED"`, `officeChangeRejectionReason = reason`, `officeChangeReviewedAt = now()`, `pendingOfficeChange = null`.
   - After commit: deletes pending photo from Cloudinary. Live office remains unchanged.

### Goal 6: Deletion & Public Detail Cleanup
- `src/services/advocateDeletion.service.js`: In `finalizeAdvocateDeletion`, also deletes `advocate.pendingOfficeChange?.officePhotoPublicId` with error tolerance.
- Public profile (`getAdvocateDetailsPublic`) and directory include `officeAddress` (never `pendingOfficeChange`).
- Admin advocate detail (`getAdvocateReviewProfile`) includes `officeAddress` and `officeChange` (`status`, `requestedAt`).

---

## 3. Files to Modify

| File | Changes |
|---|---|
| `prisma/schema.prisma` | Add 5 nullable columns to `RegistrationSession` and 6 nullable columns to `Advocate`. |
| `src/routes/advocate.auth.routes.js` | Update `POST /profile` to use `upload.single('officePhoto')`; add `POST /register/complete` endpoint. |
| `src/controllers/advocate.auth.controller.js` | Update `completeProfile` to process address/office multipart step for registration; add `completeRegistration` handler; export `validateUploadedPhoto` from profile controller. |
| `src/services/auth.service.js` | Add `saveAdvocateRegistrationOfficeDetails`; update `completeAdvocateRegistration` to validate & copy office details from session; update `getCurrentRegistrationSession` to return office fields. |
| `src/validators/advocate.validator.js` | Add `advocateRegistrationAddressSchema`, `advocateOfficeChangeSchema`; update `advocateProfileUpdateSchema` to reject removed fields; export office coordinate schemas. |
| `src/routes/advocate.profile.routes.js` | Remove `POST /office-photo`; add `PUT /office` (multipart). |
| `src/controllers/advocate.profile.controller.js` | Export `validateUploadedPhoto`; remove `uploadOfficePhoto`; remove office check from `submitForApproval`; add `requestOfficeChange` (`PUT /office`); include `officeChange` in `getProfile`. |
| `src/routes/admin.routes.js` | Add `/advocates/office-changes` (placed before `/:advocateId`), `/:advocateId/office-change`, `/:advocateId/office-change/approve`, `/:advocateId/office-change/reject`. |
| `src/controllers/admin.controller.js` | Add `listOfficeChangeRequests`, `getAdvocateOfficeChangeDetails`, `approveAdvocateOfficeChange`, `rejectAdvocateOfficeChange`; update `formatAdvocateReviewData` to include `officeAddress` & `officeChange`. |
| `src/validators/admin.validator.js` | Add `rejectOfficeChangeSchema`, update `adminAdvocateProfileUpdateSchema` to allow `officeAddress`. |
| `src/services/advocateDeletion.service.js` | Delete `pendingOfficeChange?.officePhotoPublicId` during permanent deletion. |
| `src/services/advocate.service.js` | Add `officeAddress` to public profile and list outputs. |
| `README.md` | Update registration address step, rewrite Section 34, add Office Change Request section. |

*No new controller, service, or route files will be created.*

---

## 4. Migration SQL

To be generated strictly via Prisma migration diff policy (`prisma migrate diff`):
```sql
-- AlterTable RegistrationSession
ALTER TABLE "RegistrationSession" ADD COLUMN "officeAddress" TEXT;
ALTER TABLE "RegistrationSession" ADD COLUMN "officePhotoUrl" TEXT;
ALTER TABLE "RegistrationSession" ADD COLUMN "officePhotoPublicId" TEXT;
ALTER TABLE "RegistrationSession" ADD COLUMN "officeLatitude" DOUBLE PRECISION;
ALTER TABLE "RegistrationSession" ADD COLUMN "officeLongitude" DOUBLE PRECISION;

-- AlterTable Advocate
ALTER TABLE "Advocate" ADD COLUMN "officeAddress" TEXT;
ALTER TABLE "Advocate" ADD COLUMN "pendingOfficeChange" JSONB;
ALTER TABLE "Advocate" ADD COLUMN "officeChangeStatus" TEXT;
ALTER TABLE "Advocate" ADD COLUMN "officeChangeRequestedAt" TIMESTAMP(3);
ALTER TABLE "Advocate" ADD COLUMN "officeChangeReviewedAt" TIMESTAMP(3);
ALTER TABLE "Advocate" ADD COLUMN "officeChangeRejectionReason" TEXT;
```
- Only adds nullable columns.
- No existing columns dropped or renamed.
- Safe for zero-downtime deployment.

---

## 5. Request & Response Samples

### 5.1 Registration Address Step: `POST /api/auth/advocate/profile`
**Request:** `multipart/form-data`
- `registrationId`: `c6b70f1a-b60b-411a-b9c1-8409021e5491`
- `pincode`: `110001`
- `city`: `New Delhi`
- `state`: `Delhi`
- `officeAddress`: `Chamber No. 42, Delhi High Court Complex, Sher Shah Road`
- `officeLatitude`: `28.6139`
- `officeLongitude`: `77.2090`
- `officePhoto`: *(binary image file)*

**Response (`200 OK`):**
```json
{
  "success": true,
  "message": "Address and office details saved.",
  "officeAddress": "Chamber No. 42, Delhi High Court Complex, Sher Shah Road",
  "officePhotoUrl": "https://res.cloudinary.com/dummy/image/upload/v1234/office.jpg",
  "officeLatitude": 28.6139,
  "officeLongitude": 77.209,
  "city": "New Delhi",
  "state": "Delhi",
  "pincode": "110001"
}
```

### 5.2 Registration Final Completion: Missing Office Check
If registration completion is called before address step:
**Response (`400 Bad Request`):**
```json
{
  "success": false,
  "message": "Please complete your address and office details.",
  "missingFields": ["officeAddress", "officePhoto", "officeLocation"]
}
```

### 5.3 Complete Profile: Removed Fields Rejected
`PATCH /api/advocate/profile` with `{"city": "Mumbai"}`:
**Response (`400 Bad Request`):**
```json
{
  "success": false,
  "message": "Office/address can't be changed here. Use the office change request."
}
```

### 5.4 Advocate Office Change Request: `PUT /api/advocate/profile/office`
**Request:** `multipart/form-data` (Advocate Bearer Token)
- `officeAddress`: `Suite 102, Legal Enclave, Barakhamba Road`
- `pincode`: `110001`
- `city`: `New Delhi`
- `state`: `Delhi`
- `officeLatitude`: `28.6304`
- `officeLongitude`: `77.2177`
- `officePhoto`: *(binary live image file)*

**Response (`200 OK` - Approved Advocate):**
```json
{
  "success": true,
  "message": "Office change sent for admin approval.",
  "officeChange": {
    "status": "PENDING",
    "requestedAt": "2026-10-29T08:00:00.000Z",
    "requested": {
      "officeAddress": "Suite 102, Legal Enclave, Barakhamba Road",
      "pincode": "110001",
      "city": "New Delhi",
      "state": "Delhi",
      "officeLatitude": 28.6304,
      "officeLongitude": 77.2177,
      "officePhotoUrl": "https://res.cloudinary.com/dummy/image/upload/v5678/new_office.jpg"
    }
  }
}
```

### 5.5 Admin List Office Changes: `GET /api/admin/advocates/office-changes?status=PENDING`
**Response (`200 OK`):**
```json
{
  "success": true,
  "data": [
    {
      "advocate": {
        "id": "adv-123",
        "name": "Adv. Rajesh Kumar",
        "fullName": "Adv. Rajesh Kumar",
        "phone": "9876543210",
        "barCouncilId": "D/1234/2020",
        "email": "rajesh@example.com"
      },
      "requestedAt": "2026-10-29T08:00:00.000Z",
      "status": "PENDING"
    }
  ],
  "counts": {
    "PENDING": 1,
    "APPROVED": 4,
    "REJECTED": 1,
    "total": 6
  },
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "totalPages": 1
  }
}
```

### 5.6 Admin Review Office Change: `GET /api/admin/advocates/:advocateId/office-change`
**Response (`200 OK`):**
```json
{
  "success": true,
  "status": "PENDING",
  "requestedAt": "2026-10-29T08:00:00.000Z",
  "reviewedAt": null,
  "rejectionReason": null,
  "currentOffice": {
    "officeAddress": "Chamber No. 42, Delhi High Court Complex",
    "officePhotoUrl": "https://res.cloudinary.com/dummy/image/upload/v1234/office.jpg",
    "officeLatitude": 28.6139,
    "officeLongitude": 77.209,
    "officeMapUrl": "https://www.google.com/maps?q=28.6139,77.209",
    "city": "New Delhi",
    "state": "Delhi",
    "pincode": "110001",
    "officeLocationUpdatedAt": "2026-10-15T10:00:00.000Z"
  },
  "requestedOffice": {
    "officeAddress": "Suite 102, Legal Enclave, Barakhamba Road",
    "officePhotoUrl": "https://res.cloudinary.com/dummy/image/upload/v5678/new_office.jpg",
    "officeLatitude": 28.6304,
    "officeLongitude": 77.2177,
    "officeMapUrl": "https://www.google.com/maps?q=28.6304,77.2177",
    "city": "New Delhi",
    "state": "Delhi",
    "pincode": "110001"
  }
}
```

---

## 6. Risks & Mitigation

1. **Route collision in Admin endpoints:**
   - *Risk:* `/api/admin/advocates/office-changes` could be intercepted by `/api/admin/advocates/:advocateId` if defined after it.
   - *Mitigation:* Explicitly place `router.get('/advocates/office-changes', ...)` **before** `router.get('/advocates/:advocateId', ...)`.
2. **Cloudinary Orphaned Images:**
   - *Risk:* Uploading a replacement office photo before DB commit could orphan images if the DB update fails; deleting old photos prematurely could cause data loss if DB rollbacks occur.
   - *Mitigation:* Follow the established repository pattern: upload first -> update DB -> on DB success, delete old Cloudinary public ID. If DB fails, catch and delete newly uploaded image.
3. **Old Advocates Submission Blockers:**
   - *Risk:* Legacy advocates who completed registration before this change might not have `officePhotoUrl` or `officeLatitude`.
   - *Mitigation:* Completely removed the office check from `submitForApproval`. Existing advocates can submit for approval without office details.
4. **Public Exposure of Cloudinary Public IDs:**
   - *Risk:* Returning `officePhotoPublicId` or `pendingOfficeChange.officePhotoPublicId` in responses.
   - *Mitigation:* Destructure and omit all `*PublicId` fields in formatters and response payloads.

---

## 7. Answers to OPEN QUESTIONS

### 1. PATCH with removed address/office fields: 400 or silently ignore?
- **Recommendation:** **Return `400 Bad Request`** with error message:
  `"Office/address can't be changed here. Use the office change request."`
- **Rationale:** Silently ignoring values causes frontends to believe edits were accepted when they were dropped. Returning 400 gives explicit, fail-fast feedback and directs the developer/user to the official `PUT /api/advocate/profile/office` approval flow.

### 2. Pincode → city/state: where does it happen today (frontend / backend)?
- **Finding & Recommendation:** It happens on the **frontend**. The backend currently has no pincode-to-city/state lookup endpoint. We keep this exact architecture: the frontend resolves or collects city and state from pincode and passes all three (`pincode`, `city`, `state`) to the backend, where the backend validates format and presence.

### 3. During a PENDING office change, should the public profile show the old office?
- **Recommendation:** **Yes, the old office remains visible.**
- **Rationale:** An advocate's office is verified. Until an admin approves a change, the platform continues to present the currently verified office address, location, and photo so client bookings and nearby searches remain accurate and safe.

---

## 8. Status & Next Step
Plan is written in `proceed.md`.
**STOPPING HERE.** Waiting for your review and explicit message typing **"approved"**.
After approval:
1. I will generate the migration script via Prisma diff and present the SQL for your "OK".
2. Only after your "OK" will `migrate deploy` and code implementation proceed.
