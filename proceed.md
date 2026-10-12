# Implementation Plan: Restricting Roles to Admin-Panel Staff Accounts & Inline Role Assignment

This document outlines the detailed architecture, audit findings, proposed endpoint modifications, risk mitigations, and execution strategy for restricting RBAC roles exclusively to Admin-Panel staff accounts (`ContentCreator`) in the VakeelSetu backend.

---

## 1. Current Behaviour Found in Codebase

1. **Staff Account Creation Lacks Role Assignment & Validation:**
   - `POST /api/admin/content-creators` in `src/controllers/admin.controller.js` accepts `{ fullName, email, password }` with manual truthy checks and no Zod schema.
   - No roles or permissions are returned in the response or assigned during creation.
   - Callers currently have to call a separate endpoint (`POST /api/admin/users/:userId/roles`) to assign a role after creation.
   - Staff creation does not prevent creating an account whose email matches the environment admin credentials (`ADMIN_USER_EMAIL`), which would cause an account that can never log in because `POST /api/admin/login` prioritizes environment credentials.

2. **Staff Listing & Details Gap:**
   - `GET /api/admin/content-creators` returns only `{ id, fullName, email, isActive, createdAt }`. Assigned roles are completely missing from the listing.
   - There is no single staff detail route (`GET /api/admin/content-creators/:id`) to inspect a staff member's active roles and effective permissions.
   - There is no dedicated route (`PUT /api/admin/content-creators/:id/roles`) to update a staff member's role set.

3. **Polymorphic Leak in User Role Assignment (The Root Bug):**
   - In `src/services/rbac.service.js`, `assignRoleToUser` relies on `resolveUserAccount(userId, userType)`, which scans `prisma.user`, `prisma.contentCreator`, `prisma.advocate`, and `prisma.admin`.
   - Consequently, `POST /api/admin/users/:userId/roles` allows assigning roles to normal clients (`User`) and advocates (`Advocate`).
   - **Live DB Inspection Finding:** 3 records currently exist in `prisma.userRole`. 1 belongs to a `CONTENT_CREATOR`, while **2 records belong to `USER` accounts** with `LEAD_USER` and `CONTENT_CREATOR` roles assigned!

4. **Runtime Side-Effects on Normal Clients:**
   - In `src/services/auth.service.js` (`getCurrentUserProfile`), `prisma.userRole` is queried for both `user` and `content_creator`.
   - For `user`, it sets `role = assignedRoles[0] || 'USER'`. If a client was given `LEAD_USER`, their `req.user.role` becomes `'LEAD_USER'`. Consequently, `requireRole('USER')` on client features (like consultancy or likes) rejects the client with `403 Forbidden`.
   - In `src/middleware/auth.middleware.js` (`requireRole`), there is a fallback check `getUserRolesAndPermissions` that allows any user possessing a matching RBAC role name to bypass `requireRole('USER'|'ADVOCATE')`.
   - In `src/services/rbac.service.js` (`checkUserPermission`), permissions are evaluated for any user type rather than being restricted to staff accounts.

5. **No Guard Against Reserved System Role Names:**
   - In `src/validators/rbac.validator.js` (`createRoleSchema`, `updateRoleSchema`), there is no validation preventing users from creating custom roles named `ADMIN`, `USER`, or `ADVOCATE`.
   - **Live DB Inspection Finding:** Existing roles in the database are only `CONTENT_CREATOR` and `LEAD_USER`. No conflicting roles (`ADMIN`, `USER`, `ADVOCATE`) exist in the database.

---

## 2. Exact List of Files to Change

| File Path | Action | Description |
|---|---|---|
| `src/validators/admin.validator.js` | Modify | Add `createStaffAccountSchema` and `updateStaffRolesSchema`. |
| `src/controllers/admin.controller.js` | Modify | Update `createContentCreator`, update `listContentCreators` to include roles without N+1, add `getContentCreatorDetails`, and add `updateStaffRoles`. |
| `src/routes/admin.routes.js` | Modify | Register `GET /content-creators/:id` and `PUT /content-creators/:id/roles`. |
| `src/validators/rbac.validator.js` | Modify | Add reserved role names validation (`ADMIN`, `USER`, `ADVOCATE`) in `createRoleSchema` and `updateRoleSchema`. |
| `src/services/rbac.service.js` | Modify | Restrict `assignRoleToUser` strictly to `ContentCreator` (return 400 for clients/advocates); restrict `checkUserPermission` to `content_creator`; add `rolesAllowed: false` in `listUsersAdmin` and `getUserDetailsAdmin`. |
| `src/services/auth.service.js` | Modify | In `getCurrentUserProfile`, load RBAC roles only when `normalizedType === 'content_creator'`; enforce static `role: 'USER', roles: ['USER'], permissions: []` for clients. |
| `src/middleware/auth.middleware.js` | Modify | In `requireRole`, remove the RBAC role fallback lookup (`getUserRolesAndPermissions`). Allow only admin and exact base role match. |
| `scripts/cleanup-non-staff-roles.js` | **New** | Standalone script to detect and clean up orphaned/non-staff `UserRole` rows (supports dry run and `--apply`). |
| `package.json` | Modify | Add `"cleanup:non-staff-roles": "node scripts/cleanup-non-staff-roles.js"`. |
| `README.md` | Modify | Update RBAC notes, Section 25, and add Section 26 (`Staff Accounts & Role Assignment — Postman Guide`). |
| `proceed.md` | **New** | This implementation plan in the repo root. |

---

## 3. New and Changed Endpoints with Request/Response Samples

### 3.1 `POST /api/admin/content-creators` (Create Staff with Roles)
- **Middleware:** `requireAuth`, `requirePermission('content_creators:create')`, `generalLimiter`
- **Validation:**
  - `fullName`: string, trimmed, 2-100 characters.
  - `email`: string, valid email, trimmed, lowercase.
  - `password`: string, min 8 characters.
  - `roleIds`: optional array of UUIDs.
  - `roleNames`: optional array of trimmed uppercase strings.
  - `.strict()`
- **Privilege Escalation Guard:** If `roleIds` or `roleNames` are provided and caller is not main admin and lacks `roles:manage`, return `403 Forbidden` (`{"success": false, "message": "You need the roles:manage permission to assign roles."}`).
- **Default:** If neither `roleIds` nor `roleNames` provided, defaults to `['CONTENT_CREATOR']`.
- **Pre-flight Role Validation:** Validates that all requested roles exist and are active. If any fail, returns `400 Bad Request` with `invalidRoles: [...]` without creating the staff record.
- **Atomic Transaction:** Creates `contentCreator` and assigns `userRole` rows in one `prisma.$transaction`.

#### Request Sample:
```json
POST /api/admin/content-creators
Authorization: Bearer <ADMIN_OR_STAFF_TOKEN>
Content-Type: application/json

{
  "fullName": "Blog Editor One",
  "email": "blog.editor@vakeelsetu.com",
  "password": "Editor@12345",
  "roleNames": ["BLOG_EDITOR"]
}
```

#### Response Sample (`201 Created`):
```json
{
  "success": true,
  "message": "Staff account created successfully",
  "creator": {
    "id": "e81d7398-319b-4322-bfa1-d419a71b8e19",
    "fullName": "Blog Editor One",
    "email": "blog.editor@vakeelsetu.com",
    "isActive": true,
    "accountType": "CONTENT_CREATOR",
    "roles": [
      {
        "id": "7649542a-d221-4f1b-87b6-19e34e56bc78",
        "name": "BLOG_EDITOR",
        "displayName": "Blog Editor"
      }
    ],
    "permissions": [
      "blogs:read",
      "blogs:create",
      "blogs:update",
      "blogs:delete"
    ],
    "createdAt": "2026-10-12T05:40:00.000Z"
  }
}
```

---

### 3.2 `GET /api/admin/content-creators` (List Staff with Roles)
- **Middleware:** `requireAuth`, `requirePermission('content_creators:view')`, `generalLimiter`
- **Optimization:** Loads staff accounts, collects IDs, and queries `prisma.userRole.findMany({ where: { userId: { in: ids } } })` with `include: { role: { select: { id: true, name: true, displayName: true, isActive: true } } }` in a single query (no N+1).

#### Response Sample (`200 OK`):
```json
{
  "success": true,
  "creators": [
    {
      "id": "e81d7398-319b-4322-bfa1-d419a71b8e19",
      "fullName": "Blog Editor One",
      "email": "blog.editor@vakeelsetu.com",
      "isActive": true,
      "roles": [
        {
          "id": "7649542a-d221-4f1b-87b6-19e34e56bc78",
          "name": "BLOG_EDITOR",
          "displayName": "Blog Editor",
          "isActive": true
        }
      ],
      "createdAt": "2026-10-12T05:40:00.000Z"
    }
  ]
}
```

---

### 3.3 `GET /api/admin/content-creators/:id` (Staff Details & Permissions)
- **Middleware:** `requireAuth`, `requirePermission('content_creators:view')`, `generalLimiter`
- Returns 404 (`"Staff account not found."`) if not found.
- If staff account has no active role, returns `roles: []`, `effectiveDefaultRole: "CONTENT_CREATOR"`, and populates `permissions` from the active seeded `CONTENT_CREATOR` role.

#### Response Sample (`200 OK`):
```json
{
  "success": true,
  "creator": {
    "id": "e81d7398-319b-4322-bfa1-d419a71b8e19",
    "fullName": "Blog Editor One",
    "email": "blog.editor@vakeelsetu.com",
    "isActive": true,
    "accountType": "CONTENT_CREATOR",
    "roles": [
      {
        "id": "7649542a-d221-4f1b-87b6-19e34e56bc78",
        "name": "BLOG_EDITOR",
        "displayName": "Blog Editor",
        "isActive": true
      }
    ],
    "permissions": [
      "blogs:read",
      "blogs:create",
      "blogs:update",
      "blogs:delete"
    ],
    "createdAt": "2026-10-12T05:40:00.000Z",
    "updatedAt": "2026-10-12T05:40:00.000Z"
  }
}
```

---

### 3.4 `PUT /api/admin/content-creators/:id/roles` (Update Staff Roles)
- **Middleware:** `requireAuth`, `requirePermission('roles:manage')`, `generalLimiter`
- **Validation:** `updateStaffRolesSchema` (`{ roleIds?: uuid[], roleNames?: string[] }`, `.strict()`, at least one role required).
- Validates that target staff account exists (else 404 `"Staff account not found."`).
- Validates that all roles exist and are active (else 400 with `invalidRoles`).
- Replaces role set inside a `prisma.$transaction`: `deleteMany({ where: { userId: id } })` then `createMany` with `userType: 'CONTENT_CREATOR'`.

#### Request Sample:
```json
PUT /api/admin/content-creators/e81d7398-319b-4322-bfa1-d419a71b8e19/roles
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{
  "roleNames": ["BLOG_EDITOR", "LEAD_USER"]
}
```

#### Response Sample (`200 OK`):
```json
{
  "success": true,
  "message": "Staff roles updated successfully",
  "creator": {
    "id": "e81d7398-319b-4322-bfa1-d419a71b8e19",
    "fullName": "Blog Editor One",
    "email": "blog.editor@vakeelsetu.com",
    "isActive": true,
    "accountType": "CONTENT_CREATOR",
    "roles": [
      {
        "id": "7649542a-d221-4f1b-87b6-19e34e56bc78",
        "name": "BLOG_EDITOR",
        "displayName": "Blog Editor",
        "isActive": true
      },
      {
        "id": "7990f52a-719b-490f-a463-b851b22268c8",
        "name": "LEAD_USER",
        "displayName": "Lead User",
        "isActive": true
      }
    ],
    "permissions": [
      "blogs:read",
      "blogs:create",
      "blogs:update",
      "blogs:delete",
      "users:view",
      "advocates:view",
      "feedback:view",
      "consultancy:view"
    ],
    "createdAt": "2026-10-12T05:40:00.000Z",
    "updatedAt": "2026-10-12T05:42:00.000Z"
  }
}
```

---

### 3.5 `POST /api/admin/users/:userId/roles` (Backward-Compatible Assignment Block)
- If `userId` exists in `prisma.contentCreator`, role is assigned with `userType: 'CONTENT_CREATOR'`.
- If `userId` exists in `prisma.user` or `prisma.advocate`:
  - Returns `400 Bad Request`: `{"success": false, "message": "Roles can only be assigned to Admin Panel (staff) accounts. Clients and advocates cannot have roles."}`
- If `userId` does not exist anywhere:
  - Returns `404 Not Found`: `{"success": false, "message": "Target staff account not found."}`

---

## 4. Data-Cleanup Plan

### 4.1 Root Cause & Target Rows
Currently, polymorphic `UserRole` rows exist where `userId` belongs to `User` rather than `ContentCreator`.
Our live database inspection revealed 2 such rows:
- `userId: "91205007-7870-496d-977d-4f594761380e"`, `userType: "USER"`, `roleId: "LEAD_USER"`
- `userId: "0346edaf-033c-422b-acff-500b4b914ca3"`, `userType: "USER"`, `roleId: "CONTENT_CREATOR"`

### 4.2 Cleanup Script: `scripts/cleanup-non-staff-roles.js`
- Located in root `scripts/` directory (outside `src/`).
- Logic:
  1. Initialize `PrismaClient`.
  2. Query all rows from `prisma.userRole` including `role: { select: { id: true, name: true } }`.
  3. Collect all unique `userId`s and query `prisma.contentCreator.findMany({ where: { id: { in: userIds } } })`.
  4. Collect `userId`s that do NOT match any `contentCreator`.
  5. Cross-reference non-staff `userId`s against `prisma.user` and `prisma.advocate` to label account kind (`USER`, `ADVOCATE`, or `NONE`).
  6. Format and display a clear CLI table containing: `userRoleId`, `userId`, `accountKind`, `roleName`.
  7. **Dry Run (Default):** If `--apply` flag is NOT passed, prints:
     `"DRY RUN COMPLETE: Found X non-staff user role(s). No rows were deleted. Run with '--apply' to delete."`
  8. **Apply (`--apply`):** Executes `prisma.userRole.deleteMany({ where: { id: { in: nonStaffRoleIds } } })` and prints:
     `"SUCCESS: Deleted X non-staff user role record(s)."`
- Added to `package.json`:
  ```json
  "cleanup:non-staff-roles": "node scripts/cleanup-non-staff-roles.js"
  ```
- Workflow: Run `npm run cleanup:non-staff-roles` $\rightarrow$ inspect table $\rightarrow$ run `npm run cleanup:non-staff-roles -- --apply`.

---

## 5. Potential Risks & Mitigations

1. **Risk: Privilege Escalation During Staff Creation**
   - *Scenario:* A staff user with `content_creators:create` creates another staff account and assigns them high-privilege roles like `ROLES_MANAGER` or `LEAD_USER` without having role-management authority.
   - *Mitigation:* Explicit check: if `roleIds` or `roleNames` are provided in the payload, the caller MUST either be the environment admin (`req.user.type === 'admin'`) or hold the `roles:manage` permission. Otherwise, return `403 Forbidden`.

2. **Risk: Reserved Role Name Collisions**
   - *Scenario:* Creating custom roles named `USER`, `ADVOCATE`, or `ADMIN` creates semantic ambiguity with base account types.
   - *Mitigation:* Added `.refine()` in `createRoleSchema` and `updateRoleSchema` rejecting `ADMIN`, `USER`, and `ADVOCATE` with message `"This role name is reserved."`. Verified that existing database roles only include `CONTENT_CREATOR` and `LEAD_USER`.

3. **Risk: Unintended Breaking of Legacy Client Tokens Prior to Cleanup**
   - *Scenario:* A client with an existing role in `userRole` tries to use client endpoints before the admin runs the cleanup script.
   - *Mitigation:* Fixed immediately at runtime in `getCurrentUserProfile` and `requireRole`: clients are strictly forced to `role: 'USER', roles: ['USER'], permissions: []` regardless of any leftover rows in `userRole`.

4. **Risk: N+1 Performance Issue on Staff Listing**
   - *Scenario:* Fetching roles individually for each staff account in `GET /api/admin/content-creators`.
   - *Mitigation:* Two-query approach with `userRole.findMany({ where: { userId: { in: creatorIds } } })` and grouping by `userId` in memory before mapping to response.

---

## 6. Open Questions / Confirmations

- **Default Role on Empty Request:** When a request creates a staff account without specifying `roleIds` or `roleNames`, it will automatically assign the active seeded `CONTENT_CREATOR` role. This preserves complete backward compatibility for callers expecting the account to be a default content creator.
- **Order of Routes:** `PUT /content-creators/:id/roles` will be registered in `admin.routes.js` alongside the other `/content-creators` routes.

---

## STOP FOR APPROVAL
Per Step 0 instructions: **No application code has been edited yet.** 
Please review this implementation plan (`proceed.md`) and reply with approval to proceed with execution.
