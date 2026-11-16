# Implementation Plan: Advocate Qualification Test & Admin Question Bank

## Database Host (Production Neon DB)
- **Host:** `ep-weathered-hat-b47xszyr-pooler.c-6.us-east-2.aws.neon.tech`
- **Database:** `neondb`
- **Safety Policy:**
  - **No test records on the shared Neon DB** (production). All unit tests will use stubbed Prisma client, fake clock, and stubbed transporter.
  - **No real emails sent** during testing.
  - **Migration policy:** Generate SQL diff -> review -> wait for explicit user "OK" before running `prisma migrate deploy`.

---

## 1. Domain Architecture & Integration

### A. Lifecycle Overview
```
                     Advocate Profile Submission (submitForApproval)
                                         |
                       +-----------------+-----------------+
                       |                                   |
              testPassedAt set?                  testPassedAt is null
                       |                                   |
               test: { required: false }           Active SENT link exists?
                                                     |              |
                                                    Yes             No
                                                     |              |
                                             test: { link... }   SCHEDULED invite exists?
                                                                   |           |
                                                                  Yes          No
                                                                   |           |
                                                         test: { sched... }  Create INITIAL invite
                                                                               |
                                                                       Send email (8s timeout)
                                                                       Success -> SENT (72h expiry)
                                                                       Failure -> SCHEDULED (Cron retries)
```

### B. Test Execution Lifecycle
```
Advocate clicks email link (?token=...)
   |
   v
POST /api/advocate-test/login { token, barCouncilId, phone }
   |-- Verify token hash (SHA-256)
   |-- Normalize: trim Bar Council ID (case-insensitive), phone (last 10 digits)
   |-- Mismatch -> 401 INVALID_CREDENTIALS (rate limited: 5 fails / 15m / token+IP)
   |-- Check State:
         * ALREADY_PASSED -> 200 { status: "ALREADY_PASSED" }
         * Expired -> 410 LINK_EXPIRED { canRequestReschedule: true }
         * Used & Completed -> 200 { status: "COMPLETED", result, canRequestReschedule: !passed }
         * In Progress -> 200 { status: "IN_PROGRESS", testSession }
         * Ready -> 200 { status: "READY", testSession, rules }
   |
   v
POST /api/advocate-test/start (testSession JWT)
   |-- Checks/picks 20 random active, non-deleted questions (< 20 -> 503 TEST_UNAVAILABLE)
   |-- Shuffles question order & options per attempt
   |-- Creates snapshot: [{ questionId, question, options:[shuffled], correctIndex }]
   |-- Returns attemptId, deadlineAt (now + 20m), questions without correct answers!
   |
   v
PUT /api/advocate-test/answers (testSession JWT)
   |-- Autosave progress; rejects if past deadlineAt + 60s grace
   |
   v
POST /api/advocate-test/submit (testSession JWT)
   |-- Server-side scoring (unanswered = wrong)
   |-- >= 15 correct -> passed = true, sets advocate.testPassedAt = now, marks invite USED
   |-- < 15 correct -> passed = false, marks invite USED, canRequestReschedule = true
   |-- Idempotent: re-submitting returns same score
   |
   v
POST /api/advocate-test/request-reschedule (testSession OR { token, barCouncilId, phone })
   |-- Allowed only if: not passed AND (latest link expired OR latest attempt failed)
   |-- Creates RESCHEDULE invite with sendAt = now + 60m (old invite -> EXPIRED)
   |-- Cron sends email at sendAt; page informs advocate: "rescheduled within 2 hours"
```

---

## 2. Database Schema & Migration SQL

### Prisma Schema Additions (`prisma/schema.prisma`)

```prisma
model Advocate {
  // ... existing fields ...
  testPassedAt             DateTime?

  // Relations
  testInvites              AdvocateTestInvite[]
  testAttempts             AdvocateTestAttempt[]
}

model AdvocateTestQuestion {
  id            String    @id @default(uuid())
  question      String    @db.Text
  options       Json      // ["A text", "B text", "C text", "D text"] exactly 4
  correctOption Int       // 0..3
  isActive      Boolean   @default(true)
  deletedAt     DateTime? // soft delete (preserves historical attempt integrity)
  createdBy     String?
  updatedBy     String?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  @@index([isActive, deletedAt])
}

model AdvocateTestInvite {
  id         String               @id @default(uuid())
  advocateId String
  tokenHash  String               @unique
  reason     String               // INITIAL | RESCHEDULE
  status     String               // SCHEDULED | SENT | USED | EXPIRED | CANCELLED
  sendAt     DateTime             // when email should be dispatched
  sentAt     DateTime?
  expiresAt  DateTime?            // sentAt + 72h (computed when dispatched)
  createdAt  DateTime             @default(now())

  advocate   Advocate             @relation(fields: [advocateId], references: [id], onDelete: Cascade)
  attempt    AdvocateTestAttempt?

  @@index([advocateId, createdAt])
  @@index([status, sendAt])
}

model AdvocateTestAttempt {
  id             String             @id @default(uuid())
  advocateId     String
  inviteId       String             @unique // exactly one attempt per invite link
  questions      Json               // snapshot: [{ questionId, question, options: [...shuffled], correctIndex }]
  answers        Json?              // [{ index, selected }]
  startedAt      DateTime
  deadlineAt     DateTime           // startedAt + 20 min
  submittedAt    DateTime?
  autoSubmitted  Boolean            @default(false)
  totalQuestions Int
  correctCount   Int?
  wrongCount     Int?
  passed         Boolean?

  advocate       Advocate           @relation(fields: [advocateId], references: [id], onDelete: Cascade)
  invite         AdvocateTestInvite @relation(fields: [inviteId], references: [id], onDelete: Cascade)

  @@index([advocateId, startedAt])
}
```

### Generated Migration SQL (`prisma/migrations/20261116160000_add_advocate_qualification_test/migration.sql`)

```sql
-- AlterTable
ALTER TABLE "Advocate" ADD COLUMN "testPassedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AdvocateTestQuestion" (
    "id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "correctOption" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdvocateTestQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvocateTestInvite" (
    "id" TEXT NOT NULL,
    "advocateId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sendAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvocateTestInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvocateTestAttempt" (
    "id" TEXT NOT NULL,
    "advocateId" TEXT NOT NULL,
    "inviteId" TEXT NOT NULL,
    "questions" JSONB NOT NULL,
    "answers" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "autoSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "totalQuestions" INTEGER NOT NULL,
    "correctCount" INTEGER,
    "wrongCount" INTEGER,
    "passed" BOOLEAN,

    CONSTRAINT "AdvocateTestAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdvocateTestQuestion_isActive_deletedAt_idx" ON "AdvocateTestQuestion"("isActive", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdvocateTestInvite_tokenHash_key" ON "AdvocateTestInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "AdvocateTestInvite_advocateId_createdAt_idx" ON "AdvocateTestInvite"("advocateId", "createdAt");

-- CreateIndex
CREATE INDEX "AdvocateTestInvite_status_sendAt_idx" ON "AdvocateTestInvite"("status", "sendAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdvocateTestAttempt_inviteId_key" ON "AdvocateTestAttempt"("inviteId");

-- CreateIndex
CREATE INDEX "AdvocateTestAttempt_advocateId_startedAt_idx" ON "AdvocateTestAttempt"("advocateId", "startedAt");

-- AddForeignKey
ALTER TABLE "AdvocateTestInvite" ADD CONSTRAINT "AdvocateTestInvite_advocateId_fkey" FOREIGN KEY ("advocateId") REFERENCES "Advocate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvocateTestAttempt" ADD CONSTRAINT "AdvocateTestAttempt_advocateId_fkey" FOREIGN KEY ("advocateId") REFERENCES "Advocate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvocateTestAttempt" ADD CONSTRAINT "AdvocateTestAttempt_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "AdvocateTestInvite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

---

## 3. Account Deletion Impact Analysis
- **Current Behavior:** In `finalizeAdvocateDeletion` (`src/services/advocateDeletion.service.js`), permanent account deletion runs `await tx.advocate.delete({ where: { id: advocateId } })`.
- **Foreign Key Behavior (`onDelete: Cascade`):**
  When an advocate account is permanently deleted after the 30-day grace period, associated `AdvocateTestInvite` and `AdvocateTestAttempt` records are cleanly cascaded.
- **Snapshot Integrity:** While an advocate exists, even if questions in `AdvocateTestQuestion` are soft-deleted or edited by admin, the `questions` snapshot in `AdvocateTestAttempt` permanently preserves the exact questions and shuffled options as they were presented during the attempt.

---

## 4. Environment Variables (`.env.example`)
```env
# Advocate Qualification Test
FRONTEND_ADVOCATE_TEST_PATH="/advocate-test"
ADVOCATE_TEST_QUESTION_COUNT=20
ADVOCATE_TEST_PASS_MARK=15
ADVOCATE_TEST_DURATION_MINUTES=20
ADVOCATE_TEST_LINK_VALID_HOURS=72
ADVOCATE_TEST_RESCHEDULE_DELAY_MINUTES=60
```
- Missing/invalid config fallback: If any numerical value is not a valid positive integer, the service logs a single warning at startup/invocation and falls back to the default (20 questions, 15 pass mark, 20 minutes, 72 hours validity, 60 minutes reschedule delay).
- Test JWT reuses `process.env.JWT_SECRET` with dedicated payload `{ type: "advocate_test", inviteId, advocateId }`.

---

## 5. File Inventory

### Allowed New Files (3 domain files + 1 migration directory)
1. `src/routes/advocateTest.routes.js`: Public test API routes (`/api/advocate-test/login`, `/start`, `/answers`, `/submit`, `/request-reschedule`).
2. `src/controllers/advocateTest.controller.js`: Request controllers for the public test API.
3. `src/services/advocateTest.service.js`: Core domain service for token validation, question selection & randomization, scoring, and reschedule logic.
4. `prisma/migrations/20261116160000_add_advocate_qualification_test/migration.sql`: Migration file.

### Existing Files Modified (Strictly according to rules)
1. `prisma/schema.prisma`: Add `testPassedAt` to `Advocate`, add `AdvocateTestQuestion`, `AdvocateTestInvite`, `AdvocateTestAttempt`.
2. `prisma/seedRbac.js`: Add `tests:manage` permission to `DEFAULT_PERMISSIONS`.
3. `src/server.js`: Mount `/api/advocate-test` route.
4. `src/controllers/advocate.profile.controller.js`: In `submitForApproval`, integrate test link check/issuance and include `test` in response.
5. `src/controllers/paymentCron.controller.js`: In `reconcilePaymentsCron`, append test steps (send due invites, expire stale links, auto-submit timed-out attempts).
6. `src/routes/admin.routes.js`: Add question bank routes (`/test-questions`, CRUD) and advocate attempt history route (`/advocates/:advocateId/test-attempts`).
7. `src/controllers/admin.controller.js`: Implement question bank CRUD with `minimumRequired` count & soft-delete warnings; append `test` metadata in `formatAdvocateReviewData`, `listPendingAdvocates`, and `listRejectedAdvocates`.
8. `src/validators/admin.validator.js`: Zod schema for question creation and updates.
9. `src/services/email.service.js`: Add `sendAdvocateTestLinkEmail`.
10. `src/templates/advocateAccountEmail.template.js`: Add `advocateTestLinkTemplate`.
11. `.env.example`: Document new test env vars.
12. `README.md`: Add comprehensive Section 39: Advocate Qualification Test — Postman Guide.

---

## 6. API Endpoints & Request/Response Samples

### 1. `POST /api/advocate/profile/submit-for-approval` (Existing modified)
**Response (Test Required):**
```json
{
  "success": true,
  "message": "Your profile has been submitted for admin approval",
  "test": {
    "required": true,
    "emailSentTo": "ad***@gmail.com",
    "expiresAt": "2026-11-19T10:00:00.000Z",
    "message": "Your profile has been submitted for approval. Before that, you need to complete a test. The link has been sent to your email."
  }
}
```
**Response (Already Passed):**
```json
{
  "success": true,
  "message": "Your profile has been submitted for admin approval",
  "test": {
    "required": false,
    "passed": true
  }
}
```

### 2. `POST /api/advocate-test/login`
**Request:**
```json
{
  "token": "4f9d2c...b6",
  "barCouncilId": "DL/1234/2020",
  "phone": "9876543210"
}
```
**Response (Ready to Start):**
```json
{
  "success": true,
  "status": "READY",
  "testSession": "eyJhbGciOi...",
  "rules": {
    "questions": 20,
    "minutes": 20,
    "passMark": 15
  }
}
```
**Response (Invalid Credentials - 401):**
```json
{
  "success": false,
  "code": "INVALID_CREDENTIALS",
  "message": "The details don't match this test link."
}
```
**Response (Link Expired - 410):**
```json
{
  "success": false,
  "code": "LINK_EXPIRED",
  "message": "This test link has expired. Please request a reschedule.",
  "canRequestReschedule": true
}
```

### 3. `POST /api/advocate-test/start`
**Headers:** `Authorization: Bearer <testSession>`
**Response:**
```json
{
  "success": true,
  "attemptId": "c3e98b0a-...",
  "serverNow": "2026-11-16T15:30:00.000Z",
  "deadlineAt": "2026-11-16T15:50:00.000Z",
  "questions": [
    {
      "index": 0,
      "question": "Under which section of CrPC is anticipatory bail granted?",
      "options": [
        { "key": "A", "text": "Section 437" },
        { "key": "B", "text": "Section 438" },
        { "key": "C", "text": "Section 439" },
        { "key": "D", "text": "Section 482" }
      ]
    }
  ],
  "savedAnswers": []
}
```

### 4. `PUT /api/advocate-test/answers`
**Headers:** `Authorization: Bearer <testSession>`
**Request:**
```json
{
  "answers": [
    { "index": 0, "selected": "B" },
    { "index": 1, "selected": null }
  ]
}
```
**Response:**
```json
{
  "success": true,
  "savedAt": "2026-11-16T15:35:10.000Z"
}
```

### 5. `POST /api/advocate-test/submit`
**Headers:** `Authorization: Bearer <testSession>`
**Request:**
```json
{
  "answers": [
    { "index": 0, "selected": "B" }
  ]
}
```
**Response (Passed):**
```json
{
  "success": true,
  "correct": 16,
  "wrong": 4,
  "total": 20,
  "passed": true,
  "message": "You have passed the test."
}
```
**Response (Failed):**
```json
{
  "success": true,
  "correct": 13,
  "wrong": 7,
  "total": 20,
  "passed": false,
  "message": "Test completed.",
  "canRequestReschedule": true
}
```

### 6. `POST /api/advocate-test/request-reschedule`
**Headers:** `Authorization: Bearer <testSession>` OR Body: `{ "token": "...", "barCouncilId": "...", "phone": "..." }`
**Response:**
```json
{
  "success": true,
  "scheduled": true,
  "message": "Your test will be rescheduled within 2 hours."
}
```

### 7. Admin Question Bank & Advocate Test Info
**`GET /api/admin/test-questions`**
```json
{
  "success": true,
  "data": [
    {
      "id": "q1",
      "question": "Under which section...",
      "options": ["A", "B", "C", "D"],
      "correctOption": 1,
      "isActive": true
    }
  ],
  "counts": { "active": 25, "inactive": 2 },
  "minimumRequired": 20,
  "pagination": { "page": 1, "limit": 20, "total": 27, "totalPages": 2 }
}
```
**Admin Advocate Detail `test` block:**
```json
"test": {
  "status": "FAILED",
  "attemptsCount": 1,
  "latest": {
    "correct": 13,
    "wrong": 7,
    "total": 20,
    "passed": false,
    "submittedAt": "2026-11-16T15:45:00.000Z",
    "autoSubmitted": false
  },
  "best": {
    "correct": 13,
    "wrong": 7,
    "total": 20
  },
  "passedAt": null,
  "linkExpiresAt": "2026-11-19T10:00:00.000Z"
}
```

---

## 7. Risks & Mitigations

1. **Production Neon DB Contamination:**
   - *Risk:* Accidental test data inserted on live DB.
   - *Mitigation:* Unit tests will mock `@prisma/client` and will not establish live network connections to Neon.
2. **Timing / Deadline Bypass:**
   - *Risk:* Client submitting late answers via manipulated clocks.
   - *Mitigation:* Server enforces `deadlineAt + 60s` grace using server timestamps. Any submission or autosave after grace is locked to previously saved answers and flagged as `autoSubmitted = true`.
3. **Information Disclosure (Test Leak):**
   - *Risk:* Inspecting network payloads to read correct answers.
   - *Mitigation:* Correct answers are excluded from public responses. Options and questions are shuffled per attempt so option index "A" does not correspond to question bank index 0.
4. **Token Security:**
   - *Risk:* Leaking plain test tokens in logs or database compromises.
   - *Mitigation:* Tokens are generated via `crypto.randomBytes(32).toString('base64url')` and stored only as SHA-256 hashes (`tokenHash`). Plain token exists only in the outbound email.
5. **Brute Force on Login:**
   - *Risk:* Attackers guessing Bar Council IDs or phone numbers with token.
   - *Mitigation:* Strict rate limiter: 5 failed attempts per 15 minutes per token + IP, returning HTTP 429. Generic error message 401 `INVALID_CREDENTIALS` reveals no details about whether token, barCouncilId, or phone was mismatched.

---

## 8. Answers to OPEN QUESTIONS

1. **Should the admin have a "Resend test link" button for an advocate?**
   - **Answer:** **No (Default: no, not in this task).** The existing flow automatically handles initial send on profile submission, cron retries on transient delivery failure, and advocate-initiated reschedule requests for expired or failed tests.
2. **Should the advocate's own dashboard show the test status (passed / link sent)?**
   - **Answer:** **No (Default: no).** Status is communicated cleanly via the submission modal popup and the dedicated test link page. The advocate dashboard remains focused on profile review status.
