# Implementation Plan: Admin Advocate Profile Editing & Rejected Profiles

## 1. Current Behaviour Analysis

We analyzed the current codebase and verified the following existing behavior:

1. **Advocate Self-Service Profile Update**:
   - Advocates update their profile via `PATCH /api/advocate/profile`.
   - Handled by `src/controllers/advocate.profile.controller.js` (`updateProfile`).
   - Validated against `advocateProfileUpdateSchema` (`.strict()`) in `src/validators/advocate.validator.js`.
   - Enforces a 50–500 word limit on the biography using `validateBioWords`.
   - Maps payload aliases:
     - `bio` / `about` → `about`
     - `experience` / `experienceYears` → `experienceYears`
     - `videoChargePerMinute` / `videoCallChargePerMinute` → `videoCallChargePerMinute`
     - `voiceChargePerMinute` / `voiceCallChargePerMinute` → `voiceCallChargePerMinute`
     - `languages` / `languagesSpoken` → `languagesSpoken`
   - Ignores `practiceAreaIds` in `updateProfile` (only direct `practiceAreas` array of strings is persisted to the database).
   - Sensitive fields (`fullName`, `email`, `phone`, `gender`, `barCouncilId`, `aadhaarNumber`, `passwordHash`) cannot be edited by the advocate via `PATCH /api/advocate/profile`.

2. **Advocate Approval Workflow**:
   - Advocates submit for approval via `POST /api/advocate/profile/submit-for-approval` (alias `/api/advocates/profile/submit-for-approval`).
   - This sets `approvalStatus: 'PENDING'`, `submittedForApprovalAt: new Date()`, and clears `rejectionReason: null`.
   - Admin approves via `PATCH /api/admin/advocates/:advocateId/approve` (`advocates:approve`), setting `approvalStatus: 'APPROVED'`, `approvedAt: new Date()`, `approvedById`, `status: 'ACTIVE'`, and clearing `rejectionReason: null`. It does **not** restrict prior status to `PENDING` (a `REJECTED` advocate can be approved directly).
   - Admin rejects via `PATCH /api/admin/advocates/:advocateId/reject` (`advocates:reject`), setting `approvalStatus: 'REJECTED'`, `callAvailability: false`, `rejectedAt: new Date()`, `rejectedById`, and `rejectionReason: reason`.

3. **Existing Admin Advocate Endpoints (`src/routes/admin.routes.js`)**:
   - `GET /api/admin/advocates/pending` (`advocates:view`): queries `where: { approvalStatus: 'PENDING' }`, ordered by `submittedForApprovalAt: desc`.
   - `GET /api/admin/advocates` (`advocates:view`): lists all advocates without filtering, ordered by `createdAt: desc`.
   - `GET /api/admin/advocates/:advocateId` (`advocates:view`): returns `{ success: true, data: advocateData, advocate: advocateData }`, excluding `passwordHash` and `aadhaarNumber`. Already includes `rejectionReason`, `rejectedAt`, `submittedForApprovalAt`, and `approvedAt`.

4. **RBAC and Wildcards**:
   - `checkUserPermission` in `src/services/rbac.service.js` performs strict exact-string match: `userPermissionSet.has(perm)`. **It does not support wildcards (`*` or `xxx:*`)**.
   - The main Admin (`type: 'admin'`) unconditionally bypasses permission checks in `requirePermission`.
   - Staff accounts (`content_creator`) require explicit permissions seeded in the database.

---

## 2. Files to Change

| File | Nature of Change |
| :--- | :--- |
| `prisma/seedRbac.js` | Add `advocates:edit` to `DEFAULT_PERMISSIONS` (idempotent seed). Do NOT add to staff roles. |
| `src/validators/admin.validator.js` | Export new `adminAdvocateProfileUpdateSchema` extending `advocateProfileUpdateSchema` with `fullName`, `gender`, and `barCouncilId`, enforcing `.strict()` and non-empty body refine. |
| `src/controllers/admin.controller.js` | 1. Implement `updateAdvocateProfileByAdmin` (`PATCH /advocates/:advocateId/profile`) with alias mapping, Bar Council ID uniqueness check, `changedFields` diffing, and audit logging.<br>2. Extract shared `formatAdvocateReviewData` helper for detail and update responses.<br>3. Implement `listRejectedAdvocates` (`GET /advocates/rejected`) with search and pagination.<br>4. Add optional `approvalStatus` filter and `rejectedAt` field to `listAdvocates` (`GET /advocates`). |
| `src/routes/admin.routes.js` | 1. Mount `GET /advocates/rejected` before `GET /advocates/:advocateId` (`advocates:view`).<br>2. Mount `PATCH /advocates/:advocateId/profile` (`advocates:edit`). |
| `README.md` | Add Section 27 (Postman Guide for Admin Advocate Edit & Rejected Profiles) and fix the 9 documentation cleanup items. |
| `proceed.md` | Planning, design specifications, and open question answers. |

---

## 3. New and Changed Endpoints

### 3.1 `PATCH /api/admin/advocates/:advocateId/profile` [NEW]
- **Middleware:** `requireAuth`, `requirePermission('advocates:edit')`, `generalLimiter`
- **Validation:** `adminAdvocateProfileUpdateSchema` (`.strict()`):
  - Base fields from `advocateProfileUpdateSchema`: `experienceYears`, `casesHandled`, `bestPracticeArea`, `about`, `bio` (50–500 words via `validateBioWords`), `courtPractice`, `completeAddress`, `videoCallChargePerMinute`, `voiceCallChargePerMinute`, `offlineVisitingFee`, `state`, `city`, `pincode`, `practiceAreas`, `topCourtPractised`.
  - Aliases: `experience` → `experienceYears`, `videoChargePerMinute` → `videoCallChargePerMinute`, `voiceChargePerMinute` → `voiceCallChargePerMinute`, `languages` → `languagesSpoken`.
  - Added identity fields:
    - `fullName`: `z.string().trim().min(2).max(100).optional()`
    - `gender`: `genderSchema.optional()`
    - `barCouncilId`: `barCouncilIdSchema.optional()`
  - Strictly rejected unknown/non-editable fields: `email`, `phone`, `aadhaarNumber`, `password`, `approvalStatus`, `status`, `callAvailability`, `deletionStatus`, `isOnline`, `lastSeenAt`, `averageRating`, `totalReviews`, `profilePhotoUrl`, `latitude`, `longitude`.
  - Empty body check: returns `400 Bad Request` with message `"Provide at least one field to update."`.
- **Controller Logic:**
  1. Parse body via `adminAdvocateProfileUpdateSchema`.
  2. Find advocate by `advocateId`; return `404` (`"Advocate not found"`) if missing.
  3. If `barCouncilId` is provided and different from current: check uniqueness via `prisma.advocate.findFirst({ where: { barCouncilId, NOT: { id: advocateId } } })`. If exists, return `400` (`"Bar Council ID is already registered to another advocate."`).
  4. Map aliases to DB fields. `practiceAreaIds` is ignored (matching advocate controller behavior).
  5. Compare old and new values:
     - Decimal fields (`videoCallChargePerMinute`, `voiceCallChargePerMinute`, `offlineVisitingFee`): compare converted `Number()`.
     - Array fields (`languagesSpoken`, `courtPractice`, `practiceAreas`): compare `JSON.stringify()`.
     - Scalar fields: strict equality `oldVal !== newVal`.
  6. If no fields changed (`changedFields.length === 0`): return `200 OK` with `changedFields: []`, message `"No changes detected."`, and skip DB update.
  7. If changed: execute `prisma.advocate.update`. **Preserve all approval and status fields** (`approvalStatus`, `submittedForApprovalAt`, `rejectionReason`, `approvedAt`, `status`, `callAvailability`).
  8. Log audit line: `console.log('[ADMIN ADVOCATE EDIT]', { advocateId, editedBy: req.user.id, editorType: req.user.type, fields: changedFields.map(c => c.field) })`.
  9. Return `200 OK` with formatted advocate data (excluding `passwordHash` and `aadhaarNumber`) and `changedFields`.

#### Sample Request:
```http
PATCH /api/admin/advocates/91205007-7870-496d-977d-4f594761380e/profile HTTP/1.1
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "experienceYears": 6,
  "bestPracticeArea": "Criminal Law",
  "practiceAreas": ["Criminal Law", "Family Law"],
  "bio": "Advocate Rahul Mehta is a seasoned legal professional with extensive experience in criminal litigation, corporate compliance, and constitutional matters across higher courts in India. He has successfully represented clients in numerous complex cases, ensuring strategic advocacy and dedicated representation with the highest ethical standards."
}
```

#### Sample Response (`200 OK`):
```json
{
  "success": true,
  "message": "Advocate profile updated successfully by admin",
  "data": {
    "id": "91205007-7870-496d-977d-4f594761380e",
    "name": "Adv. Rahul Mehta",
    "fullName": "Adv. Rahul Mehta",
    "email": "rahul@example.com",
    "phone": "9876543210",
    "barId": "D/1234/2015",
    "barCouncilId": "D/1234/2015",
    "gender": "Male",
    "experience": 6,
    "experienceYears": 6,
    "casesHandled": 120,
    "lawType": "Criminal Law",
    "bestPracticeArea": "Criminal Law",
    "practiceAreas": ["Criminal Law", "Family Law"],
    "about": "Advocate Rahul Mehta is a seasoned legal professional...",
    "state": "Delhi",
    "city": "New Delhi",
    "pincode": "110001",
    "approvalStatus": "PENDING",
    "submittedForApprovalAt": "2026-10-10T09:00:00.000Z",
    "rejectionReason": null,
    "approvedAt": null,
    "accountStatus": "ACTIVE",
    "callAvailability": false,
    "createdAt": "2026-10-01T10:00:00.000Z",
    "updatedAt": "2026-10-12T13:15:00.000Z"
  },
  "advocate": {
    "id": "91205007-7870-496d-977d-4f594761380e",
    "name": "Adv. Rahul Mehta",
    "fullName": "Adv. Rahul Mehta",
    "email": "rahul@example.com",
    "phone": "9876543210",
    "barId": "D/1234/2015",
    "barCouncilId": "D/1234/2015",
    "gender": "Male",
    "experience": 6,
    "experienceYears": 6,
    "casesHandled": 120,
    "lawType": "Criminal Law",
    "bestPracticeArea": "Criminal Law",
    "practiceAreas": ["Criminal Law", "Family Law"],
    "about": "Advocate Rahul Mehta is a seasoned legal professional...",
    "state": "Delhi",
    "city": "New Delhi",
    "pincode": "110001",
    "approvalStatus": "PENDING",
    "submittedForApprovalAt": "2026-10-10T09:00:00.000Z",
    "rejectionReason": null,
    "approvedAt": null,
    "accountStatus": "ACTIVE",
    "callAvailability": false,
    "createdAt": "2026-10-01T10:00:00.000Z",
    "updatedAt": "2026-10-12T13:15:00.000Z"
  },
  "changedFields": [
    {
      "field": "experienceYears",
      "oldValue": 3,
      "newValue": 6
    },
    {
      "field": "about",
      "oldValue": "Old biography snippet...",
      "newValue": "Advocate Rahul Mehta is a seasoned legal professional..."
    }
  ]
}
```

---

### 3.2 `GET /api/admin/advocates/rejected` [NEW]
- **Middleware:** `requireAuth`, `requirePermission('advocates:view')`, `generalLimiter`
- **Mount Position:** In `src/routes/admin.routes.js`, mounted **immediately before** `GET /advocates/:advocateId` to ensure the static path `/rejected` is never shadowed by parameter `:advocateId`.
- **Query Parameters:**
  - `search` (optional string): case-insensitive match on `fullName`, `email`, `phone`, or `barCouncilId`.
  - `page` (optional integer, default `1`).
  - `limit` (optional integer, default `20`, max `100`).
- **Query Logic:** `prisma.advocate.findMany({ where: { approvalStatus: 'REJECTED', ...searchClause }, orderBy: { rejectedAt: 'desc' } })`.

#### Sample Response (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "id": "e81d7398-319b-4322-bfa1-d419a71b8e19",
      "name": "Adv. Suresh Verma",
      "fullName": "Adv. Suresh Verma",
      "email": "suresh.verma@example.com",
      "phone": "9876543299",
      "barId": "UP/5432/2018",
      "barCouncilId": "UP/5432/2018",
      "profileImage": "https://res.cloudinary.com/.../profile.jpg",
      "profilePhotoUrl": "https://res.cloudinary.com/.../profile.jpg",
      "lawType": "Family Law",
      "bestPracticeArea": "Family Law",
      "experience": 5,
      "experienceYears": 5,
      "city": "Lucknow",
      "state": "Uttar Pradesh",
      "pincode": "226001",
      "approvalStatus": "REJECTED",
      "rejectionReason": "Bar Council ID does not match certificate",
      "rejectedAt": "2026-10-12T06:00:00.000Z",
      "rejectedById": "admin",
      "submittedForApprovalAt": "2026-10-10T09:00:00.000Z",
      "accountStatus": "ACTIVE",
      "callAvailability": false,
      "createdAt": "2026-10-01T10:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "totalPages": 1
  }
}
```

---

### 3.3 `GET /api/admin/advocates` [CHANGED]
- **Middleware:** `requireAuth`, `requirePermission('advocates:view')`, `generalLimiter`
- **Additive Changes:**
  - Adds optional `approvalStatus` query parameter (`PENDING`, `APPROVED`, `REJECTED`, case-insensitive).
  - Validation: If provided and not in `['PENDING', 'APPROVED', 'REJECTED']`, returns `400 Bad Request` with message: `"Invalid approvalStatus. Allowed: PENDING, APPROVED, REJECTED"`.
  - Default behavior: When omitted, filters by `{}` (unfiltered), exactly preserving the existing behavior.
  - Adds `rejectedAt: adv.rejectedAt || null` to each advocate object in the response.

#### Sample Response (`200 OK` with `?approvalStatus=REJECTED`):
```json
{
  "success": true,
  "advocates": [
    {
      "id": "e81d7398-319b-4322-bfa1-d419a71b8e19",
      "name": "Adv. Suresh Verma",
      "fullName": "Adv. Suresh Verma",
      "email": "suresh.verma@example.com",
      "phone": "9876543299",
      "status": "ACTIVE",
      "accountStatus": "ACTIVE",
      "approvalStatus": "REJECTED",
      "callAvailability": false,
      "rejectionReason": "Bar Council ID does not match certificate",
      "submittedForApprovalAt": "2026-10-10T09:00:00.000Z",
      "approvedAt": null,
      "rejectedAt": "2026-10-12T06:00:00.000Z",
      "likeCount": 0,
      "lawType": "Family Law",
      "barCouncilId": "UP/5432/2018",
      "state": "Uttar Pradesh",
      "city": "Lucknow",
      "pincode": "226001",
      "isOnline": false,
      "lastSeenAt": null,
      "createdAt": "2026-10-01T10:00:00.000Z"
    }
  ]
}
```

---

### 3.4 `GET /api/admin/advocates/:advocateId` [VERIFIED]
- Confirmed that this endpoint already queries the full `Advocate` record and returns `rejectionReason`, `rejectedAt`, `submittedForApprovalAt`, and `approvedAt`.
- We will refactor the response mapping to reuse the common `formatAdvocateReviewData(advocate)` helper, ensuring identical output.

---

## 4. Permission Changes

- In `prisma/seedRbac.js`, append to `DEFAULT_PERMISSIONS`:
  ```javascript
  {
    code: 'advocates:edit',
    name: 'Edit Advocate Profiles',
    module: 'ADVOCATES',
    description: 'Permission to edit advocate profile data (pending, rejected or approved) from the admin panel'
  }
  ```
- Do **NOT** add to `CONTENT_CREATOR_PERMISSIONS` or `LEAD_USER_PERMISSIONS`.
- The main Admin account bypasses permission checks and automatically possesses this capability.
- Seeding via `node prisma/seedRbac.js` is idempotent (`upsert` by `code`).

---

## 5. Potential Risks & Mitigations

1. **Route Shadowing**:
   - *Risk:* If `GET /advocates/rejected` is placed after `GET /advocates/:advocateId`, Express router treats `"rejected"` as the `:advocateId` parameter.
   - *Mitigation:* Mount `GET /advocates/rejected` before `GET /advocates/:advocateId` in `src/routes/admin.routes.js`. Verified by route dump inspection.
2. **Accidental Approval Status Reset**:
   - *Risk:* Admin edit unintentionally altering `approvalStatus` or clearing `rejectionReason`.
   - *Mitigation:* `updateData` strictly excludes approval fields (`approvalStatus`, `rejectionReason`, `approvedAt`, `rejectedAt`, `submittedForApprovalAt`).
3. **Sensitive Field Leaks**:
   - *Risk:* Returning `passwordHash` or `aadhaarNumber` in edit or detail responses.
   - *Mitigation:* Common formatter `formatAdvocateReviewData` explicitly destructures `{ passwordHash, aadhaarNumber, ...safeAdvocate }` and excludes them from all response objects.
4. **Zod Strict Mode Inheritance**:
   - *Risk:* `.extend()` losing `.strict()` mode.
   - *Mitigation:* Explicitly apply `.strict()` on `adminAdvocateProfileUpdateSchema` after `.extend()`.
5. **Decimal & Array Comparison Precision**:
   - *Risk:* False positives in `changedFields` due to Prisma Decimal instance comparisons or array order.
   - *Mitigation:* Normalize Decimals with `Number(val)` and arrays with `JSON.stringify()`.

---

## 6. Answers to Open Questions & Recommendations

1. **Edit History Audit Table**:
   - *Question:* Without a schema change we only log to console and return `changedFields`. Do we want a permanent audit table (e.g. `AdvocateAdminEdit`)? That needs a migration.
   - *Answer / Recommendation:* **Keep console logging and `changedFields` in the response for this task (no schema change / migration).** If compliance demands permanent audit logging later, an independent `AdminAuditLog` migration can be introduced without impacting API contracts.
2. **Rejection History on Resubmission**:
   - *Question:* When a rejected advocate re-submits, the old `rejectionReason` is cleared and lost. Keep it that way, or store the history (needs a migration)?
   - *Answer / Recommendation:* **Keep it that way (no schema change).** The current workflow in `submitForApproval` clears `rejectionReason: null` when an advocate re-submits for approval. Preserving rejection history requires an `AdvocateRejectionHistory` relation or JSON field, which would require a database migration.
3. **Notify the Advocate on Admin Edit**:
   - *Question:* Should the advocate get an email/SMS when the admin edits their profile?
   - *Answer / Recommendation:* **Default to NO.** Admin corrections (typos, court categorization, formatting) prior to approval should be seamless and non-intrusive.
4. **Admin Profile Photo Upload**:
   - *Question:* Should the admin also be able to replace an advocate's profile photo (new multipart endpoint `POST /api/admin/advocates/:advocateId/photo`)?
   - *Answer / Recommendation:* **Default to NOT in this task.** Keeps the scope focused and avoids introducing multipart file upload pipelines on admin advocate management.
5. **Location Coordinates on Pincode/City Change**:
   - *Question:* If the admin changes `pincode`/`city`, `latitude`/`longitude` stay old. The advocate's own edit behaves the same way. Keep it like that?
   - *Answer / Recommendation:* **Default to YES.** Maintains exact parity with the advocate's own `updateProfile` without adding external geocoding dependencies.
6. **Pending List Advocates with `submittedForApprovalAt = null`**:
   - *Question:* Does `GET /api/admin/advocates/pending` also include advocates who never submitted (`submittedForApprovalAt = null`)?
   - *Finding / Confirmation:* **YES.** In `src/controllers/admin.controller.js` line 634, `listPendingAdvocates` queries `where: { approvalStatus: 'PENDING' }`. Because advocates default to `approvalStatus: 'PENDING'` upon initial registration with `submittedForApprovalAt: null`, any advocate who has registered but never submitted is currently included in the pending list. As instructed, we will report this finding and **not change** it in this task.

---

## 7. README.md Documentation Cleanup Plan (Task 6)

1. **Section 12.2**: Update text to specify that `POST /api/content-creator/login` was removed and back-office login is now unified under `POST /api/admin/login`.
2. **Section 13.4 (#2 & #3)**: Update to match current schema (`fullName`, `email`, `password`, `roleNames`, `roleIds`, returning `creator` / `creators` with `roles`, actual error statuses), with a pointer to Section 26.
3. **Section 13.2**: Remove hard-coded password and document that admin login relies on `ADMIN_USER_EMAIL` and `ADMIN_USER_PASSWORD` environment variables.
4. **Section 13.4 (#1 Unified Login)**: Align response payload samples with current implementation.
5. **Section 25.1**: Replace incorrect permission codes with actual codes (`acts:create`, `acts:update`, `act_pdfs:upload`, `act_pdfs:sync`, `act_pdfs:delete`), remove `bearer_acts:*`, and remove `xxx:*` wildcard references since `checkUserPermission` does not support wildcards.
6. **Section 24**: Note that content routes now live under `/api/admin/*` and point to Section 25.
7. **Bearer Acts Guide**: Remove references to nonexistent `POST /api/auth/blog/login`.
8. **Section 26 Step 10**: Fix broken `$` math LaTeX formatting arrow (`\rightarrow`) to clean Unicode `→`.
9. **Breaking Change Notice**: Restore concise breaking-change notice pointing to Sections 25–27.
10. **Section 27**: Add complete Postman guide for Admin Edit Advocate Profile & Rejected Profiles with the 18-step verification flow.
