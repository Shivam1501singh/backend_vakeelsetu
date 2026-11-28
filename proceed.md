# Plan: "Help Request Received" Acknowledgement Email

## Database Host Verification
**DB Host:** `ep-weathered-hat-b47xszyr-pooler.c-6.us-east-2.aws.neon.tech` (shared Neon DB / production - no test records will be written; unit tests will use stubbed mocks).

---

## Step 0 Investigation Findings

### 1. Can a logged-in user/advocate see their own help requests and their status today?
**REPORT: NO.**
- Investigation of the codebase and database schema reveals:
  - The `HelpRequest` model in `prisma/schema.prisma` has fields `(id, referenceId, name, email, phoneNumber, concern, response, status, respondedById, respondedByType, respondedByName, createdAt, updatedAt, respondedAt)`. It has **no `userId` or `advocateId` foreign key**.
  - There are **no authenticated endpoints** (such as `/api/user/help-requests` or `/api/advocate/help-requests`) for users or advocates to list or view their past submitted help requests.
  - The only public lookup route is `POST /api/help/lookup` (requiring `{ referenceId, email }`).
  - The email copy ("You can simply log in to VakeelSetu and track your request.") assumes this capability exists or will exist in a future feature.
  - As instructed by Step 0: **We report this here and STOP. We will NOT build the missing "my help requests" API in this task.**

### 2. Help Request Create Endpoint Analysis
- **Route:** `POST /api/help` handled by `helpController.createRequest` in `src/controllers/help.controller.js`.
- **Who can submit:** Anyone (unauthenticated public access: guests, registered users, and advocates).
- **Submitted Fields:** Validated by `helpRequestSchema` in `src/validators/help.validator.js`:
  - `name`: String, 2–100 chars, required.
  - `email`: String, valid email, trimmed, lowercase, required.
  - `phoneNumber`: String, 7–20 chars, required.
  - `concern`: String, 10–2000 chars, required.
  - *(Note: There is no subject or category field in the form or schema today. As per rule 4, empty/absent rows are hidden).*
- **Reference ID Generation:** Generated via `generateHelpReferenceId()` in `src/utils/idFormat.js` (uses env `HELP_REFERENCE_FORMAT` or defaults to `VKLS-{RAND6}`).
- **Rate Limiting:** `helpLimiter` in `src/middleware/rate-limit.middleware.js` limits each IP to **5 requests per 15 minutes**.
- **`sendBrandedMail`:** In `src/services/email.service.js`, already supports `to`, `bcc`, `subject`, `html`, `text`, `attachments`, `emailType`.

---

## Trigger Point
- **File:** `src/controllers/help.controller.js`
- **Location:** Line 14 (right after `const helpRequest = await helpService.createHelpRequest(...)` succeeds).
- **Execution:**
  ```js
  try {
    await sendHelpRequestAcknowledgementEmail(helpRequest.id);
  } catch (emailErr) {
    console.error('[Help Controller] Non-fatal error sending acknowledgement email:', emailErr.message);
  }
  ```
  Awaited with an internal 8s timeout in `sendHelpRequestAcknowledgementEmail`. If email sending times out or fails, the error is safely caught and logged; the API response status `201` and payload `{ success: true, message: '...', referenceId: '...' }` remain completely unchanged.

---

## Email Design & Content Specification
Matches `vakeelsetu_help_request_email_demo.html`:
- **Template File:** `src/templates/helpRequestEmail.template.js` (the single allowed new file).
- **Subject:** `We've received your request – {referenceId}`
- **Preheader:** `Your reference ID is {referenceId}. Our team will get back to you soon.`
- **Pill:** `&#10003;&nbsp; Request received` (green pill `#e6f6ee`, `#13804f`)
- **Heading:** `We've received your help request` (22px, `#14161f`)
- **Salutation:** `Dear {name},` (escaped; if name empty → `Hello,`) + `Thank you for reaching out to VakeelSetu. Our support team will review your request and get back to you soon.`
- **Dark Box:**
  - Reference ID: 10.5px amber uppercase label, 22px Courier New monospace in `#ffffff`.
  - Submitted on: 10.5px amber uppercase label, IST date + time (e.g. `28 Nov 2026<br/>5:24 PM IST`).
- **Details Table:**
  - `Name`: `{name}`
  - `Email`: `{email}`
  - `Phone`: Masked via `+91 {first2}XXXXXX{last2}` (e.g. `+91 88XXXXXX68`)
  - `Status`: `<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:#e6f6ee;color:#13804f;font-size:12px;font-weight:800;">Received</span>`
  - Empty rows hidden; bottom border on all rows except the last.
- **"Your concern" Box:**
  - Label: `YOUR CONCERN` (uppercase 11px `#6b7a8d`)
  - Box: `#ffffff` background, `1px solid #ece6dc`, `border-left: 3px solid #f59f0b`, `white-space: pre-wrap; word-break: break-word;`
  - Content: User concern text escaped via `escapeHtml()`, truncated to 1000 characters with `…` appended if length exceeds 1000.
- **Closing Note:**
  - `Please keep your reference ID <strong style="color:#14161f;">{referenceId}</strong> for any follow-up. You can simply log in to VakeelSetu and track your request.`
- **Support Block & Footer:**
  - Standard branded support block and dark footer via `renderEmailLayout`.
- **Plain-Text Alternative:**
  - Clean text version mirroring all sections.
- **Security:**
  - All dynamic values passed through `escapeHtml`.
  - No user-generated buttons or links.

---

## Send & Retry Architecture

### 1. Exactly-Once Atomic Claim (`email.service.js`)
Function: `sendHelpRequestAcknowledgementEmail(helpRequestId)`
1. **Load Request:** Retrieve `HelpRequest` by UUID. If not found, exit `{ success: false, message: 'Help request not found' }`.
2. **Resolve Recipient:** Use `helpRequest.email`. If empty and submitter account email available, fallback; if no email, log info and skip `{ success: true, message: 'No email on record' }`.
3. **Abuse Limit Check:**
   - Count existing requests from same recipient email:
     ```js
     const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000);
     const recentCount = await prisma.helpRequest.count({
       where: {
         email: recipientEmail,
         acknowledgementEmailSentAt: { gte: sixtyMinutesAgo }
       }
     });
     ```
   - If `recentCount >= 3`: Log warning and skip email:
     ```js
     console.warn(`[Email Service] HELP_REQUEST_ACKNOWLEDGEMENT skipped for ${maskEmail(recipientEmail)} | referenceId: ${helpRequest.referenceId}: abuse limit reached (3 emails in last 60m)`);
     return { success: false, message: 'Abuse limit reached' };
     ```
4. **Atomic Claim:**
   ```js
   const claim = await prisma.helpRequest.updateMany({
     where: { id: helpRequestId, acknowledgementEmailSentAt: null },
     data: { acknowledgementEmailSentAt: new Date() }
   });
   if (claim.count === 0) {
     return { success: true, message: 'Already sent or claimed' };
   }
   ```
5. **BCC Resolution:**
   - Parse `process.env.HELP_REQUEST_BCC` (comma-separated; ignore invalid with one warning).
6. **Send with 8s Timeout:**
   - Call `sendBrandedMail(...)` with `withTimeout(..., 8000)`.
7. **Rollback on Failure/Timeout:**
   - If send fails or times out:
     ```js
     await prisma.helpRequest.update({
       where: { id: helpRequestId },
       data: { acknowledgementEmailSentAt: null }
     }).catch(() => {});
     ```
   - Never throw; log failure with type, masked recipient, `referenceId`, and BCC count. **Never log the concern text.**

### 2. Cron Retry (`src/controllers/paymentCron.controller.js`)
- In `reconcilePaymentsCron`:
  - Query unacknowledged help requests in the last 48 hours:
    ```js
    const pendingHelpRequests = await prisma.helpRequest.findMany({
      where: {
        createdAt: { gte: fortyEightHoursAgo },
        acknowledgementEmailSentAt: null
      },
      select: { id: true },
      take: 25,
      orderBy: { createdAt: 'asc' }
    });
    ```
  - Iterate and call `sendHelpRequestAcknowledgementEmail(hr.id)` (abuse limit check naturally applies).
  - Include `helpRequestEmailsRetried` count in response JSON.

---

## Migration SQL
Migration Name: `20261128174000_add_help_request_acknowledgement_email_sent_at`

```sql
-- AlterTable
ALTER TABLE "HelpRequest" ADD COLUMN "acknowledgementEmailSentAt" TIMESTAMP(3);
```

---

## Files to Change & Single Allowed New File

### Single Allowed New File:
- `src/templates/helpRequestEmail.template.js`: HTML & text template generator for user help request acknowledgement emails.

### Existing Files to Modify:
1. `prisma/schema.prisma`: Add `acknowledgementEmailSentAt DateTime?` to `HelpRequest`.
2. `prisma/migrations/20261128174000_add_help_request_acknowledgement_email_sent_at/migration.sql`: Migration script.
3. `src/services/email.service.js`: Add `parseHelpRequestBcc` and `sendHelpRequestAcknowledgementEmail`.
4. `src/controllers/help.controller.js`: Trigger acknowledgement email after `createHelpRequest` commit.
5. `src/controllers/paymentCron.controller.js`: Add 48h retry block in `reconcilePaymentsCron`.
6. `scripts/preview-emails.js`: Add `help-request-received.html` preview generation.
7. `.env.example`: Add `HELP_REQUEST_BCC=` documentation.
8. `README.md`: Document help request acknowledgement email in the Help Request section.
9. `tests/email.test.js`: Add unit tests covering template, recipient logic, BCC parsing, abuse limit, atomic claim, failure rollback, and retry.

---

## Risks & Mitigations
1. **Email Flooding / Denial-of-Service:**
   - *Risk:* Spammers submitting hundreds of requests to flood mailboxes or trigger SMTP rate limits.
   - *Mitigation:* Existing route rate limit (5 requests per 15 minutes per IP) PLUS recipient abuse limit (skipping email if recipient already received 3 acknowledgement emails in 60 minutes).
2. **Slow SMTP Server Delaying User Response:**
   - *Risk:* Network latency to SMTP provider causing `POST /api/help` to hang.
   - *Mitigation:* Strict 8s timeout via `Promise.race` (`withTimeout`). Response to submitter is never blocked beyond 8s, and failures never alter the `201 Created` HTTP response.
3. **Duplicate Emails:**
   - *Risk:* Concurrent requests or cron executions sending duplicate emails.
   - *Mitigation:* Prisma atomic row claim (`updateMany` where `acknowledgementEmailSentAt: null`). Only the winning process receives `count: 1` and proceeds to send.
4. **Data Privacy / Sensitive Info Leakage:**
   - *Risk:* User concern text containing sensitive legal or personal information appearing in log files.
   - *Mitigation:* Strict logging policy: logs record only event type, masked email (`maskEmail`), reference ID, and BCC count. Concern text is never logged. Dynamic inputs in emails are HTML-escaped and stripped of actionable links.
5. **Database Migration Disruption:**
   - *Risk:* Migration locking tables or failing in production.
   - *Mitigation:* Additive nullable column (`DateTime?`), instantaneous and non-blocking in PostgreSQL. Migration follows repository policy (no shadow DB, tested with `migrate diff`).
