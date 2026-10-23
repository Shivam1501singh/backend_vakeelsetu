# Implementation Plan: Configurable Help Reference IDs & Booking IDs

## 1. Current Behaviour Analysis

### 1.1 Help Request Reference IDs (`src/services/help.service.js`)
- **Current Generator:** `generateReferenceId()` is hard-coded at lines 7–14:
  - Generates `VKLS-` prefix followed by 6 characters chosen with `crypto.randomInt` from `ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`.
  - Example: `VKLS-8F4K29`.
- **Collision Handling:** Lines 26–35 in `createHelpRequest`:
  - Loops up to 10 attempts checking `prisma.helpRequest.findUnique({ where: { referenceId } })`.
  - If 10 collisions occur, it falls through without throwing a controlled 500 error.
- **Limitation:** Hard-coded prefix and format; cannot be changed without modifying code and redeploying.

### 1.2 Booking IDs (`src/utils/bookingId.util.js`)
- **Current Status:** The custom booking ID feature is merged and migrated (`prisma/migrations/20261023153000_add_consultancy_booking_id` applied).
- **Current Generator:** `generateBookingId(date)` is hard-coded to `VSB-<YYYY><MonthLetter><6 random chars>`.
- **Collision Handling:**
  - `createConsultancyWithUniqueBookingId` performs pre-checks with `prisma.consultancyRequest.findUnique`.
  - Outer retry loops wrap the transaction in `src/services/payment.service.js` and `src/services/consultancy.service.js`.
  - `scripts/backfill-booking-ids.js` uses `generateBookingId(record.createdAt)` with in-memory set collision checks.

### 1.3 Database Schema Check
- `HelpRequest.referenceId`: Type `String` (`@unique`). In PostgreSQL via Prisma, maps to `TEXT` (no length restriction < 40).
- `ConsultancyRequest.bookingId`: Type `String?` (`@unique`). In PostgreSQL via Prisma, maps to `TEXT` (no length restriction < 40).

---

## 2. Target Design & Environment Variables

| Variable | Default Value | Description |
|---|---|---|
| `HELP_REFERENCE_FORMAT` | `"VKLS-{RAND6}"` | Template for help request public reference IDs |
| `BOOKING_ID_FORMAT` | `"VSB-{YYYY}{MONTH_LETTER}{RAND6}"` | Template for user consultancy booking IDs |
| `ID_TIMEZONE` | `"Asia/Kolkata"` | Timezone for `{YYYY}`, `{YY}`, `{MM}`, `{DD}`, `{MONTH_LETTER}` |
| `ID_RANDOM_CHARSET` | `"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"` | 32-character set with ambiguous characters (`0/O/1/I`) omitted |

### 2.1 Supported Template Tokens
- `{YYYY}`: 4-digit year in `ID_TIMEZONE` (e.g. `2026`)
- `{YY}`: 2-digit year in `ID_TIMEZONE` (e.g. `26`)
- `{MM}`: 2-digit month (`01`–`12`) in `ID_TIMEZONE` (e.g. `10`)
- `{DD}`: 2-digit day (`01`–`31`) in `ID_TIMEZONE` (e.g. `23`)
- `{MONTH_LETTER}`: Single-letter month code in `ID_TIMEZONE` (`A`=Jan, `B`=Feb … `L`=Dec)
- `{RANDn}`: `n` random characters from `ID_RANDOM_CHARSET`, where $4 \le n \le 12$, generated using `crypto.randomInt`.

### 2.2 Template Validation Rules (`validateTemplate`)
1. **Allowed Tokens:** Only `{YYYY}`, `{YY}`, `{MM}`, `{DD}`, `{MONTH_LETTER}`, and `{RANDn}` ($4 \le n \le 12$).
2. **Mandatory Randomness:** Must contain at least one `{RANDn}` token where $n \ge 4$.
3. **Allowed Literal Characters:** Literal text between tokens must only contain uppercase letters (`A`–`Z`), digits (`0`–`9`), and hyphens (`-`).
4. **Maximum Length:** Maximum possible expanded string length must be $\le 40$ characters.
5. **Fail-Safe Startup:** If an environment template fails validation, log a clear warning explaining the violation and fall back to the safe default template. The server will **never** crash on invalid configuration.

---

## 3. Files to Create and Modify

| File | Status | Description |
| :--- | :---: | :--- |
| `src/utils/idFormat.js` | **NEW** | Core template parser, validator, `formatId`, `validateTemplate`, `generateHelpReferenceId`, `generateBookingId` |
| `src/services/help.service.js` | **EDIT** | Replace `generateReferenceId` with `generateHelpReferenceId()`; throw 500 error if 10 collision retries are exhausted |
| `src/utils/bookingId.util.js` | **EDIT** | Delegate `generateBookingId(date)` to `idFormat.js` while preserving existing transaction pre-check & retry helpers |
| `scripts/backfill-booking-ids.js` | **EDIT** | Ensure backfill uses `generateBookingId(row.createdAt)` from `src/utils/idFormat.js` |
| `src/server.js` | **EDIT** | Call startup validation check to warn if env templates are invalid |
| `.env.example` | **NEW** | Document the 4 environment variables with defaults |
| `README.md` | **EDIT** | Update Sections 10, 29, 30 with token tables, examples, fallback rules, and Vercel redeployment instructions |

---

## 4. Examples of Formats

1. **Default Booking Format:**
   `BOOKING_ID_FORMAT="VSB-{YYYY}{MONTH_LETTER}{RAND6}"`
   Output for October 2026: `VSB-2026J5TW7HN` (14 chars)

2. **Dated Year-Month Format:**
   `BOOKING_ID_FORMAT="VKLS-BKC-{YYYY}-{RAND6}"`
   Output for 2026: `VKLS-BKC-2026-8F4K29` (19 chars)

3. **Compact Help Format:**
   `HELP_REFERENCE_FORMAT="HLP-{YY}{MM}-{RAND5}"`
   Output for October 2026: `HLP-2610-P7X9K` (14 chars)

4. **Timezone Boundary Example:**
   `2026-01-31T19:00:00Z` in UTC is `2026-02-01 00:30:00` in `Asia/Kolkata`.
   Format `{YYYY}{MONTH_LETTER}` correctly produces `2026B` (`B` = February).

---

## 5. Potential Risks & Mitigations

1. **Risk:** Malformed or empty template in production environment variables crashes the application.
   - **Mitigation:** Safe parser with `validateTemplate()`. If invalid or empty, it logs a warning and automatically falls back to `DEFAULT_BOOKING_FORMAT` or `DEFAULT_HELP_FORMAT`.
2. **Risk:** Collision rate increases if a short random token is used.
   - **Mitigation:** Strict validation requires $n \ge 4$ (at least $32^4 = 1,048,576$ combinations per time window). Collision loops with pre-checks protect both help requests and bookings. If 10 collisions occur in help requests, an explicit 500 error with descriptive log is thrown.
3. **Risk:** Breaking existing historical IDs when the template is changed.
   - **Mitigation:** All database lookups (`findUnique({ where: { referenceId } })` and `where: { bookingId }`) use exact string matching. Changing templates in `.env` only affects newly generated IDs; historical records remain 100% accessible.
4. **Risk:** Database column truncation if template generates a long string.
   - **Mitigation:** Max length validation rule strictly limits total output length to $\le 40$ characters. Both `HelpRequest.referenceId` and `ConsultancyRequest.bookingId` are PostgreSQL `TEXT` columns with no restrictive length limit.

---

## 6. Verification Plan

1. Syntax verification using `node --check` on all modified files.
2. Standalone test script verifying:
   - Valid templates expand properly with correct tokens.
   - Invalid templates trigger fallback warnings (`{RAND2}`, missing random token, invalid characters).
   - Timezone accuracy test (`2026-01-31T19:00:00Z` yields month letter `B` for Feb 1 in IST).
3. API test on `POST /api/help` verifying generation of default reference ID and lookup of existing reference ID.
4. `git diff --stat` inspection to verify only intended files are touched.
