# Plan: Rename Account Type "Content Creator" → "Staff" (Option 2)

## Database Host Verification
**DB Host:** `ep-weathered-hat-b47xszyr-pooler.c-6.us-east-2.aws.neon.tech` (shared Neon DB / production - no test records will be written; tests will use stubbed mocks).

---

## Answers to Step 0 Questions

### 1. Database Enum & Storage Analysis
- **Is `CONTENT_CREATOR` a Postgres enum value stored in DB columns?**
  **YES.** It is a value defined in the PostgreSQL enum `AccountType`:
  ```prisma
  enum AccountType {
    USER
    ADVOCATE
    CONTENT_CREATOR
    ADMIN
  }
  ```
- **Which columns use `AccountType` and what are the row counts?**
  - `UserRole.userType`: Enum `AccountType`. **12 rows** currently store `'CONTENT_CREATOR'`.
  - `RegistrationSession.accountType`: Enum `AccountType`. **0 rows** currently store `'CONTENT_CREATOR'`.
  - `OtpVerification.accountType`: Enum `AccountType`. **0 rows** currently store `'CONTENT_CREATOR'`.
- **String columns (non-enum):**
  - `HelpRequest.respondedByType`: String (`VARCHAR`). **0 rows** currently store `'CONTENT_CREATOR'`.
- **Table `ContentCreator` total rows:** **24 rows** (table is NOT renamed in DB; mapped via `@@map("ContentCreator")`).

### 2. JWT Expiry for Staff Tokens
- **Expiry:** **`1d`** (24 hours / 86,400 seconds), configured via `JWT_EXPIRES_IN = '1d'` in `src/utils/jwt.js`.

### 3. Response Keys Returned to Frontend Today
- **Unified Login (`POST /api/admin/login`)**:
  - `admin.accountType`: `"CONTENT_CREATOR"`
  - `token`: JWT containing `{ id: "<uuid>", type: "content_creator" }`
  - `admin.roles`: Array of active roles (e.g. `["CONTENT_CREATOR"]` or custom roles)
  - `admin.permissions`: Array of assigned permissions
- **Create Staff (`POST /api/admin/content-creators`)**:
  - Key: `creator: { id, name, fullName, email, isActive, accountType: "CONTENT_CREATOR", role, roles, roleDetails, permissions, createdAt }`
- **List Staff (`GET /api/admin/content-creators`)**:
  - Key: `creators: [ { id, name, fullName, email, isActive, createdAt, role, roles, roleDetails } ]`
- **Staff Details (`GET /api/admin/content-creators/:id`)**:
  - Key: `creator: { id, name, fullName, email, isActive, accountType: "CONTENT_CREATOR", role, roles, roleDetails, permissions, createdAt, updatedAt }`
- **Update Staff Roles (`PUT /api/admin/content-creators/:id/roles`)**:
  - Key: `creator: { id, name, fullName, email, isActive, accountType: "CONTENT_CREATOR", role, roles, roleDetails, permissions, createdAt, updatedAt }`
- **Public Blog Reads (`formatBlogResponse`)**:
  - Key: `contentCreator: { id, name, image, bio }` (author metadata)

---

## Hit List Classification (grep "content.?creator")

Hits are classified into four categories:
- **(a) Account Type**: Prisma model, enum value, JWT `type`, `requireRole` / account type checks, `accountType` in API responses
- **(b) RBAC Role `CONTENT_CREATOR`**: Role table row (`Role.name = 'CONTENT_CREATOR'`), kept **strictly unchanged**
- **(c) Routes & Response Keys**: Route endpoints (`/api/admin/content-creators`), response property keys (`creators`, `creator`, etc.)
- **(d) Relations & Columns**: Prisma model relations (`creator`, `author`) and foreign keys (`createdBy`, `authorId`)

### Code Hits Classification

| File | Line | Category | Current Code Snippet | Plan / Action |
|---|---|---|---|---|
| `prisma/schema.prisma` | 13 | **(a)** | `CONTENT_CREATOR` (in `enum AccountType`) | Keep for phase A transition; add `STAFF`. Add comment `// legacy, remove in phase B` |
| `prisma/schema.prisma` | 472 | **(a)** | `model ContentCreator {` | Rename to `model Staff { ... @@map("ContentCreator") }` |
| `prisma/schema.prisma` | 474 | **(a)** | `fullName String @default("Content Creator")` | Update default to `"Staff"` |
| `prisma/schema.prisma` | 500 | **(d)** | `creator ContentCreator? @relation(fields: [createdBy]...` on `UserRight` | Change type to `Staff?` |
| `prisma/schema.prisma` | 514 | **(d)** | `creator ContentCreator? @relation(fields: [createdBy]...` on `Guide` | Change type to `Staff?` |
| `prisma/schema.prisma` | 529 | **(d)** | `creator ContentCreator? @relation(fields: [createdBy]...` on `Update` | Change type to `Staff?` |
| `prisma/schema.prisma` | 550 | **(d)** | `creator ContentCreator @relation(fields: [createdBy]...` on `IPCSection` | Change type to `Staff` |
| `prisma/schema.prisma` | 573 | **(d)** | `creator ContentCreator @relation(fields: [createdBy]...` on `BNSSection` | Change type to `Staff` |
| `prisma/schema.prisma` | 602 | **(d)** | `author ContentCreator @relation(fields: [authorId]...` on `Blog` | Change type to `Staff` |
| `src/controllers/admin.controller.js` | 33 | **(a)** | `Validates credentials against environment variables (Admin) or ContentCreator table (Staff)` | Update comment to refer to Staff |
| `src/controllers/admin.controller.js` | 68-70 | **(a)** | `prisma.contentCreator.findUnique` in `loginAdmin` | `prisma.staff.findUnique` |
| `src/controllers/admin.controller.js` | 77 | **(a)** | `signToken({ id: creator.id, type: 'content_creator' })` | Change new tokens to `type: 'staff'` |
| `src/controllers/admin.controller.js` | 84 | **(a)** | `getCurrentUserProfile(creator.id, 'content_creator')` | Change to `'staff'` |
| `src/controllers/admin.controller.js` | 90 | **(a)** | `accountType: 'CONTENT_CREATOR'` in login response | Change to `'staff'` in login response |
| `src/controllers/admin.controller.js` | 91 | **(b)** | `roles: profile?.roles \|\| ['CONTENT_CREATOR']` | Keep RBAC role `CONTENT_CREATOR` unchanged |
| `src/controllers/admin.controller.js` | 112 | **(c)** | `export const createContentCreator = async...` | Export `createStaffAccount` (and alias `createContentCreator`) |
| `src/controllers/admin.controller.js` | 129 | **(a)** | `prisma.contentCreator.findUnique` | `prisma.staff.findUnique` |
| `src/controllers/admin.controller.js` | 158 | **(b)** | `targetRoleNames = ['CONTENT_CREATOR']` | Keep default RBAC role fallback `CONTENT_CREATOR` unchanged |
| `src/controllers/admin.controller.js` | 230 | **(a)** | `tx.contentCreator.create(...)` | `tx.staff.create(...)` |
| `src/controllers/admin.controller.js` | 238 | **(a)** | `userType: 'CONTENT_CREATOR'` in `UserRole` creation | Write `STAFF` (after Migration A enum add) |
| `src/controllers/admin.controller.js` | 254-273 | **(c)** | Response payload formatting with key `creator` and `accountType: 'CONTENT_CREATOR'` | Shared formatter supporting `legacyKeys` flag: new route returns `staffMember` + `accountType: "staff"`, old route returns `creator` + `accountType: "CONTENT_CREATOR"` |
| `src/controllers/admin.controller.js` | 280 | **(c)** | `export const listContentCreators = async...` | Export `listStaffAccounts` (and alias `listContentCreators`) |
| `src/controllers/admin.controller.js` | 282 | **(a)** | `prisma.contentCreator.findMany(...)` | `prisma.staff.findMany(...)` |
| `src/controllers/admin.controller.js` | 324-325 | **(b)** | `role: roleNames[0] \|\| 'CONTENT_CREATOR'`, `['CONTENT_CREATOR']` | Keep RBAC role fallback unchanged |
| `src/controllers/admin.controller.js` | 338 | **(c)** | `res.status(200).json({ success: true, creators: ... })` | Shared formatter: new route returns `{ success: true, staff: ... }`, old route returns `{ success: true, creators: ... }` |
| `src/controllers/admin.controller.js` | 348 | **(c)** | `export const getContentCreatorDetails = async...` | Export `getStaffAccountDetails` (and alias `getContentCreatorDetails`) |
| `src/controllers/admin.controller.js` | 352 | **(a)** | `prisma.contentCreator.findUnique(...)` | `prisma.staff.findUnique(...)` |
| `src/controllers/admin.controller.js` | 409-425 | **(b)** | `effectiveDefaultRole = 'CONTENT_CREATOR'`, findUnique role `CONTENT_CREATOR` | Keep RBAC role lookup unchanged |
| `src/controllers/admin.controller.js` | 433-450 | **(c)** | Detail response with key `creator` and `accountType: 'CONTENT_CREATOR'` | Shared formatter: new route returns `staffMember` + `accountType: "staff"`, old route returns `creator` + `accountType: "CONTENT_CREATOR"` |
| `src/controllers/admin.controller.js` | 457 | **(c)** | Comment: `PUT /api/admin/content-creators/:id/roles` | Update comment to include `/api/admin/staff/:id/roles` |
| `src/controllers/admin.controller.js` | 464 | **(a)** | `prisma.contentCreator.findUnique(...)` | `prisma.staff.findUnique(...)` |
| `src/controllers/admin.controller.js` | 548 | **(a)** | `userType: 'CONTENT_CREATOR'` in `UserRole.createMany` | Write `STAFF` |
| `src/controllers/admin.controller.js` | 567-584 | **(c)** | Update roles response with key `creator` and `accountType: 'CONTENT_CREATOR'` | Shared formatter: new route returns `staffMember` + `accountType: "staff"`, old route returns `creator` + `accountType: "CONTENT_CREATOR"` |
| `src/routes/admin.routes.js` | 13-16 | **(c)** | Mounts `/content-creators*` | Add `/staff*` routes; keep `/content-creators*` as deprecated aliases with `Deprecation: true` & `Link` header |
| `src/services/auth.service.js` | 525 | **(a)** | `else if (normalizedType === 'content_creator') {` | Accept both `'staff'` and legacy `'content_creator'` (`// TODO: remove legacy "content_creator" after transition`) |
| `src/services/auth.service.js` | 526 | **(a)** | `prisma.contentCreator.findUnique(...)` | `prisma.staff.findUnique(...)` |
| `src/services/auth.service.js` | 557 | **(a)** | `else if (normalizedType === 'content_creator') {` | Accept both `'staff'` and legacy `'content_creator'` |
| `src/services/auth.service.js` | 592 | **(b)** | `assignedRoles.length > 0 ? assignedRoles : ['CONTENT_CREATOR']` | Keep RBAC role fallback unchanged |
| `src/services/auth.service.js` | 596 | **(a)** | `type: 'content_creator'` in returned profile | Set `type: 'staff'` |
| `src/services/auth.service.js` | 597 | **(b)** | `role: 'CONTENT_CREATOR'` in returned profile | Keep RBAC role fallback unchanged |
| `src/services/rbac.service.js` | 467-469 | **(a)** | `else if (normalizedType === 'CONTENT_CREATOR')` in `resolveUserAccount` | Accept `'STAFF'` and legacy `'CONTENT_CREATOR'` |
| `src/services/rbac.service.js` | 468, 482, 499 | **(a)** | `prisma.contentCreator.findUnique(...)` | `prisma.staff.findUnique(...)` |
| `src/services/rbac.service.js` | 545, 550 | **(a)** | `userType: 'CONTENT_CREATOR'` in `assignRoleToUser` | Write `STAFF` |
| `src/services/rbac.service.js` | 671 | **(a)** | `if (userType && userType.toLowerCase() !== 'content_creator')` | Accept both `'staff'` and legacy `'content_creator'` |
| `src/services/rbac.service.js` | 685-689 | **(a) & (b)** | `if (userType && userType.toLowerCase() === 'content_creator' && roleNames.length === 0)` querying role `'CONTENT_CREATOR'` | Check `(userType === 'staff' \|\| userType === 'content_creator')`; keep target role query `name: 'CONTENT_CREATOR'` |
| `src/controllers/actPdf.controller.js` | 39, 304, 347, 382 | **(a) & (b)** | `const isContentCreator = rawRole === 'CONTENT_CREATOR' \|\| (req.user?.type && req.user.type.toLowerCase() === 'content_creator');` | Rename variable to `isStaffOrCreator`; check `rawRole === 'CONTENT_CREATOR' \|\| (req.user?.type && (req.user.type.toLowerCase() === 'staff' \|\| req.user.type.toLowerCase() === 'content_creator'))` |
| `src/controllers/userRight.controller.js` | 49, 183, 260 | **(a) & (b)** | Same check as above | Update to accept `'staff'` and legacy `'content_creator'` |
| `src/controllers/userRight.controller.js` | 75-76 | **(a)** | `if (req.user.type !== 'content_creator') ... prisma.contentCreator.findFirst` | Check `!== 'staff' && req.user.type !== 'content_creator'`; query `prisma.staff.findFirst` |
| `src/controllers/help.controller.js` | 109 | **(a)** | `type: 'CONTENT_CREATOR'` in responder info | Change to `type: 'STAFF'` |
| `src/controllers/bearerAct.controller.js` | 25 | **(c)** | `export const contentCreatorWriteHandler = ...` | Export `staffWriteHandler` (and alias `contentCreatorWriteHandler`) |
| `src/controllers/bearerAct.controller.js` | 29 | **(a) & (b)** | Role & type check | Update to accept `'staff'` and legacy `'content_creator'` |
| `src/controllers/bearerAct.controller.js` | 38 | **(a)** | `validator.contentCreatorWriteSchema.parse(...)` | Rename schema to `staffWriteSchema` (with alias) |
| `src/routes/bearerAct.routes.js` | 19 | **(c)** | `bearerActController.contentCreatorWriteHandler` | Use `staffWriteHandler` (alias supported) |
| `src/validators/bearerAct.validator.js` | 25 | **(a)** | `export const contentCreatorWriteSchema = ...` | Export `staffWriteSchema` (and alias `contentCreatorWriteSchema`) |
| `src/validators/rbac.validator.js` | 61 | **(a)** | `userType: z.enum(['USER', 'CONTENT_CREATOR', 'ADVOCATE', 'ADMIN'])` | Add `'STAFF'` to enum: `['USER', 'STAFF', 'CONTENT_CREATOR', 'ADVOCATE', 'ADMIN']` |
| `src/controllers/bns.controller.js` | 33, 103 | **(a) & (b)** | Role & type check | Update to accept `'staff'` and legacy `'content_creator'` |
| `src/controllers/bns.controller.js` | 57-58 | **(a)** | `req.user.type !== 'content_creator'` & `prisma.contentCreator.findFirst` | Update to `!== 'staff' && !== 'content_creator'` & `prisma.staff.findFirst` |
| `src/controllers/ipc.controller.js` | 33, 103 | **(a) & (b)** | Role & type check | Update to accept `'staff'` and legacy `'content_creator'` |
| `src/controllers/ipc.controller.js` | 57-58 | **(a)** | `req.user.type !== 'content_creator'` & `prisma.contentCreator.findFirst` | Update to `!== 'staff' && !== 'content_creator'` & `prisma.staff.findFirst` |
| `src/controllers/guide.controller.js` | 26, 137, 188 | **(a) & (b)** | Role & type check | Update to accept `'staff'` and legacy `'content_creator'` |
| `src/controllers/guide.controller.js` | 38-39 | **(a)** | `req.user.type !== 'content_creator'` & `prisma.contentCreator.findFirst` | Update to `!== 'staff' && !== 'content_creator'` & `prisma.staff.findFirst` |
| `src/controllers/update.controller.js` | 27, 139, 191 | **(a) & (b)** | Role & type check | Update to accept `'staff'` and legacy `'content_creator'` |
| `src/controllers/update.controller.js` | 39-40 | **(a)** | `req.user.type !== 'content_creator'` & `prisma.contentCreator.findFirst` | Update to `!== 'staff' && !== 'content_creator'` & `prisma.staff.findFirst` |
| `src/controllers/blog.controller.js` | 36 | **(c)** | `contentCreator: creatorData` in `mapBlogResponse` | Keep `contentCreator: creatorData` for backwards compatibility; also include `staff: creatorData` |
| `src/controllers/blog.controller.js` | 84-125 | **(a) & (c)** | `export const loginContentCreator` | Rename/alias to `loginStaff` returning `type: 'staff'` and key `staff` (legacy key preserved) |
| `src/controllers/blog.controller.js` | 135, 305, 413 | **(a) & (b)** | `req.user.type !== 'content_creator' && rawRole !== 'CONTENT_CREATOR'` | Accept `'staff'` as well as legacy `'content_creator'`; keep `rawRole !== 'CONTENT_CREATOR'` |
| `src/controllers/blog.controller.js` | 178-179 | **(a)** | `req.user.type !== 'content_creator'` & `prisma.contentCreator.findFirst` | Update to `!== 'staff' && !== 'content_creator'` & `prisma.staff.findFirst` |
| `prisma/seed.js` | 747-777 | **(a)** | Seeds trainee account using `prisma.contentCreator` | Update to `prisma.staff` |
| `prisma/seedRbac.js` | 77-79 | **(b)** | Permission module `CONTENT_CREATORS` / codes `content_creators:view`, `content_creators:create` | Keep permission codes exactly as they are so existing RBAC assignments stay untouched |
| `prisma/seedRbac.js` | 89, 168-207 | **(b)** | Seeds RBAC role `CONTENT_CREATOR` | Keep role name `CONTENT_CREATOR` unchanged |
| `prisma/seedRbac.js` | 291-313 | **(a)** | Links seeded account using `userType: 'CONTENT_CREATOR'` and `prisma.contentCreator` | Update to `prisma.staff` and `userType: 'STAFF'` |
| `scripts/cleanup-non-staff-roles.js` | 36, 76 | **(a)** | `prisma.contentCreator.findMany` | `prisma.staff.findMany` |
| `tests/advocateEarnings.test.js` | 646 | **(a) & (b)** | Mock user `{ role: 'CONTENT_CREATOR', type: 'CONTENT_CREATOR' }` | Keep test payload valid; both `'STAFF'` and `'CONTENT_CREATOR'` work |
| `README.md` | 218 occurrences | **(a), (c)** | Docs referring to Content Creator accounts, endpoints, and login responses | Update documentation: rename account type to Staff, add `/api/admin/staff*` table, document `/api/admin/content-creators*` as deprecated aliases, document legacy token acceptance. Explain Role `CONTENT_CREATOR` ≠ Account Type `Staff`. |

---

## Rename Map (Old → New)

| Scope | Old Identifier | New Identifier | Notes |
|---|---|---|---|
| **Prisma Model** | `model ContentCreator` | `model Staff` | Mapped via `@@map("ContentCreator")` (no table rename) |
| **Prisma Client** | `prisma.contentCreator` | `prisma.staff` | Code-only change |
| **Account Type Enum** | `CONTENT_CREATOR` | `STAFF` | Added to PostgreSQL enum `AccountType`; both valid in Phase A |
| **JWT Type** | `type: "content_creator"` | `type: "staff"` | Auth middleware & `getCurrentUserProfile` accept both |
| **Admin Login API** | `admin.accountType: "CONTENT_CREATOR"` | `admin.accountType: "staff"` | Returned at `POST /api/admin/login` |
| **Routes** | `POST /api/admin/content-creators` | `POST /api/admin/staff` | Old route preserved as deprecated alias |
| | `GET /api/admin/content-creators` | `GET /api/admin/staff` | Old route preserved as deprecated alias |
| | `GET /api/admin/content-creators/:id` | `GET /api/admin/staff/:id` | Old route preserved as deprecated alias |
| | `PUT /api/admin/content-creators/:id/roles` | `PUT /api/admin/staff/:id/roles` | Old route preserved as deprecated alias |
| **Response Keys** | `/api/admin/content-creators`: `{ creators: [...] }` | `/api/admin/staff`: `{ staff: [...] }` | Old route continues returning `creators` |
| | `/api/admin/content-creators/:id`: `{ creator: {...} }` | `/api/admin/staff/:id`: `{ staffMember: {...} }` | Old route continues returning `creator` |
| | `accountType: "CONTENT_CREATOR"` | `accountType: "staff"` | Old route returns `CONTENT_CREATOR`, new route returns `staff` |
| **Handlers** | `createContentCreator` | `createStaffAccount` | Original name exported as alias |
| | `listContentCreators` | `listStaffAccounts` | Original name exported as alias |
| | `getContentCreatorDetails` | `getStaffAccountDetails` | Original name exported as alias |
| | `contentCreatorWriteHandler` | `staffWriteHandler` | Original name exported as alias |
| **Validators** | `contentCreatorWriteSchema` | `staffWriteSchema` | Original name exported as alias |
| | `userType: z.enum(['...'])` | Accepts `'STAFF'` and `'CONTENT_CREATOR'` | Transition support |
| **RBAC Role** | Role `CONTENT_CREATOR` | **UNCHANGED** | Row in `Role` table is strictly preserved |

---

## Migration Plan (Task 3)

Since `AccountType` is a PostgreSQL enum stored in the database (`UserRole.userType`), we use the safe 2-step approach:

### Migration A (To be deployed after backup & explicit approval)
**File:** `prisma/migrations/20261128123000_add_staff_to_account_type_enum/migration.sql`
```sql
-- AlterEnum
ALTER TYPE "AccountType" ADD VALUE IF NOT EXISTS 'STAFF';
```
> **PostgreSQL Caveat:** In PostgreSQL, `ALTER TYPE ... ADD VALUE` cannot be executed inside a multi-statement transaction block alongside statements that use the new value. Migration A contains exclusively this single statement.

### Prisma Schema Update (`prisma/schema.prisma`)
```prisma
enum AccountType {
  USER
  ADVOCATE
  CONTENT_CREATOR // legacy, remove in phase B
  STAFF
  ADMIN
}

model Staff {
  id           String       @id @default(uuid())
  fullName     String       @default("Staff")
  email        String       @unique
  passwordHash String
  isActive     Boolean      @default(true)
  image        String?
  bio          String?
  createdAt    DateTime     @default(now())
  updatedAt    DateTime     @updatedAt
  blogs        Blog[]
  ipcSections  IPCSection[]
  bnsSections  BNSSection[]
  userRights   UserRight[]
  guides       Guide[]
  updates      Update[]

  @@map("ContentCreator")
}
```

### Backfill Script (`scripts/backfill-staff-type.js`)
- Supports `--dry-run` and `--apply`.
- Connects using Prisma / `DATABASE_URL`.
- Prints database host (`ep-weathered-hat-b47xszyr-pooler.c-6.us-east-2.aws.neon.tech`).
- Idempotently updates:
  ```sql
  UPDATE "UserRole" SET "userType" = 'STAFF' WHERE "userType" = 'CONTENT_CREATOR';
  ```
- Also checks and updates `RegistrationSession` and `OtpVerification` if any records exist.
- Reports row counts before and after.

---

## Files to Change / Rename

### Files to Change
1. `prisma/schema.prisma`
2. `prisma/migrations/20261128123000_add_staff_to_account_type_enum/migration.sql` (new migration file)
3. `src/services/auth.service.js`
4. `src/services/rbac.service.js`
5. `src/controllers/admin.controller.js`
6. `src/routes/admin.routes.js`
7. `src/controllers/help.controller.js`
8. `src/controllers/bearerAct.controller.js`
9. `src/validators/bearerAct.validator.js`
10. `src/validators/rbac.validator.js`
11. `src/controllers/actPdf.controller.js`
12. `src/controllers/userRight.controller.js`
13. `src/controllers/bns.controller.js`
14. `src/controllers/ipc.controller.js`
15. `src/controllers/guide.controller.js`
16. `src/controllers/update.controller.js`
17. `src/controllers/blog.controller.js`
18. `prisma/seed.js`
19. `prisma/seedRbac.js`
20. `scripts/cleanup-non-staff-roles.js`
21. `scripts/backfill-staff-type.js` (new backfill script)
22. `README.md`

### File Renames (`git mv`)
- No existing files need to be moved with `git mv`. All staff management logic is hosted in `admin.controller.js`, `admin.routes.js`, and `admin.validator.js`.

---

## Before & After Samples

### 1. Unified Login (`POST /api/admin/login`)

#### Before
```json
{
  "success": true,
  "message": "Admin login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjEyMyIsInR5cGUiOiJjb250ZW50X2NyZWF0b3IiLCJpYXQiOjE3...}",
  "admin": {
    "id": "c1f7a240-...",
    "fullName": "Amit Sharma",
    "email": "amit@vakeelsetu.com",
    "accountType": "CONTENT_CREATOR",
    "roles": ["CONTENT_CREATOR"],
    "permissions": ["blogs:create", "acts:create"]
  }
}
```

#### After
```json
{
  "success": true,
  "message": "Admin login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjEyMyIsInR5cGUiOiJzdGFmZiIsImlhdCI6MTcw...}",
  "admin": {
    "id": "c1f7a240-...",
    "fullName": "Amit Sharma",
    "email": "amit@vakeelsetu.com",
    "accountType": "staff",
    "roles": ["CONTENT_CREATOR"],
    "permissions": ["blogs:create", "acts:create"]
  }
}
```

---

### 2. Staff Listing (`GET /api/admin/staff` vs deprecated `GET /api/admin/content-creators`)

#### New Route (`GET /api/admin/staff`)
```json
{
  "success": true,
  "staff": [
    {
      "id": "c1f7a240-...",
      "fullName": "Amit Sharma",
      "name": "Amit Sharma",
      "email": "amit@vakeelsetu.com",
      "isActive": true,
      "createdAt": "2026-11-20T10:00:00.000Z",
      "role": "CONTENT_CREATOR",
      "roles": ["CONTENT_CREATOR"],
      "roleDetails": [
        {
          "id": "role-1",
          "name": "CONTENT_CREATOR",
          "displayName": "Content Creator",
          "isActive": true
        }
      ]
    }
  ]
}
```

#### Legacy Route (`GET /api/admin/content-creators`)
- **Headers:**
  - `Deprecation: true`
  - `Link: </api/admin/staff>; rel="successor-version"`
- **Body (unchanged from today):**
```json
{
  "success": true,
  "creators": [
    {
      "id": "c1f7a240-...",
      "fullName": "Amit Sharma",
      "name": "Amit Sharma",
      "email": "amit@vakeelsetu.com",
      "isActive": true,
      "createdAt": "2026-11-20T10:00:00.000Z",
      "role": "CONTENT_CREATOR",
      "roles": ["CONTENT_CREATOR"],
      "roleDetails": [
        {
          "id": "role-1",
          "name": "CONTENT_CREATOR",
          "displayName": "Content Creator",
          "isActive": true
        }
      ]
    }
  ]
}
```

---

## Risks & Mitigations

1. **Risk:** Disruption to active logged-in staff during deployment.
   - **Mitigation:** The auth middleware and `getCurrentUserProfile` accept both `type: "staff"` and `type: "content_creator"`. Staff with valid 24h JWT tokens stay logged in without needing to re-authenticate.
2. **Risk:** Frontend breaking due to sudden URL or response key changes.
   - **Mitigation:** The old routes (`/api/admin/content-creators*`) remain live as fully functioning aliases returning legacy keys (`creators`, `creator`, `accountType: "CONTENT_CREATOR"`). The new routes (`/api/admin/staff*`) return staff keys (`staff`, `staffMember`, `accountType: "staff"`).
3. **Risk:** RBAC permission loss or breakage on newly added features (advocate withdrawals, test management, booking hold, etc.).
   - **Mitigation:** The RBAC role `CONTENT_CREATOR` and all permission codes (`content_creators:view`, `payouts:*`, `tests:manage`, etc.) remain identical. Staff accounts retain their exact roles and permissions.
4. **Risk:** Accidental database table or foreign key changes during Prisma model rename.
   - **Mitigation:** `model Staff` uses `@@map("ContentCreator")`. Prisma relation names and foreign key columns remain unchanged. `npx prisma migrate diff` was verified to generate 0 table/column/FK changes.
5. **Risk:** Production database mutation on shared Neon DB during tests.
   - **Mitigation:** All test suites use stubbed unit tests and mocked Prisma delegates. No test records are written to Neon DB.
6. **Risk:** Migration deployment before database backup.
   - **Mitigation:** No `migrate deploy` will be run until you take a fresh Neon backup (`pg_dump`) and give your explicit "OK".

---

## Transition Plan

1. **Phase A (This Task):**
   - Apply `ALTER TYPE "AccountType" ADD VALUE IF NOT EXISTS 'STAFF';`
   - Code writes `STAFF` for new assignments, and reads both `STAFF` and `CONTENT_CREATOR`.
   - New staff routes (`/api/admin/staff*`) live with new keys.
   - Old staff routes (`/api/admin/content-creators*`) remain active with `Deprecation` header and legacy keys.
   - Auth middleware accepts both `staff` and `content_creator` tokens.
   - Backfill script provided for user execution.
2. **Backfill Execution:**
   - User runs `node scripts/backfill-staff-type.js --apply` after deployment.
3. **Frontend Cutover:**
   - Frontend switches to `/api/admin/staff` and new keys (`staff`, `staffMember`, `accountType: "staff"`).
4. **Phase B (Future Task, only when requested):**
   - Remove legacy routes, drop old enum value `CONTENT_CREATOR`, remove transition fallback code.

---

## Answers to Open Questions

1. **How long to keep the old routes/keys + legacy token type?**
   - **Recommendation:** Keep them live until the frontend has completed its migration to the new staff endpoints and confirmed in production. After frontend confirmation, a brief cleanup PR will remove the deprecated aliases.
2. **Are there other places (seed data, emails, admin dashboards) showing "Content Creator" to users?**
   - **Seed data:** `prisma/seed.js` seeds a default staff user with `fullName: "Content Creator"`. We will update its default name to `"Staff"`.
   - **RBAC Role Seed:** `prisma/seedRbac.js` seeds the role `CONTENT_CREATOR` with display name `"Content Creator"`. As instructed, this RBAC role remains untouched.
   - **Emails:** No customer-facing or advocate-facing emails reference "Content Creator".
   - **Help Requests:** `HelpRequest.respondedByType` records responder type (previously `CONTENT_CREATOR`, now `STAFF`). Note that public help request endpoints strictly omit internal responder audit fields from client-facing responses.
