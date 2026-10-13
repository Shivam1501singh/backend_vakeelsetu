# Plan: Help Requests in the Admin Panel with RBAC

## 1. Current Behaviour Analysis

### Public Endpoints (Unchanged)
- `POST /api/help` → `helpController.createRequest`
  - Validated by `helpRequestSchema` (requires `name`, `email`, `phoneNumber`, `concern`).
  - Generates secure reference ID with prefix `VKLS-` (e.g., `VKLS-XXXXXX`).
  - Returns `201 Created` with `{ success: true, message: "Your help request has been submitted successfully.", referenceId }`.
  - Rate limited by `helpLimiter` (5 requests / 15 minutes / IP).
- `POST /api/help/lookup` → `helpController.lookupRequest`
  - Validated by `helpLookupSchema` (requires `referenceId`, `email`).
  - Queries `HelpRequest` matching `referenceId` and verifies email to prevent enumeration.
  - Returns `200 OK` with `{ success: true, helpRequest }`.
  - Rate limited by `helpLimiter` (5 requests / 15 minutes / IP).

### Admin Endpoints & Security Vulnerability
- Route Mount: Mounted in `src/server.js` at `/api/admin/help` via `adminHelpRouter`.
- Endpoints:
  - `GET /api/admin/help` → `helpController.adminListRequests` (query: `page`, `limit`, `status`, `email`, `referenceId`)
  - `GET /api/admin/help/:id` → `helpController.adminGetDetails`
  - `PATCH /api/admin/help/:id` → `helpController.submitAdminResponse` (body: `{ response, status }`)
- **Security Vulnerability**:
  - The endpoints are guarded solely by a custom middleware checking the header `x-admin-secret` against `process.env.ADMIN_SECRET || 'super-admin-secret'`.
  - The fallback secret `'super-admin-secret'` is publicly documented in the repository's `README.md`.
  - No user/staff JWT or RBAC permission checks are performed.
  - Staff accounts cannot be granted access, and anyone possessing the default secret can access personal details (names, emails, phone numbers, and legal concerns) across all tickets.
- Data Model (`HelpRequest`):
  - Fields: `id`, `referenceId`, `name`, `email`, `phoneNumber`, `concern`, `response`, `status`, `createdAt`, `updatedAt`, `respondedAt`.
  - Does not record who handled or responded to the help ticket.

### Server Route Mounting Check
- In `src/server.js`:
  - Line 77: `app.use('/api/admin', adminRoutes);`
  - Line 84: `app.use('/api/admin/help', adminHelpRouter);`
- Inspection of `src/routes/admin.routes.js` and `src/routes/rbac.routes.js`:
  - Routes in `adminRoutes`: `/login`, `/content-creators`, `/advocates/*`, and `router.use('/', rbacRoutes)`.
  - Routes in `rbacRoutes`: `/roles/*`, `/permissions/*`, `/users/*`.
  - None of the routes intercept `/help` or `/help/*`.
  - Requests to `/api/admin/help` cleanly pass through to `adminHelpRouter`.

---

## 2. Files to Change

| File | Nature of Changes |
|---|---|
| `prisma/seedRbac.js` | Add `help:view` and `help:respond` permissions to `DEFAULT_PERMISSIONS`; seed idempotent `SUPPORT_EXECUTIVE` role. |
| `prisma/schema.prisma` | (Task 4) Add nullable fields `respondedById`, `respondedByType`, `respondedByName` to `HelpRequest`. |
| `prisma/migrations/20261013153000_add_help_request_responder/migration.sql` | (Task 4) Additive migration adding the 3 nullable columns. |
| `src/routes/help.routes.js` | Remove `requireAdmin` / `x-admin-secret` / `ADMIN_SECRET`; apply `requireAuth`, `requirePermission`, and `generalLimiter` to all admin routes. |
| `src/controllers/help.controller.js` | In `adminListRequests`, pass `search` query to service; in `submitAdminResponse`, extract responder details from `req.user` and pass to service. |
| `src/services/help.service.js` | Update `listAllHelpRequestsAdmin` with limit capping (max 100), `search` filter, and status `counts` calculation using `groupBy`. Update `respondToHelpRequest` with responder audit fields. Update `lookupHelpRequest` to exclude responder fields from public view. |
| `README.md` | Update Section 10 (replace `x-admin-secret` with JWT & permissions, remove `super-admin-secret`, fix sample ref ID, add phone number validation); add Section 28 (comprehensive Postman guide for Help Requests with RBAC). |
| `proceed.md` | This implementation plan and decision record. |

---

## 3. Endpoints Before & After

### A. Public Endpoints (Strictly Preserved)
- `POST /api/help`:
  - Request & Response: Unchanged.
  - Rate limiting: Unchanged (`helpLimiter`).
- `POST /api/help/lookup`:
  - Request: `{ "referenceId": "VKLS-XXXXXX", "email": "user@example.com" }` (Unchanged).
  - Response: `{ success: true, helpRequest: { ... } }`.
  - **Security Filter**: Responder audit fields (`respondedById`, `respondedByType`, `respondedByName`) are stripped from the returned object to preserve responder privacy.

### B. Admin Endpoints

#### 1. `GET /api/admin/help`
- **Auth Before**: Header `x-admin-secret: super-admin-secret`.
- **Auth After**: Header `Authorization: Bearer <token>` (Admin or Staff with `help:view`).
- **Query Params**:
  - `page`: Integer (default: 1; invalid values fallback to 1).
  - `limit`: Integer (default: 20; invalid values fallback to 20; capped at max 100).
  - `status`: `OPEN` | `IN_PROGRESS` | `RESOLVED` | `CLOSED` (optional).
  - `email`: Case-insensitive contains filter (optional).
  - `referenceId`: Exact reference ID filter (optional).
  - `search`: Optional search query across `name`, `email`, `phoneNumber`, `referenceId`, and `concern` (case-insensitive).
- **Response Format Before**:
  ```json
  {
    "success": true,
    "helpRequests": [ ... ],
    "pagination": { "total": 1, "page": 1, "limit": 20, "totalPages": 1 }
  }
  ```
- **Response Format After (Additive)**:
  ```json
  {
    "success": true,
    "helpRequests": [
      {
        "id": "help-uuid-1",
        "referenceId": "VKLS-8F4K29",
        "name": "Shivam Singh",
        "email": "user@example.com",
        "phoneNumber": "9876543210",
        "concern": "Unable to update profile.",
        "response": "Resolved the method block.",
        "status": "RESOLVED",
        "respondedById": "creator-uuid-1",
        "respondedByType": "CONTENT_CREATOR",
        "respondedByName": "Support Executive John",
        "respondedAt": "2026-10-13T10:00:00.000Z",
        "createdAt": "2026-10-13T09:00:00.000Z",
        "updatedAt": "2026-10-13T10:00:00.000Z"
      }
    ],
    "counts": {
      "OPEN": 5,
      "IN_PROGRESS": 2,
      "RESOLVED": 10,
      "CLOSED": 3,
      "total": 20
    },
    "pagination": {
      "total": 1,
      "page": 1,
      "limit": 20,
      "totalPages": 1
    }
  }
  ```

#### 2. `GET /api/admin/help/:id`
- **Auth Before**: Header `x-admin-secret: super-admin-secret`.
- **Auth After**: Header `Authorization: Bearer <token>` (Admin or Staff with `help:view`).
- **Response Format**: Includes `respondedById`, `respondedByType`, `respondedByName`.

#### 3. `PATCH /api/admin/help/:id`
- **Auth Before**: Header `x-admin-secret: super-admin-secret`.
- **Auth After**: Header `Authorization: Bearer <token>` (Admin or Staff with `help:respond`).
- **Request Body**:
  ```json
  {
    "response": "We have looked into this and resolved the issue.",
    "status": "RESOLVED"
  }
  ```
- **Response Format**:
  ```json
  {
    "success": true,
    "message": "Help request response submitted successfully",
    "helpRequest": {
      "id": "help-uuid-1",
      "referenceId": "VKLS-8F4K29",
      "name": "Shivam Singh",
      "email": "user@example.com",
      "phoneNumber": "9876543210",
      "concern": "Unable to update profile.",
      "response": "We have looked into this and resolved the issue.",
      "status": "RESOLVED",
      "respondedById": "admin",
      "respondedByType": "ADMIN",
      "respondedByName": "System Administrator",
      "respondedAt": "2026-10-13T10:00:00.000Z",
      "createdAt": "2026-10-13T09:00:00.000Z",
      "updatedAt": "2026-10-13T10:00:00.000Z"
    }
  }
  ```

---

## 4. Permission & Seed Changes (`prisma/seedRbac.js`)

1. **New Permissions**:
   ```javascript
   { code: 'help:view', name: 'View Help Requests', module: 'HELP', description: 'Permission to view help/support requests list and details' },
   { code: 'help:respond', name: 'Respond to Help Requests', module: 'HELP', description: 'Permission to reply to help requests and change their status' }
   ```
2. **New System Role**:
   - `name`: `'SUPPORT_EXECUTIVE'`
   - `displayName`: `'Support Executive'`
   - `description`: `'Can view and respond to help/support requests.'`
   - `isActive`: `true`
   - `isSystem`: `true`
   - Permissions: `['help:view', 'help:respond']`
3. **Execution**:
   - Idempotent upserts for permissions, role, and role-permissions.
   - Run command: `node prisma/seedRbac.js`.

---

## 5. Migration Details (Task 4)

- Schema update in `prisma/schema.prisma`:
  ```prisma
  model HelpRequest {
    id              String            @id @default(uuid())
    referenceId     String            @unique
    name            String
    email           String
    phoneNumber     String            @default("")
    concern         String            @db.Text
    response        String?           @db.Text
    status          HelpRequestStatus @default(OPEN)
    respondedById   String?
    respondedByType String?
    respondedByName String?
    createdAt       DateTime          @default(now())
    updatedAt       DateTime          @updatedAt
    respondedAt     DateTime?

    @@index([email])
    @@index([phoneNumber])
    @@index([status])
    @@index([createdAt])
  }
  ```
- Migration SQL:
  ```sql
  ALTER TABLE "HelpRequest" ADD COLUMN "respondedById" TEXT;
  ALTER TABLE "HelpRequest" ADD COLUMN "respondedByType" TEXT;
  ALTER TABLE "HelpRequest" ADD COLUMN "respondedByName" TEXT;
  ```
- **Safety**: Fully additive and nullable. No table lock issues, no default backfill needed, and 100% safe for existing database rows.

---

## 6. Risks & Mitigations

1. **Risk: Legacy clients broken by header removal**:
   - *Mitigation*: The legacy `x-admin-secret` was an insecure backdoor. Admin web portals already authenticate via unified `POST /api/admin/login` and send Bearer tokens. Returning `401 Unauthorized` clearly informs callers to use the standard session token.
2. **Risk: Public exposure of staff responder names/IDs**:
   - *Mitigation*: `lookupHelpRequest` explicitly destructures and omits `respondedById`, `respondedByType`, and `respondedByName` prior to returning the public payload.
3. **Risk: Performance overhead of `counts` aggregation**:
   - *Mitigation*: Implemented using a single Prisma `groupBy({ by: ['status'] })` on the indexed `status` column, grouped in a transaction with the main list queries.
4. **Risk: Pagination limit denial-of-service**:
   - *Mitigation*: `limit` is capped at maximum 100 items per request, with invalid or negative integers safely falling back to defaults.

---

## 7. Answers to Open Questions & Recommendations

1. **Task 4 Migration (record who responded)**:
   - **Recommendation**: **Approve**.
   - *Rationale*: Nullable audit fields (`respondedById`, `respondedByType`, `respondedByName`) provide vital accountability in the Admin Panel without breaking existing data.
2. **Old `x-admin-secret`**:
   - **Recommendation**: **Remove completely now**.
   - *Rationale*: The default secret is public in the git repository and documentation. Retaining it poses a security vulnerability. Removing it enforces proper RBAC token usage.
3. **LEAD_USER role access to `help:view`**:
   - **Recommendation**: **Do not add (Default: No)**.
   - *Rationale*: `LEAD_USER` is designated for platform operations (users, advocates, feedback, consultancy). Help requests should be isolated to `SUPPORT_EXECUTIVE` or custom roles designated by the admin.
4. **Ticket Assignment (`assignedToId`)**:
   - **Recommendation**: **Skip in this task (Default: No)**.
   - *Rationale*: Keep this task focused on RBAC permissions and responder logging. Assignment workflows can be added in a future iteration if needed.
5. **Notifications (Email user on response)**:
   - **Recommendation**: **Skip in this task (Default: No)**.
   - *Rationale*: Public lookup via `referenceId` and `email` is already the designed workflow. Adding transactional email here would expand scope unnecessarily.

---

## 8. Next Step
Waiting for user approval ("approved") before making any code modifications.
