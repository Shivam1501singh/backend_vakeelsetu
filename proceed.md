# Implementation Plan: Advocate Office Photo & Office Location at Profile Completion

## 0. Database Safety & Connection Notice
> [!IMPORTANT]
> **Connected Database Host:** `ep-weathered-hat-b47xszyr-pooler.c-6.us-east-2.aws.neon.tech` (Neon cloud PostgreSQL)  
> **Database Name:** `neondb`  
> **Status:** Read-only planning phase. No migrations, seeds, Cloudinary uploads, or database writes have been executed. All schema diffs were generated using safe, read-only Prisma inspection.

---

## 1. Current Behaviour Analysis

### 1.1 Existing Routes & Middleware (`src/routes/advocate.profile.routes.js`)
- Mounted at `/api/advocate/profile` and protected by `requireAuth`.
- Endpoints:
  - `GET /`: Returns authenticated advocate profile.
  - `GET /verification-status`: Returns approval preview or status.
  - `PATCH /`: Updates allowed scalar and aliased profile fields.
  - `POST /photo`: Uploads profile avatar photo via multer (`upload.single('profilePhoto')`) to Cloudinary.
  - `POST /submit-for-approval`: Validates profile completeness and marks approval status as `PENDING`. (Also mounted at `/api/advocates/profile/submit-for-approval` in `advocate.routes.js`).

### 1.2 Current Advocate Profile Controller (`src/controllers/advocate.profile.controller.js`)
- **`getProfile`**: Queries `prisma.advocate.findUnique`, omits `passwordHash` and `aadhaarNumber`, attaches effective `isOnline`, `bio`, and returns `{ success: true, advocate: { ... } }`. Does not currently return any office photo or office coordinates.
- **`updateProfile`**: Validates `req.body` against `advocateProfileUpdateSchema`. Only handles existing profile scalars (experience, bio, charges, practice areas, address, etc.).
- **`uploadProfilePhoto`**: Validates MIME type (`image/jpeg`, `image/jpg`, `image/png`, `image/webp`) and size (<= 5MB). Calls `uploadBufferToCloudinary(req.file.buffer)`. On success, updates `profilePhotoUrl` and `profilePhotoPublicId`, and cleans up `oldPublicId` using `deleteFromCloudinary`. On error, removes the newly uploaded asset.
- **`checkIsProfileComplete`**: Checks 10 basic fields (`fullName`, `phone`, `barCouncilId`, `profilePhotoUrl`, `practiceAreas`/`bestPracticeArea`, `experienceYears`, `about`, `city`, `state`, `pincode`).
- **`submitForApproval`**: Verifies that status is not `BLOCKED`, `approvalStatus` is not `APPROVED`, and `checkIsProfileComplete(advocate)` passes. Sets `approvalStatus = 'PENDING'`, `submittedForApprovalAt = now()`.

### 1.3 Validators (`src/validators/advocate.validator.js` & `src/validators/admin.validator.js`)
- `advocateProfileUpdateSchema` is `.strict()`. It currently validates profile fields and aliases.
- Registration coordinates (`latitude`, `longitude`) are only defined on `completeAdvocateRegistrationSchema`.
- `adminAdvocateProfileUpdateSchema` in `admin.validator.js` extends `advocateProfileUpdateSchema`.

### 1.4 Public Advocate APIs (`src/services/advocate.service.js`)
- `listAdvocates`: Used by `GET /api/advocates`. Explicitly excludes `latitude`, `longitude`, and `pincode` from the response for privacy, returning only calculated `distance` (km) via Haversine.
- `getAdvocateDetailsPublic`: Used by `GET /api/advocates/:id`. Excludes sensitive fields and returns public profile attributes.

### 1.5 Admin Panel Advocate APIs (`src/controllers/admin.controller.js`)
- `listPendingAdvocates`: `GET /api/admin/advocates/pending` returns mapped list of advocates with `approvalStatus: 'PENDING'`.
- `listRejectedAdvocates`: `GET /api/admin/advocates/rejected` returns mapped list of advocates with `approvalStatus: 'REJECTED'`.
- `getAdvocateReviewProfile`: `GET /api/admin/advocates/:advocateId` uses `formatAdvocateReviewData(advocate)` to return detailed profile for admin review.
- `updateAdvocateProfileByAdmin`: `PATCH /api/admin/advocates/:advocateId/profile` uses `adminAdvocateProfileUpdateSchema` to validate and update advocate data, detecting diffs in `changedFields`.

### 1.6 Account Deletion Services
- `src/services/advocateDeletion.service.js`: Contains `finalizeAdvocateDeletion(advocateId)` which archives the record into `DeletedAdvocate` and deletes the `Advocate` row. Cloudinary images (`profilePhotoPublicId`) were not previously cleaned up during this purge.

---

## 2. Adapted Design & Architecture

### 2.1 Schema Definition (`prisma/schema.prisma`)
Add 5 nullable fields to `model Advocate` directly after existing `longitude`:
```prisma
model Advocate {
  // ... existing fields ...
  latitude                 Float?
  longitude                Float?
  
  // Office location and photo collected at profile completion
  officePhotoUrl           String?
  officePhotoPublicId      String?
  officeLatitude           Float?
  officeLongitude          Float?
  officeLocationUpdatedAt  DateTime?
  // ... relations ...
}
```
*Note: All fields are nullable so existing advocates default to `NULL` without data breakage.*

### 2.2 Office Photo Upload (`POST /api/advocate/profile/office-photo`)
- **Route:** Add to `src/routes/advocate.profile.routes.js`:
  ```javascript
  router.post('/office-photo', generalLimiter, upload.single('officePhoto'), advocateProfileController.uploadOfficePhoto);
  ```
- **Controller Helper (`validatePhotoUpload`):** Refactor the photo format (JPEG, JPG, PNG, WEBP) and size (<= 5MB) validation inside `src/controllers/advocate.profile.controller.js` to avoid duplicating boilerplate.
- **Controller Handler (`uploadOfficePhoto`):**
  - Requires advocate token.
  - Validates `req.file` with `validatePhotoUpload`.
  - Retains existing `uploadBufferToCloudinary` without modifying `cloudinary.service.js`.
  - Updates DB with `officePhotoUrl` and `officePhotoPublicId`.
  - Deletes old `officePhotoPublicId` from Cloudinary via `deleteFromCloudinary` upon successful DB update.
  - In case of DB update failure, cleans up the orphaned newly-uploaded Cloudinary image.
  - Returns `officePhotoUrl` (never returns `officePhotoPublicId`).

### 2.3 Office Coordinates Validation & Update (`PATCH /api/advocate/profile`)
- **Validation (`src/validators/advocate.validator.js`):**
  - Define custom coordinate schemas that safely handle numeric inputs or numeric strings without bare `parseFloat` (which converts `"abc"` to `NaN`):
    - Rejects empty strings, `NaN`, and `Infinity`.
    - Bounds: `officeLatitude` in `[-90, 90]`, `officeLongitude` in `[-180, 180]`.
  - Add to `advocateProfileUpdateSchema`:
    ```javascript
    officeLatitude: officeLatitudeSchema.optional().nullable(),
    officeLongitude: officeLongitudeSchema.optional().nullable(),
    ```
  - Add refinement for "Both or neither":
    - If only one coordinate is provided or one is null while the other is a number, trigger validation error: `"officeLatitude and officeLongitude must be sent together."`
    - Both `null` is accepted to clear location (allowed only for advocates not yet approved; see Open Question 3).
- **Controller (`updateProfile` in `advocate.profile.controller.js`):**
  - When numbers are passed: updates `officeLatitude`, `officeLongitude`, and sets `officeLocationUpdatedAt = new Date()`.
  - When both are `null`: clears `officeLatitude = null`, `officeLongitude = null`, and `officeLocationUpdatedAt = null`.

### 2.4 Profile Completion & Submission Check (`submitForApproval`)
- To prevent locking out existing APPROVED advocates, **keep `checkIsProfileComplete()` unchanged**.
- In `submitForApproval` in `advocate.profile.controller.js`:
  - Run standard `checkIsProfileComplete(advocate)`.
  - Add strict office requirements:
    ```javascript
    const missingFields = [];
    if (!advocate.officePhotoUrl || !advocate.officePhotoUrl.trim()) {
      missingFields.push('officePhoto');
    }
    if (
      advocate.officeLatitude === null || advocate.officeLatitude === undefined ||
      advocate.officeLongitude === null || advocate.officeLongitude === undefined
    ) {
      missingFields.push('officeLocation');
    }
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Please complete your office photo and office location before submitting for approval.',
        missingFields
      });
    }
    ```

### 2.5 Exposing Office Data Across Endpoints
1. **Own Profile (`GET /api/advocate/profile` & `GET /api/advocate/profile/verification-status`):**
   - Provide structured `office` object:
     ```json
     "office": {
       "photoUrl": "https://res.cloudinary.com/...",
       "latitude": 28.6304,
       "longitude": 77.2177,
       "updatedAt": "2026-10-28T18:00:00.000Z"
     }
     ```
   - Provide flat attributes matching existing style: `officePhotoUrl`, `officeLatitude`, `officeLongitude`, `officeLocationUpdatedAt`.
   - Provide boolean status flag: `officeDetailsComplete: Boolean(advocate.officePhotoUrl && advocate.officeLatitude !== null && advocate.officeLongitude !== null)`.
   - Ensure `officePhotoPublicId` is strictly omitted.
2. **Public Advocate Profile (`GET /api/advocates/:id`):**
   - Add `officeLatitude`, `officeLongitude`, and `officePhotoUrl` to the response object in `getAdvocateDetailsPublic`.
   - Public directory list (`GET /api/advocates`) remains coordinate-free for privacy.
3. **Admin Panel Endpoints (`src/controllers/admin.controller.js`):**
   - `listPendingAdvocates` (`GET /api/admin/advocates/pending`): Include `officePhotoUrl`, `officeLatitude`, `officeLongitude`, and `office` object.
   - `listRejectedAdvocates` (`GET /api/admin/advocates/rejected`): Include the same office fields.
   - `formatAdvocateReviewData` (`GET /api/admin/advocates/:advocateId`):
     - Include `officePhotoUrl`, `officeLatitude`, `officeLongitude`, `officeLocationUpdatedAt`, and `office` object.
     - Add `officeMapUrl`: `https://www.google.com/maps?q=${advocate.officeLatitude},${advocate.officeLongitude}` (or `null` if coordinates are not set).
   - `updateAdvocateProfileByAdmin` (`PATCH /api/admin/advocates/:advocateId/profile`):
     - Automatically validates `officeLatitude` and `officeLongitude` via extended schema.
     - Saves coordinates and updates `officeLocationUpdatedAt = new Date()`.
     - Tracks changes in `changedFields`.

### 2.6 Account Deletion Cleanup
- In `src/services/advocateDeletion.service.js` within `finalizeAdvocateDeletion`:
  - When an advocate is permanently purged, safely invoke `deleteFromCloudinary` for both `advocate.profilePhotoPublicId` and `advocate.officePhotoPublicId` inside try-catch blocks to prevent orphaned Cloudinary storage.
  - Also add corresponding defensive check in `accountDeletion.service.js` if advocate records ever route through it.

---

## 3. Files to Change (No New Route/Controller/Service Files)

| File | Change Summary |
|---|---|
| `prisma/schema.prisma` | Add 5 nullable office fields to `Advocate` model. |
| `src/routes/advocate.profile.routes.js` | Add `POST /office-photo` route with multer memory upload. |
| `src/validators/advocate.validator.js` | Add numeric coordinate validation and both-or-neither refine rule to `advocateProfileUpdateSchema`. |
| `src/controllers/advocate.profile.controller.js` | Implement `uploadOfficePhoto`, handle office coordinates in `updateProfile`, enforce office requirements in `submitForApproval`, and return `office` / flat office fields in `getProfile` and `getVerificationStatus`. |
| `src/services/advocate.service.js` | Add `officeLatitude`, `officeLongitude`, `officePhotoUrl` to public detail response in `getAdvocateDetailsPublic`. |
| `src/controllers/admin.controller.js` | Add office fields and `officeMapUrl` to admin review profile, pending queue, rejected queue, and allow admin coordinate updates. |
| `src/services/advocateDeletion.service.js` | Clean up `officePhotoPublicId` from Cloudinary during permanent deletion. |
| `README.md` | Add Section 34 ("Advocate Office Photo & Office Location — Postman Guide") with full API documentation and testing instructions. |
| `prisma/migrations/<timestamp>_add_advocate_office_location/migration.sql` | The generated migration SQL script. |

---

## 4. Prisma Migration SQL

Generated using:
```bash
npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script
```

Target Migration File: `prisma/migrations/20261028133000_add_advocate_office_location/migration.sql`

```sql
-- AlterTable
ALTER TABLE "Advocate" ADD COLUMN     "officeLatitude" DOUBLE PRECISION,
ADD COLUMN     "officeLocationUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "officeLongitude" DOUBLE PRECISION,
ADD COLUMN     "officePhotoPublicId" TEXT,
ADD COLUMN     "officePhotoUrl" TEXT;
```

**Verification against policy:**
- Strict `ALTER TABLE ADD COLUMN` only.
- All columns nullable.
- Zero `DROP`, zero rename, zero data deletion.
- Applied only with `npx prisma migrate deploy` after explicit approval.

---

## 5. Request & Response Samples

### 5.1 Office Photo Upload
**`POST /api/advocate/profile/office-photo`**  
Header: `Authorization: Bearer {{advocate_token}}`  
Body: `multipart/form-data` with field `officePhoto` (file, JPEG/PNG <= 5MB)

**Response (`200 OK`):**
```json
{
  "success": true,
  "message": "Office photo updated successfully",
  "officePhotoUrl": "https://res.cloudinary.com/vakeelsetu/image/upload/v1729000000/advocates/office_abc123.jpg"
}
```

### 5.2 Office Location Update
**`PATCH /api/advocate/profile`**  
Header: `Authorization: Bearer {{advocate_token}}`  
Content-Type: `application/json`

**Request Body:**
```json
{
  "officeLatitude": 28.6304,
  "officeLongitude": 77.2177
}
```

**Response (`200 OK`):**
```json
{
  "success": true,
  "message": "Profile updated successfully",
  "advocate": {
    "id": "c1f7b024-4f9e-4b42-8924-1b1574a23b32",
    "fullName": "Advocate Rajesh Sharma",
    "email": "rajesh.adv@example.com",
    "phone": "9876543210",
    "officeLatitude": 28.6304,
    "officeLongitude": 77.2177,
    "officePhotoUrl": "https://res.cloudinary.com/vakeelsetu/image/upload/v1729000000/advocates/office_abc123.jpg",
    "officeLocationUpdatedAt": "2026-10-28T13:15:00.000Z",
    "office": {
      "photoUrl": "https://res.cloudinary.com/vakeelsetu/image/upload/v1729000000/advocates/office_abc123.jpg",
      "latitude": 28.6304,
      "longitude": 77.2177,
      "updatedAt": "2026-10-28T13:15:00.000Z"
    },
    "officeDetailsComplete": true,
    "type": "advocate"
  }
}
```

### 5.3 Fetch Own Profile
**`GET /api/advocate/profile`**  
Header: `Authorization: Bearer {{advocate_token}}`

**Response (`200 OK`):**
```json
{
  "success": true,
  "advocate": {
    "id": "c1f7b024-4f9e-4b42-8924-1b1574a23b32",
    "fullName": "Advocate Rajesh Sharma",
    "barCouncilId": "D/1234/2015",
    "city": "New Delhi",
    "state": "Delhi",
    "pincode": "110001",
    "profilePhotoUrl": "https://res.cloudinary.com/vakeelsetu/image/upload/v1729000000/advocates/profile_123.jpg",
    "officeLatitude": 28.6304,
    "officeLongitude": 77.2177,
    "officePhotoUrl": "https://res.cloudinary.com/vakeelsetu/image/upload/v1729000000/advocates/office_abc123.jpg",
    "officeLocationUpdatedAt": "2026-10-28T13:15:00.000Z",
    "office": {
      "photoUrl": "https://res.cloudinary.com/vakeelsetu/image/upload/v1729000000/advocates/office_abc123.jpg",
      "latitude": 28.6304,
      "longitude": 77.2177,
      "updatedAt": "2026-10-28T13:15:00.000Z"
    },
    "officeDetailsComplete": true,
    "approvalStatus": "PENDING",
    "accountStatus": "ACTIVE",
    "type": "advocate"
  }
}
```

### 5.4 Submit for Approval — Incomplete Error
**`POST /api/advocate/profile/submit-for-approval`**  
Header: `Authorization: Bearer {{advocate_token}}`

**Error Response (`400 Bad Request`):**
```json
{
  "success": false,
  "message": "Please complete your office photo and office location before submitting for approval.",
  "missingFields": ["officePhoto", "officeLocation"]
}
```

### 5.5 Public Advocate Detail
**`GET /api/advocates/c1f7b024-4f9e-4b42-8924-1b1574a23b32`**

**Response (`200 OK`):**
```json
{
  "success": true,
  "advocate": {
    "id": "c1f7b024-4f9e-4b42-8924-1b1574a23b32",
    "fullName": "Advocate Rajesh Sharma",
    "profilePhotoUrl": "https://res.cloudinary.com/vakeelsetu/image/upload/v1729000000/advocates/profile_123.jpg",
    "officeLatitude": 28.6304,
    "officeLongitude": 77.2177,
    "officePhotoUrl": "https://res.cloudinary.com/vakeelsetu/image/upload/v1729000000/advocates/office_abc123.jpg",
    "city": "New Delhi",
    "state": "Delhi",
    "experienceYears": 9,
    "approvalStatus": "APPROVED"
  }
}
```

### 5.6 Admin Review Profile
**`GET /api/admin/advocates/c1f7b024-4f9e-4b42-8924-1b1574a23b32`**  
Header: `Authorization: Bearer {{admin_token}}`

**Response (`200 OK`):**
```json
{
  "success": true,
  "advocate": {
    "id": "c1f7b024-4f9e-4b42-8924-1b1574a23b32",
    "fullName": "Advocate Rajesh Sharma",
    "barCouncilId": "D/1234/2015",
    "approvalStatus": "PENDING",
    "officePhotoUrl": "https://res.cloudinary.com/vakeelsetu/image/upload/v1729000000/advocates/office_abc123.jpg",
    "officeLatitude": 28.6304,
    "officeLongitude": 77.2177,
    "officeLocationUpdatedAt": "2026-10-28T13:15:00.000Z",
    "officeMapUrl": "https://www.google.com/maps?q=28.6304,77.2177",
    "office": {
      "photoUrl": "https://res.cloudinary.com/vakeelsetu/image/upload/v1729000000/advocates/office_abc123.jpg",
      "latitude": 28.6304,
      "longitude": 77.2177,
      "updatedAt": "2026-10-28T13:15:00.000Z"
    }
  }
}
```

---

## 6. Risks & Mitigations

1. **Risk:** Overwriting or modifying registration `latitude` and `longitude`.
   - **Mitigation:** The existing `latitude` and `longitude` fields in `Advocate` are left completely untouched. All distance calculation, nearby sorting, and registration flows continue using the original fields.
2. **Risk:** Accidentally exposing `officePhotoPublicId` to public or mobile clients.
   - **Mitigation:** Sanitizers in both `advocate.profile.controller.js` (`getProfile`, `updateProfile`), `advocate.service.js` (`getAdvocateDetailsPublic`), and `admin.controller.js` (`formatAdvocateReviewData`) explicitly omit or destructure out `officePhotoPublicId`.
3. **Risk:** String coordinates passed via form-data or JSON causing silent `NaN` parsing with bare `parseFloat`.
   - **Mitigation:** Custom Zod schema ensures strict numeric check (number or valid numeric string matching regex `/^-?\d+(\.\d+)?$/`), strictly bounds within `[-90, 90]` and `[-180, 180]`, and throws clear 400 validation messages for invalid inputs like `"abc"`, `""`, or out-of-range coordinates.
4. **Risk:** Broken profile completion checks for already-approved advocates.
   - **Mitigation:** `checkIsProfileComplete` is left unchanged. Office photo and location checks are isolated specifically to `submitForApproval`.

---

## 7. Answers to OPEN QUESTIONS

### Question 1: Public profile: return only office lat/lng, or also `officePhotoUrl`?
- **Recommendation:** Return `officeLatitude`, `officeLongitude`, AND `officePhotoUrl`.  
- **Rationale:** When users browse advocate profiles to book in-person consultations, seeing both the map pin and a legitimate photo of the advocate's law office establishes high trust and authenticity.

### Question 2: Already-APPROVED advocates with no office data: leave them as they are (not forced)?
- **Recommendation:** Yes, leave existing approved advocates untouched.  
- **Rationale:** Retroactively requiring office details on already-approved advocates would disrupt live accounts and break client bookings. The requirement is enforced exclusively on new submissions and resubmissions.

### Question 3: After APPROVAL, can the advocate change the office photo/location freely, or does that need admin re-approval?
- **Current Behaviour in Codebase:** In the current system, `updateProfile` and `uploadProfilePhoto` allow approved advocates to update profile data (address, practice areas, bio, profile photo) freely without resetting `approvalStatus` to `PENDING`. Only `submitForApproval` transitions an account to `PENDING`.
- **Recommendation:** Follow the existing pattern: allow approved advocates to update their office photo and office coordinates freely. However, disallow clearing (`null`) office coordinates once the account has achieved `APPROVED` status.

### Question 4: Map links: should the public profile also get `officeMapUrl`?
- **Recommendation:** Admin only.  
- **Rationale:** Frontend clients (React web and React Native mobile) consume raw coordinates (`officeLatitude`, `officeLongitude`) to render interactive map components (e.g. Google Maps SDK, Leaflet, Mapbox) with custom markers. The admin panel specifically benefits from a direct one-click outbound Google Maps link (`officeMapUrl`).
