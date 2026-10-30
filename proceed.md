# Plan: Retire `completeAddress` & Consolidate to `officeAddress` Only

## 0. Prerequisite Check & Status
- **Profile Change Approval Task Status:** Fully implemented, verified with 14 passing unit tests, and documented in Section 34 of `README.md`.
- **Database Host:** `ep-weathered-hat-b47xszyr-pooler.c-6.us-east-2.aws.neon.tech` (Neon AWS US-East-2)
- **Constraint Compliance:** No writes will be made to the shared database before explicit user approval. All code changes stay strictly inside existing controllers, services, and validators. The backfill script is the sole new file allowed (`scripts/backfill-office-address.js`). No Prisma schema changes (columns remain in place).

---

## 1. Codebase Usage Audit (`file:line`)

Every occurrence of `completeAddress` across the codebase:

### Database & Schema (Unchanged as per hard constraint)
- `prisma/schema.prisma:195`: `completeAddress String?` on model `DeletedAdvocate` (archival table).
- `prisma/schema.prisma:255`: `completeAddress String?` on model `Advocate` (retained for rollback safety; will be dropped in a future task).

### Validators
- `src/validators/advocate.validator.js:263`: `completeAddress` defined in `advocateProfileUpdateBaseSchema`.
- `src/validators/admin.validator.js:75`: `adminAdvocateProfileUpdateSchema` extends `advocateProfileUpdateBaseSchema`.

### Controllers & Services
- `src/controllers/advocate.profile.controller.js:483`: `'completeAddress'` listed as a direct editable field in `updateProfile`.
- `src/controllers/advocate.profile.controller.js:850`: `completeAddress: advocate.completeAddress` returned in `getProfile`.
- `src/controllers/admin.controller.js:711, 729`: `formatAdvocateReviewData` spreads `...safeAdvocate` which includes `completeAddress`.
- `src/controllers/admin.controller.js:933`: `updateAdvocateProfile` writes `updateData.completeAddress`.
- `src/services/advocate.service.js:431`: `completeAddress: advocate.completeAddress` returned in public advocate profile.
- `src/services/auth.service.js:943`: `completeAddress: profile.completeAddress` returned in `getProfileService`.
- `src/services/savedLawyer.service.js:72`: `completeAddress: adv.completeAddress` returned in saved lawyers list.
- `src/services/advocateLike.service.js:133`: `completeAddress: adv.completeAddress` returned in liked advocates list.
- `src/services/advocateDeletion.service.js:125`: `completeAddress: advocate.completeAddress` snapshotted to `DeletedAdvocate`.

### Documentation
- `README.md`: Multiple request/response samples in sections 5, 8, 12, 16, 27, and 34.

---

## 2. Live Database Audit & Aggregate Counts

*Executed read-only inspection on DB Host: `ep-weathered-hat-b47xszyr-pooler.c-6.us-east-2.aws.neon.tech`*

| Metric | Count | Notes |
|---|---|---|
| **Total Advocates in Database** | **62** | |
| **`completeAddress` filled AND `officeAddress` empty** | **50** | **Target rows for backfill** |
| **Both `completeAddress` and `officeAddress` filled** | **0** | No conflicts; `officeAddress` would win |
| **Only `officeAddress` filled** | **0** | |
| **Neither filled (both null/empty)** | **12** | Unregistered or incomplete draft advocates |
| **To-copy rows: length < 10 characters** | **0** | None |
| **To-copy rows: length > 255 characters** | **0** | None |
| **To-copy rows: valid length (10 to 255 characters)** | **50** | 100% of rows satisfy `officeAddress` length rules |
| **Pending profile change containing `completeAddress`** | **0** | No pending approvals reference `completeAddress` |

---

## 3. Detailed Implementation Design

### Task 1: Stop Writing `completeAddress`
1. **Advocate Edit Profile (`PATCH /api/advocate/profile`):**
   - Intercept `completeAddress` in `validateLocationPairs` (or schema refinement). If present in payload, return HTTP `400 Bad Request` with message:
     ```text
     "completeAddress is no longer supported. Use officeAddress."
     ```
   - Remove `'completeAddress'` from the `DIRECT_FIELDS` array in `advocate.profile.controller.js`.
2. **Admin Edit Advocate (`PATCH /api/admin/advocates/:advocateId`):**
   - Inherits the same validator check via `advocateProfileUpdateBaseSchema` -> returns identical HTTP `400 Bad Request` if sent.
   - Remove line 933 in `src/controllers/admin.controller.js` (`if (validated.completeAddress !== undefined) updateData.completeAddress = validated.completeAddress;`).
3. **Registration:**
   - Verified that `startAdvocateRegistrationSchema`, `advocateRegistrationAddressSchema`, and `completeAdvocateRegistrationSchema` in `advocate.validator.js` do not accept `completeAddress`.

---

### Task 2: Stop Returning `completeAddress` & Read Fallback
Remove `completeAddress` from all API response payloads and return `officeAddress` instead.

To guarantee zero regression for the 50 advocates whose rows have not yet been migrated via `--apply`, implement a **read-only fallback** in response formatters:
```javascript
// TODO: remove fallback after backfill-office-address --apply
const officeAddress = advocate.officeAddress || advocate.completeAddress || null;
```

#### Files implementing the read fallback:
1. `src/controllers/advocate.profile.controller.js`:
   - `formatOfficeDetails`: `const address = advocate.officeAddress || advocate.completeAddress || null;`
   - `formatProfileChange`: for `officeAddress` current value, uses `advocate.officeAddress || advocate.completeAddress || null`.
   - `getProfile`: remove `completeAddress` property.
2. `src/controllers/admin.controller.js`:
   - `formatAdvocateReviewData`: destructure `completeAddress` out of `safeAdvocate`, set `officeAddress = advocate.officeAddress || advocate.completeAddress || null`.
   - `listPendingAdvocates` & `listRejectedAdvocates`: use fallback for `officeAddress` and `office.address`.
   - `getAdvocateProfileChangeDetails`: for `current` value of `officeAddress`, uses `advocate.officeAddress || advocate.completeAddress || null`.
3. `src/services/advocate.service.js`:
   - Public advocate profile (`getAdvocateById` / `formatAdvocateProfile`): remove `completeAddress`, use fallback for `officeAddress` and `office.address`.
   - Public search/list (`listAdvocates`): include `completeAddress: true` in `selectFields` to populate fallback on list items until backfilled.
4. `src/services/auth.service.js`:
   - `getProfileService`: remove `completeAddress`, use fallback for `officeAddress`.
5. `src/services/savedLawyer.service.js`:
   - Replace `completeAddress` with `officeAddress` (using fallback).
6. `src/services/advocateLike.service.js`:
   - Replace `completeAddress` with `officeAddress` (using fallback).

---

### Task 3: One-Time Backfill Script (`scripts/backfill-office-address.js`)
Following the pattern of `scripts/backfill-booking-ids.js`:
- Supports `--dry-run` (default) and `--apply`.
- Connects to Prisma and prints the DB host (redacting credentials).
- Queries advocates with:
  ```javascript
  where: {
    OR: [
      { officeAddress: null },
      { officeAddress: '' }
    ],
    completeAddress: { not: null }
  }
  ```
- Filters out whitespace-only entries.
- In `--dry-run`: prints row IDs that will be updated (IDs only, no personal addresses) and displays summary counts.
- In `--apply`: performs batch updates with `prisma.advocate.update` setting `officeAddress: row.completeAddress.trim()`. Does **not** clear `completeAddress` (kept for safety/rollback).
- Prints before/after summary counts.
- Completely idempotent (subsequent runs find 0 records to copy).

---

### Task 4: Documentation & Test Updates
1. `README.md`:
   - Add subsection in Section 34: **"Single address: officeAddress"** detailing the retirement of `completeAddress`, 400 error, and backfill execution steps.
   - Clean up remaining `completeAddress` occurrences in request/response examples.
2. `tests/advocateProfileChange.test.js`:
   - Add unit tests verifying `PATCH /api/advocate/profile` and admin edit return `400` with `"completeAddress is no longer supported. Use officeAddress."`.
   - Add unit test verifying response formatting fallback logic (complete only -> office; both -> office; neither -> null).
   - Add unit test verifying backfill selection logic.

---

## 4. Sample Responses: Before vs After

### Advocate Own Profile (`GET /api/advocate/profile`)
#### Before:
```json
{
  "success": true,
  "profile": {
    "id": "c1f7b024-4f9e-4b42-8924-1b1574a23b32",
    "fullName": "Advocate Rajesh Sharma",
    "city": "New Delhi",
    "state": "Delhi",
    "pincode": "110001",
    "completeAddress": "Chamber 204, High Court Complex, New Delhi",
    "officeAddress": null,
    "office": {
      "address": null,
      "photoUrl": null,
      "latitude": null,
      "longitude": null
    }
  }
}
```

#### After:
```json
{
  "success": true,
  "profile": {
    "id": "c1f7b024-4f9e-4b42-8924-1b1574a23b32",
    "fullName": "Advocate Rajesh Sharma",
    "city": "New Delhi",
    "state": "Delhi",
    "pincode": "110001",
    "officeAddress": "Chamber 204, High Court Complex, New Delhi",
    "office": {
      "address": "Chamber 204, High Court Complex, New Delhi",
      "photoUrl": null,
      "latitude": null,
      "longitude": null
    }
  }
}
```

### Attempting to Send `completeAddress` (`PATCH /api/advocate/profile`)
#### Response:
```json
{
  "success": false,
  "message": "completeAddress is no longer supported. Use officeAddress."
}
```

---

## 5. Potential Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Client app or mobile app still sends `completeAddress` on profile update | Validation rejects with clear message: `"completeAddress is no longer supported. Use officeAddress."`. |
| Un-backfilled old advocates have null `officeAddress` immediately after deploy | Response formatters include read-only fallback `officeAddress = advocate.officeAddress || advocate.completeAddress || null`. |
| Overwriting custom office address in backfill | Backfill query explicitly filters `OR: [{ officeAddress: null }, { officeAddress: '' }]` — never overwrites existing `officeAddress`. |
| Database write accidents during testing | All tests mock/stub Prisma; dry-run mode is strictly read-only. DB changes applied only by user. |

---

## 6. Answers to Open Questions

1. **Old advocates whose `completeAddress` is under 10 / over 255 chars:**
   - **Audit Result:** Exactly **0** advocates in the live database have `completeAddress` under 10 or over 255 characters. All 50 records fall cleanly within 10–255 characters.
   - **Recommendation:** Standard profile-edit validation (10–255 chars) should be enforced when they edit their office address in the future.
2. **Is `completeAddress` used by any search/filter (e.g. "advocates near me" by text)?**
   - **Audit Result:** **No.** Search in `advocate.service.js` and `admin.controller.js` filters strictly by `fullName`, `topCourtPractised`, `city`, `state`, and `practiceAreas`. Location distance sorting is calculated using `latitude` / `longitude` (which is linked to office coordinates) and `pincode`. `completeAddress` was never used in any search or filter.

---

## 7. STOP — Awaiting User Approval
Execution is paused. Please reply with **`approved`** to proceed with code implementation, unit tests, and dry-run execution.
