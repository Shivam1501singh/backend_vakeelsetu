# Implementation Plan: Advocate Profile Under Review Email Notification

## Database & Environment Protection Notice
- **Database:** Shared Neon PostgreSQL (`ep-weathered-hat-b47xszyr-pooler.c-6.us-east-2.aws.neon.tech`) — **Strictly read-only baseline; NO test records, NO manual mutations, NO Prisma schema migrations.**
- **Email Delivery:** All tests will use in-memory stubbed nodemailer transporters (`setTransporter(...)`). **No real emails will be dispatched during tests.**

---

## 1. Analysis of Current Statuses & Codebase Paths

### 1.1 `submitForApproval` Controller (`src/controllers/advocate.profile.controller.js:249-332`)
- **First Submission (`approvalStatus: 'PENDING'`, `submittedForApprovalAt: null`):**
  - When an advocate registers, schema defaults `approvalStatus: 'PENDING'`, and `submittedForApprovalAt` is `null` (this represents `NOT_SUBMITTED` per `getVerificationStatus:980`).
  - Once the advocate completes all mandatory fields (`checkIsProfileComplete`), they call `POST /api/advocate/profile/submit-for-approval`.
  - The controller sets `approvalStatus: 'PENDING'`, `submittedForApprovalAt: new Date()`, and clears `rejectionReason: null`.
  - **Action:** Send the "Profile is under review" email.

- **Resubmission After Rejection (`approvalStatus: 'REJECTED'`):**
  - If admin rejected the profile earlier (`approvalStatus: 'REJECTED'`), the advocate can update their profile details and re-submit.
  - The controller updates `approvalStatus: 'PENDING'`, `submittedForApprovalAt: new Date()`, and clears `rejectionReason: null`.
  - **Action:** Send the "Profile is under review" email.

- **Duplicate Submission Guard (`approvalStatus: 'PENDING'` AND `submittedForApprovalAt !== null`):**
  - If the profile is already submitted and awaiting admin verification, attempting to re-submit will return `400 Bad Request` (`message: 'Your profile has already been submitted and is currently under review.'`).
  - **Action:** Email is **NOT** sent.

- **Approved Advocate Profile Changes Path (`approvalStatus: 'APPROVED'`):**
  - Handled at `src/controllers/advocate.profile.controller.js:280-306`.
  - For advocates already `APPROVED`, this endpoint handles updating `profileChangeStatus: 'SUBMITTED'` for draft changes (`pendingProfileChange`).
  - Returns `{ success: true, message: 'Changes sent for admin approval.' }`.
  - **Action:** Email is **NOT** sent (this email is strictly for advocate profile verification).

- **Available Fields for Email:**
  - `fullName`: string (e.g. `Adv. Priya Sharma`)
  - `barCouncilId`: string (e.g. `D/1234/2018`)
  - `email`: string (e.g. `advocate@example.com`)
  - `phone`: string (e.g. `9876543221` -> masked as `+91 98XXXXXX21`)
  - `submittedForApprovalAt`: Date/timestamp (e.g. `4 Nov 2026 / 4:40 PM IST`)

---

## 2. Exact Trigger Point (file:line)

**File:** `src/controllers/advocate.profile.controller.js`
**Location:** Right after line 323, immediately following `await prisma.advocate.update(...)`:
```javascript
// Duplicate check before update:
if (advocate.approvalStatus === 'PENDING' && advocate.submittedForApprovalAt) {
  return res.status(400).json({
    success: false,
    message: 'Your profile has already been submitted and is currently under review.'
  });
}

// ... Profile complete check ...

const updatedAdvocate = await prisma.advocate.update({
  where: { id: advocateId },
  data: {
    approvalStatus: 'PENDING',
    submittedForApprovalAt: new Date(),
    rejectionReason: null
  }
});

// TRIGGER POINT (Lines ~324-330):
// Trigger profile under review email (awaited with 8s timeout in service, never throws)
await sendProfileUnderReviewEmail(advocateId).catch((err) => {
  console.error(`[Advocate Profile] Error sending under review email for ${advocateId}:`, err.message);
});

return res.status(200).json({
  success: true,
  message: 'Your profile has been submitted for admin approval'
});
```

---

## 3. Template & Visual Design (`src/templates/advocateAccountEmail.template.js`)

Matching the exact reference design provided in the demo HTML (`vakeelsetu_profile_review_email_demo.html`):

1. **New File Created:** `src/templates/advocateAccountEmail.template.js`
   - Dedicated home for advocate account/profile lifecycle emails (under review, approved, rejected).
2. **Subject:** `Your VakeelSetu profile is under review`
3. **Preheader:** `We've received your profile. Our team is verifying your details.`
4. **Header Tagline:** `Advocate Partner` (via `renderEmailLayout({ tagline: 'Advocate Partner', ... })`)
5. **Body Components:**
   - **Amber Status Pill:** `⏳ Under review` (amber background `#fff1de`, text `#b8650f`, border-radius 20px).
   - **Heading:** `Your profile is under review` (`font-size: 22px`, `#14161f`, `font-weight: 800`).
   - **Greeting:** `Dear Adv. Priya Sharma,` followed by `Thank you for completing your profile on VakeelSetu. We have received it and our verification team is now reviewing your details and documents.`
     - *If `fullName` is missing/empty:* Greeting defaults to `Thank you for completing your profile on VakeelSetu...` without `Dear ,`.
   - **Dark Info Box:** `#020317` rounded container:
     - Left: `STATUS` in amber `#f59f0b`, value `Submitted for verification` in white.
     - Right: `SUBMITTED ON` in amber `#f59f0b`, value `{date}<br/>{time}` in white (e.g. `4 Nov 2026<br/>4:40 PM IST`).
   - **Detail Table:** Generated via `renderDetailRows` (`#fbfaf8` background, `#ece6dc` borders):
     - `Name`: `advocate.fullName`
     - `Bar Council ID`: `advocate.barCouncilId` (`isMono: true` -> `'Courier New', monospace`)
     - `Registered email`: `advocate.email`
     - `Registered phone`: masked: `+91 98XXXXXX21` (first 2 and last 2 digits visible)
     - `Profile status`: `<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:#fff1de;color:#b8650f;font-size:12px;font-weight:800;">Under review</span>`
     - *Empty row rule:* If any field is empty/null, that row is omitted automatically.
   - **Closing Paragraph:** `We will email you as soon as your profile is approved. Until then, your profile will not be visible to clients. If we need any more information, our team will contact you.`
   - **NO Button:** No CTA button is rendered.
   - **NO Note Box:** No footnote or callout box is rendered.
   - **Support Block + Footer:** Standard branded layout (`Need help?`, office address, website/terms links) from `renderEmailLayout`.
   - **Escaping:** All dynamic values pass through `escapeHtml`.
   - **Plain Text Alternative:** Clean multi-line text version included in the return object.

---

## 4. Send Function (`src/services/email.service.js`)

`export const sendProfileUnderReviewEmail = async (advocateId)`:
- Loads the advocate from DB (`prisma.advocate.findUnique`).
- Checks `advocate.email`. If missing or empty, logs `info` and returns `{ success: true, message: 'No email on record' }` without throwing.
- Masks phone number (`+91 98XXXXXX21`) and formats submitted timestamp in IST (`Asia/Kolkata`).
- Calls `sendBrandedMail({ to, subject, html, text, attachments, emailType: 'ADVOCATE_PROFILE_UNDER_REVIEW' })`.
- Wrapped in an **8-second timeout** (`withTimeout`).
- **Never throws:** Catches any error or timeout, logs structured warning with masked recipient (`maskEmail`), advocateId, and error message. Returns `{ success: false, message: err.message }`. Never logs email body.

---

## 5. Preview & Documentation

1. **`scripts/preview-emails.js`**:
   - Add dummy advocate profile submission dataset:
     - Name: `Adv. Priya Sharma`
     - Bar Council ID: `D/1234/2018`
     - Email: `advocate@example.com`
     - Phone: `+919876543221` (renders as `+91 98XXXXXX21`)
     - Submitted on: `4 Nov 2026, 4:40 PM IST`
   - Generates `tmp/email-previews/profile-under-review.html`.
2. **`README.md`**:
   - Update Section 36 ("Email Templates & Notifications"):
     - Add "Profile under review (advocate)" to the catalog table.
     - Document trigger conditions (first submit and resubmit after rejection; not for profile changes).
     - Document recipient, masked phone rule, no button, no retry cron.
     - Document manual testing instructions on local environment.

---

## 6. Files to Change

| File | Change |
| :--- | :--- |
| `src/templates/advocateAccountEmail.template.js` | **NEW FILE:** Template generator `profileUnderReviewTemplate`, phone masking helper, date/time formatting helper. |
| `src/services/email.service.js` | Add `sendProfileUnderReviewEmail(advocateId)` with 8s timeout and error suppression. |
| `src/controllers/advocate.profile.controller.js` | Add duplicate submission guard + trigger `sendProfileUnderReviewEmail` post-commit in `submitForApproval`. |
| `scripts/preview-emails.js` | Add dummy data and generate `profile-under-review.html`. |
| `README.md` | Document the new email template, trigger points, and testing guide. |
| `tests/advocateProfileEmail.test.js` | **NEW TEST FILE:** Unit tests for template rendering, masking, trigger conditions, timeout/error resilience. |

---

## 7. Risks & Mitigation

1. **Slow SMTP Server Delaying Advocate Submission API:**
   - *Mitigation:* The call is awaited with an 8-second timeout (`withTimeout`) and wrapped in try/catch. Even on network failure or SMTP hang, the API finishes and returns `200 OK`.
2. **Missing Advocate Email or Malformed Data:**
   - *Mitigation:* Verified before sending; missing email logs `info` and gracefully completes. All dynamic values sanitized via `escapeHtml`.
3. **Sensitive Data Exposure in Logs:**
   - *Mitigation:* Email logging uses `maskEmail(to)` (e.g. `ad***@example.com`). Advocate phone in email is masked (`+91 98XXXXXX21`). Email body is never logged.
4. **Accidental Duplicate Triggers:**
   - *Mitigation:* Guard check prevents sending when already `PENDING` with existing `submittedForApprovalAt`. Profile change requests from approved advocates (`approvalStatus: 'APPROVED'`) branch away and do not invoke this email.
5. **Database Safety:**
   - *Mitigation:* Zero Prisma schema migrations, zero new DB columns, zero live test records on Neon DB.

---

## 8. Answers to OPEN QUESTIONS

1. **Question 1: On resubmission after rejection, keep the same subject, or use "Your updated profile is under review"?**
   - **Decision:** Keep the default: **Same subject (`Your VakeelSetu profile is under review`) and same template**. This maintains brand consistency, avoids unnecessary template proliferation, and clearly communicates that the profile is in the verification pipeline.

2. **Question 2: Should the main admin also get a "New advocate profile submitted" email?**
   - **Decision:** Keep the default: **No**. The admin portal already provides a dedicated verification dashboard (`/api/admin/advocates/pending`) and notification system. No admin email is configured or requested.
