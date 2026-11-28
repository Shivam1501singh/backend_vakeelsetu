# Plan: Advocate Test Response Sheet Email Implementation

## Database Host Verification
**DB Host:** `ep-weathered-hat-b47xszyr-pooler.c-6.us-east-2.aws.neon.tech` (shared Neon DB / production - no test records will be written here; tests use stubbed prisma / in-memory mocks).

---

## Migration SQL

**Migration Directory:** `prisma/migrations/20261128113000_add_test_attempt_response_sheet_email_sent_at/migration.sql`

```sql
-- AlterTable
ALTER TABLE "AdvocateTestAttempt" ADD COLUMN "responseSheetEmailSentAt" TIMESTAMP(3);
```

> **Note on Migration Deployment:**
> Following repository policy (README Section 31), `npx prisma migrate dev` is NOT used. Migration SQL will be added to `prisma/migrations/` and `schema.prisma` will be updated. We will wait for your explicit "OK" before running `npx prisma migrate deploy`.

---

## System Design & Real Code Adaptations

### 1. Template: `advocateTestResponseSheetTemplate` in `src/templates/advocateAccountEmail.template.js`
- **Inputs:** `attempt`, `advocate`, `attemptNumber`, `config`
- **Header & Pill:**
  - Pass: Green pill `&#10003;&nbsp; Test passed` (`#e6f6ee` bg, `#13804f` text)
  - Fail: Red pill `&#10007;&nbsp; Test not passed` (`#fde8e8` bg, `#b42318` text)
- **Heading & Greeting:**
  - "Your test response sheet"
  - `Dear <strong>Adv. {name}</strong>,<br/>Thank you for taking the VakeelSetu advocate qualification test. Here is a summary of your attempt and your answers.`
- **Score Box:**
  - Dark container (`#020317`), 3 columns: Correct (count), Wrong (count), Total (count), labels in `#f59f0b`.
- **Details Table:**
  - Name: `Adv. {name}`
  - Bar Council ID: `{barCouncilId}` (monospace font)
  - Test date & time: `formatSubmittedDateIst(attempt.startedAt), formatSubmittedTimeIst(attempt.startedAt)`
  - Attempt: `Attempt {attemptNumber}`
  - Time taken: `Math.min(submittedAt - startedAt, durationSeconds)`, formatted as `${m} min ${s} sec`
  - Submitted: `attempt.autoSubmitted ? 'Automatically (time over)' : 'By you'`
  - Result: Chip `Passed` (green) or `Not passed` (red)
- **Question Breakdown (Snapshot-based):**
  - Uses `attempt.questions` stored snapshot (never current question bank).
  - Answers from `attempt.answers` map `{ index -> selectedKey }`.
  - Section 1: `Wrong / not answered ({wrongCount})`
    - Lists each wrong or unanswered question in attempt order:
      - Title: `Q{n}. {escapeHtml(q.question)}`
      - Badge: `&#10007; Wrong` (red) or `Not answered` (gray `#5b6472`, `#eef0f3` bg)
      - Your answer: Selected option text in red (`#b42318`), or `<em style="color:#8a94a3;">Not answered</em>`
      - Correct answer: Option text corresponding to `q.correctIndex` in green (`#13804f`)
  - Section 2: `Correct ({correctCount})`
    - Lists each correct question:
      - Title: `Q{n}. {escapeHtml(q.question)}`
      - Badge: `&#10003; Correct` (green)
      - Your answer: Selected option text in green (`#13804f`)
- **Closing Notice:**
  - Pass: "Our team will now review your profile. We will email you once it is approved."
  - Fail: "You can request a new test from the test page using **Request reschedule**."
- **Master Email Shell:**
  - Wrapped via `renderEmailLayout` with `tagline: 'Advocate Partner'`, including logo CID and dynamic `BRAND_*` footer and support block.
- **Plain-text alternative:** Full text version of details and scores.
- **Subject:**
  - Pass: `Your VakeelSetu test result – Passed ({correct}/{total})`
  - Fail: `Your VakeelSetu test result – Not passed ({correct}/{total})`

### 2. Email Service & BCC Support: `src/services/email.service.js`
- **`sendBrandedMail` extension:**
  - Add optional `bcc` parameter.
  - Forward `bcc` to nodemailer `mailOptions` when provided.
- **`sendTestResponseSheetEmail(attemptId)`:**
  1. Fetch attempt + advocate by `attemptId`. Verify attempt is finalized (`submittedAt != null`).
  2. Skip if no advocate email on record (info log).
  3. **Atomic Claim:**
     ```javascript
     const claim = await prisma.advocateTestAttempt.updateMany({
       where: { id: attemptId, responseSheetEmailSentAt: null },
       data: { responseSheetEmailSentAt: new Date() }
     });
     if (claim.count === 0) return { success: true, message: 'Already sent or claimed' };
     ```
  4. Compute `attemptNumber`:
     Count finalized attempts for this advocate with `startedAt <= attempt.startedAt`.
  5. Parse `ADVOCATE_TEST_SHEET_BCC`:
     - Split on comma, trim whitespace.
     - Validate each against email regex.
     - If invalid emails found, log **one** warning: `[Email Service] Invalid BCC email(s) ignored in ADVOCATE_TEST_SHEET_BCC: ...`
     - Valid emails form the `bcc` list.
  6. Call `sendBrandedMail` with 8-second timeout (`Promise.race`).
  7. **Logging:**
     Log type `ADVOCATE_TEST_RESPONSE_SHEET`, masked recipient `maskEmail(to)`, `attemptId`, BCC count `bccCount: validBcc.length`, success/fail. Never log answers or email body.
  8. **Failure handling:**
     On failure or timeout, reset `responseSheetEmailSentAt: null` in database so cron can retry. Catch all errors, log, and never throw.

### 3. Triggers: `src/services/advocateTest.service.js` & `src/controllers/paymentCron.controller.js`
- **Manual Submit (`submitAdvocateTest`):**
  - Finalizes score in transaction.
  - After commit, `await sendTestResponseSheetEmail(attempt.id)`.
  - Return result with `responseSheetEmailed: Boolean(emailRes.success)`. Email failure never throws or fails the submit API.
  - Idempotent return (double submit): returns existing score with `responseSheetEmailed: Boolean(attempt.responseSheetEmailSentAt)`.
- **Late Answer Autosave (`saveAdvocateTestAnswers`):**
  - When auto-finalized due to expired deadline, call `sendTestResponseSheetEmail(attempt.id)`.
- **Cron Auto-submit (`processTestCronJobs` step 3):**
  - When auto-finalizing abandoned attempts, call `sendTestResponseSheetEmail(att.id)`.
- **Cron Retry (`paymentCron.controller.js`):**
  - Finds finalized attempts from last 48 hours where `responseSheetEmailSentAt: null`:
    ```javascript
    const pendingTestSheetAttempts = await prisma.advocateTestAttempt.findMany({
      where: {
        submittedAt: { gte: fortyEightHoursAgo },
        responseSheetEmailSentAt: null
      },
      select: { id: true },
      take: 25,
      orderBy: { submittedAt: 'asc' }
    });
    ```
  - Loops and calls `sendTestResponseSheetEmail(att.id)`.

### 4. Email Previews: `scripts/preview-emails.js`
- Generate `test-sheet-pass.html` and `test-sheet-fail.html` with dummy 20-question snapshot.

### 5. Environment & Documentation: `.env.example` & `README.md`
- `.env.example`: Add `ADVOCATE_TEST_SHEET_BCC=` with description.
- `README.md` Section 39: Document "Test response sheet email" (triggers, contents, BCC env, 48h retry, `responseSheetEmailed` in submit response, manual testing).

---

## Files to Change
1. `prisma/schema.prisma`
2. `prisma/migrations/20261128113000_add_test_attempt_response_sheet_email_sent_at/migration.sql` (new migration file)
3. `src/templates/advocateAccountEmail.template.js`
4. `src/services/email.service.js`
5. `src/services/advocateTest.service.js`
6. `src/controllers/paymentCron.controller.js`
7. `scripts/preview-emails.js`
8. `.env.example`
9. `README.md`

---

## Risks & Mitigations
1. **Risk:** Slow SMTP or network timeout blocks advocate submit response.
   - **Mitigation:** 8-second timeout on email sending; submit response succeeds regardless of email outcome (`responseSheetEmailed: false`).
2. **Risk:** Duplicate emails on concurrent / double submits.
   - **Mitigation:** Atomic claim with `updateMany({ where: { id, responseSheetEmailSentAt: null } })`. Only one caller can succeed; the other sees count 0 and exits cleanly.
3. **Risk:** Transient email server outage drops email permanently.
   - **Mitigation:** Transporter failure resets `responseSheetEmailSentAt: null`; the 15-minute reconciliation cron retries attempts finalized within the last 48 hours.
4. **Risk:** Snapshot data discrepancy if questions are edited in admin bank later.
   - **Mitigation:** Template reads exclusively from `attempt.questions` snapshot and `attempt.answers` saved on the attempt record, never the `AdvocateTestQuestion` table.
5. **Risk:** Database pollution or accidental modification on production Neon DB.
   - **Mitigation:** All unit tests run against in-memory mocked Prisma delegates; no real email or DB mutations are run during testing.
