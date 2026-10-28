# Plan: Switch Aadhaar OTP Provider from Sandbox to IDSPay (Auto-Verification)

This document provides the full implementation plan to transition the advocate Aadhaar OTP generation and verification flow from the discontinued Sandbox OKYC endpoint (`/kyc/aadhaar/okyc/otp`) to the IDSPay "auto-verification" API (`/srv2/digital-kyc/aadhar/auto-verification`), while preserving 100% of the frontend contract.

---

## 1. Current Behaviour Analysis

### 1.1 Fields Saved After Successful Verification

| Field | Saved in OTP Flow (`verifyAadhaarOtpService`) | Saved in DigiLocker Flow (`verifyAadhaarStatusService`) | Final Advocate Profile Creation (`completeProfile`) |
|---|---|---|---|
| `aadhaarVerified` | `true` | `true` | Copied from `session.aadhaarVerified` |
| `aadhaarVerifiedAt` | `new Date()` | `new Date()` | Copied from `session.aadhaarVerifiedAt` |
| `aadhaarVerificationMethod` | `'OTP'` | `'DIGILOCKER'` | Copied from `session.aadhaarVerificationMethod` |
| `aadhaarVerificationId` | `reference_id` (from generate OTP) | `clientId` (from initiate) | Copied from `session.aadhaarVerificationId` |
| `aadhaarVerificationAttempts` | Reset to `0` | Reset to `0` | Copied from `session.aadhaarVerificationAttempts` |
| `aadhaarBlockedUntil` | Reset to `null` | Reset to `null` | Copied from `session.aadhaarBlockedUntil` |
| `aadhaarNumber` | Set during OTP generate (`cleanAadhaar`) | Set during initiate (`cleanAadhaar`) | Copied from `session.aadhaarNumber` |
| Name / DOB / Gender / Address / Photo | **Not stored** in session or Advocate table | **Not stored** in session or Advocate table | Basic details entered by advocate in Step 2 are used |

### 1.2 Full Aadhaar Number Storage
- **Current Status:** The code currently stores the **full 12-digit clean Aadhaar number** (e.g., `266809098341`) in:
  1. `RegistrationSession.aadhaarNumber`
  2. `Advocate.aadhaarNumber`
- It is also checked in `checkDuplicateAadhaarNumber` via `prisma.advocate.findFirst({ where: { aadhaarNumber: cleanAadhaar } })`.
- **Compliance Risk:** UIDAI regulations prohibit storing plain 12-digit Aadhaar numbers in non-vault databases. See Open Question 1.

### 1.3 Where `reference_id` is Stored
- During `POST /aadhaar/otp/generate`, the provider's `reference_id` (or `request_id`) is stored in `RegistrationSession.aadhaarVerificationId`.
- During `POST /aadhaar/otp/verify`, the incoming `reference_id` is strictly compared with `session.aadhaarVerificationId`:
  ```javascript
  if (session.aadhaarVerificationId !== reference_id) {
    const err = new Error('Invalid reference ID. Please initiate OTP generation first.');
    err.statusCode = 400;
    throw err;
  }
  ```

---

## 2. Existing IDSPay Environment Variables

### 2.1 Existing Variable Names in `.env` / `.env.example`
- `IDSPAY_BASE_URL`: Can be reused directly (`https://javabackend.idspay.in/api/v1/prod`).
- `IDSPAY_CLIENT_ID`: Existing DigiLocker config. In `idspay.service.js`, this was passed as both `client_id` and `api_id`.
- `IDSPAY_CLIENT_SECRET`: Used in DigiLocker flow; not needed for auto-verification request body.
- `IDSPAY_API_KEY`: Can be reused directly for the auto-verification payload if using the same credentials.
- `IDSPAY_AADHAAR_INITIATE_PATH`: Specific to DigiLocker (`/srv2/validation/digilocker-digital-kyc`). **Do NOT touch or rename**.
- `IDSPAY_AADHAAR_STATUS_PATH`: Specific to DigiLocker (`/srv2/validation/digilocker-digital-kyc`). **Do NOT touch or rename**.

### 2.2 Variables Needed for IDSPay Auto-Verification
- `IDSPAY_BASE_URL`: (Reuse existing)
- `IDSPAY_API_ID`: Will support explicit `IDSPAY_API_ID` with fallback to `IDSPAY_CLIENT_ID`.
- `IDSPAY_API_KEY`: (Reuse existing or override)
- `IDSPAY_TOKEN_ID`: **New** (required by auto-verification endpoint).
- `IDSPAY_AADHAAR_OTP_PATH`: **New** (default `/srv2/digital-kyc/aadhar/auto-verification`).
- `AADHAAR_OTP_PROVIDER`: **New** (options: `idspay` | `sandbox` | `mock`, default `idspay`).
- `AADHAAR_OTP_TIMEOUT_MS`: **New** (default `20000`).

### 2.3 Variables to Set in Vercel (Production & Preview)
1. `IDSPAY_BASE_URL`
2. `IDSPAY_API_ID` (or `IDSPAY_CLIENT_ID`)
3. `IDSPAY_API_KEY`
4. `IDSPAY_TOKEN_ID`
5. `IDSPAY_AADHAAR_OTP_PATH`
6. `AADHAAR_OTP_PROVIDER=idspay`
7. `AADHAAR_OTP_TIMEOUT_MS=20000`

---

## 3. Architecture & Modular Adapter Design

```
+-------------------------------------------------------------------------------------------------+
|                                 Advocate Auth Controller                                        |
|             (POST /aadhaar/otp/generate  &  POST /aadhaar/otp/verify)                           |
+-------------------------------------------------------------------------------------------------+
                                                |
                                                v
+-------------------------------------------------------------------------------------------------+
|                                  auth.service.js                                                |
|   - 24h block & attempt check (max 3 attempts)                                                  |
|   - 60s resend cooldown per registrationId                                                      |
|   - Reference ID session binding                                                                |
|   - Aadhaar last 4 cross-check on verify                                                        |
+-------------------------------------------------------------------------------------------------+
                                                |
                                                v
+-------------------------------------------------------------------------------------------------+
|                              src/services/aadhaarOtp/index.js                                   |
|   - Provider switch (AADHAAR_OTP_PROVIDER = 'idspay' | 'sandbox' | 'mock')                      |
|   - Production safety guard (blocks 'mock' in NODE_ENV === 'production' with 503)               |
+-------------------------------------------------------------------------------------------------+
                 |                                      |                                  |
                 v                                      v                                  v
+---------------------------------+  +---------------------------------+  +-------------------------------+
|      idspay.provider.js         |  |      sandbox.provider.js        |  |       mock.provider.js        |
|  - Real IDSPay Auto-Verify      |  |  - Legacy Sandbox OKYC          |  |  - Mock test numbers          |
|  - HTTP timeout 20s             |  |  - Marked @deprecated           |  |    (123456789012, etc.)       |
|  - No mock bypass in live path  |  |  - Kept for rollback            |  |  - Test OTP 123456            |
+---------------------------------+  +---------------------------------+  +-------------------------------+
```

### 3.1 Normalized Provider Interface
Regardless of the active provider, `src/services/aadhaarOtp/index.js` returns uniform shapes:

**Generate OTP:**
```typescript
type GenerateOtpResult = 
  | { ok: true; referenceId: string }
  | { ok: false; reason: 'INVALID_AADHAAR' | 'NO_MOBILE_LINKED' | 'RATE_LIMITED' | 'PROVIDER_ERROR'; providerMessage?: string }
```

**Verify OTP:**
```typescript
type VerifyOtpResult = 
  | { 
      ok: true; 
      kyc: { 
        fullName: string; 
        dob: string; 
        gender: string; 
        aadhaarLast4: string; 
        address: Record<string, any>; 
        zip: string; 
      } 
    }
  | { ok: false; reason: 'INVALID_OTP' | 'OTP_EXPIRED' | 'PROVIDER_ERROR'; providerMessage?: string }
```

### 3.2 IDSPay Provider Details (`idspay.provider.js`)
- **Missing env check:** If any required env var (`IDSPAY_BASE_URL`, `IDSPAY_API_ID` / `IDSPAY_CLIENT_ID`, `IDSPAY_API_KEY`, `IDSPAY_TOKEN_ID`) is missing at request time, log error naming the missing var (name only) and return `{ ok: false, reason: 'PROVIDER_ERROR', providerMessage: 'Configuration missing' }` which maps to HTTP 503.
- **Generate OTP:**
  - POST to `{IDSPAY_BASE_URL}{IDSPAY_AADHAAR_OTP_PATH}`
  - Payload: `{ api_id, api_key, token_id, methodName: 'getotp', aadhaar_no: aadhaarNumber }`
  - Success condition: HTTP 200 AND `status.type === "success"` AND `data.data.otp_sent === true` AND `data.request_id` is present.
  - Returns: `{ ok: true, referenceId: String(data.request_id) }`
  - If `valid_aadhaar === false` -> `reason: 'INVALID_AADHAAR'`
  - If `if_number === false` -> `reason: 'NO_MOBILE_LINKED'`
  - Otherwise -> `reason: 'PROVIDER_ERROR'` (with `// TODO: refine with real failure samples`).
- **Verify OTP:**
  - POST to `{IDSPAY_BASE_URL}{IDSPAY_AADHAAR_OTP_PATH}`
  - Payload: `{ api_id, api_key, token_id, methodName: 'validateotp', request_id: String(referenceId), otp: String(otp) }`
  - Success condition: HTTP 200 AND `status.type === "success"` AND `data.full_name` is present.
  - Returns: `{ ok: true, kyc: { fullName: data.full_name, dob: data.dob, gender: data.gender, aadhaarLast4: data.aadhaar_number?.slice(-4) || '', address: data.address || {}, zip: data.zip || '' } }`
  - If not successful: Network/5xx/unparseable -> `reason: 'PROVIDER_ERROR'`. Other -> `reason: 'INVALID_OTP'` (with `// TODO: refine with real failure samples`).
- **Timeout:** 20,000ms via Axios timeout. No automatic retries.

### 3.3 Mock Safety & Complete Removal from Live Path
- **Remove mock bypass from live code:** In `idspay.provider.js`, there is NO check for `123456789012`. All requests to `idspay.provider.js` proceed strictly through HTTP.
- **Mock isolated in `mock.provider.js`:** Mock numbers live exclusively in `mock.provider.js`, triggered only when `AADHAAR_OTP_PROVIDER=mock`.
- **Production Guard:** If `NODE_ENV === 'production'` and `AADHAAR_OTP_PROVIDER === 'mock'`, the adapter logs an alert at startup and immediately rejects any OTP call with HTTP 503 "Aadhaar mock verification is disabled in production."

### 3.4 Resend Cooldown (60s)
- Implemented in `auth.service.js` using an in-memory TTL map: `aadhaarOtpCooldowns = new Map<string, number>()`.
- If `generateAadhaarOtpService` is invoked for the same `registrationId` within 60 seconds of the previous generation:
  - Returns `HTTP 429` with:
    ```json
    {
      "success": false,
      "message": "Please wait before requesting another OTP.",
      "retryAfterSeconds": 48
    }
    ```
- This prevents spamming IDSPay and saves per-SMS costs.

---

## 4. Error Mapping to API (Frontend Contract)

| Normalized reason | HTTP | Response Message | Counts as failed attempt? | Session Blocked? |
|---|---|---|---|---|
| `INVALID_AADHAAR` | 400 | Invalid Aadhaar Number or Aadhaar not registered. | **No** | No |
| `NO_MOBILE_LINKED` | 400 | No mobile number is linked with this Aadhaar. Please use DigiLocker verification. | **No** | No |
| `RATE_LIMITED` / Cooldown | 429 | Please wait before requesting another OTP. (+ `retryAfterSeconds`) | **No** | No |
| `INVALID_OTP` | 400 | Invalid OTP. (+ `remainingAttempts`, `blocked`, `blockedUntil`) | **Yes** (increments `attempts`) | Yes if attempts >= 3 (24h block) |
| `OTP_EXPIRED` | 400 | OTP expired. Please request a new OTP. | **No** | No |
| `PROVIDER_ERROR` | 502 | Aadhaar verification service is temporarily unavailable. Please try again. | **No** | No |
| Missing Env / Provider Config | 503 | Aadhaar verification is temporarily unavailable. | **No** | No |

---

## 5. Files to Change

1. **`src/services/aadhaarOtp/index.js`** (NEW): Provider selection, normalized contract, production safety guard.
2. **`src/services/aadhaarOtp/idspay.provider.js`** (NEW): IDSPay auto-verification HTTP requests with defensive parsing.
3. **`src/services/aadhaarOtp/sandbox.provider.js`** (NEW): Legacy Sandbox implementation moved and marked `@deprecated`.
4. **`src/services/aadhaarOtp/mock.provider.js`** (NEW): Mock test numbers and OTP logic isolated here.
5. **`src/services/auth.service.js`** (MODIFIED):
   - Replace Sandbox calls in `generateAadhaarOtpService` and `verifyAadhaarOtpService` with calls to `aadhaarOtp` adapter.
   - Add 60s cooldown check.
   - Cross-check Aadhaar last 4 on verify.
   - Map normalized error reasons to existing HTTP response schema.
6. **`src/services/sandboxAadhaar.service.js`** (MODIFIED): Marked deprecated, re-exports from `src/services/aadhaarOtp` to avoid breaking any loose imports.
7. **`.env.example`** (MODIFIED): Add placeholders for `IDSPAY_API_ID`, `IDSPAY_TOKEN_ID`, `IDSPAY_AADHAAR_OTP_PATH`, `AADHAAR_OTP_PROVIDER`, `AADHAAR_OTP_TIMEOUT_MS`.
8. **`README.md`** (MODIFIED): Add **`## 33. Aadhaar OTP Verification (IDSPay) — Postman Guide`**.
9. **Tests:**
   - Unit tests for `idspay.provider.js` with stubbed Axios (no live calls).
   - Service layer unit tests for `auth.service.js` (cooldown, error mapping, attempt counter, last 4 cross-check).

---

## 6. Request & Response Samples

### 1. Generate Aadhaar OTP
**`POST /api/auth/advocate/aadhaar/otp/generate`**
```json
{
  "registrationId": "0536adf1-b64f-4f3d-bfb9-676d8f964486",
  "aadhaar_number": "123456789012"
}
```
**Success Response (`200 OK`):**
```json
{
  "success": true,
  "message": "Aadhaar verification OTP sent successfully.",
  "reference_id": "16746854"
}
```
**Resend Within 60s (`429 Too Many Requests`):**
```json
{
  "success": false,
  "message": "Please wait before requesting another OTP.",
  "retryAfterSeconds": 52
}
```

### 2. Verify Aadhaar OTP
**`POST /api/auth/advocate/aadhaar/otp/verify`**
```json
{
  "registrationId": "0536adf1-b64f-4f3d-bfb9-676d8f964486",
  "reference_id": "16746854",
  "otp": "123456"
}
```
**Success Response (`200 OK`):**
```json
{
  "success": true,
  "aadhaarVerified": true,
  "message": "Aadhaar verified successfully."
}
```
**Invalid OTP Response (`400 Bad Request`):**
```json
{
  "success": false,
  "message": "Invalid OTP.",
  "remainingAttempts": 2,
  "blocked": false,
  "blockedUntil": null
}
```

---

## 7. Risks & Mitigations

1. **Failure Shapes Unknown:**
   - *Risk:* IDSPay's failure response JSON structures for invalid OTP, expired OTP, and server errors are not yet documented.
   - *Mitigation:* We code defensively. A response is treated as a success *only* when explicit HTTP 200, `status.type === "success"`, and the required payload keys exist. All non-successes map cleanly to `INVALID_OTP` (for verify) or `PROVIDER_ERROR` (for generate) until Postman failure samples are captured and refined.
2. **PII & Logging Compliance:**
   - *Risk:* Leaking plain Aadhaar numbers, OTPs, or customer names in server logs.
   - *Mitigation:* Never log raw request/response bodies. Mask Aadhaar numbers as `XXXXXXXX1234`. Log only metadata: provider name, HTTP status, `status.type`, and `request_id`.
3. **No Unintended Side Effects on DigiLocker Flow:**
   - *Risk:* Touching `idspay.service.js` could break the DigiLocker redirect flow (`/aadhaar/initiate` and `/aadhaar/verify`).
   - *Mitigation:* The DigiLocker flow in `idspay.service.js` remains 100% untouched. The new OTP code is housed in its own clean directory `src/services/aadhaarOtp/`.

---

## 8. Answers to Open Questions & Recommendations

### Question 1: Aadhaar number storage — full or masked (last 4)?
- **Current Behavior:** Full 12 digits stored in `RegistrationSession.aadhaarNumber` and `Advocate.aadhaarNumber`.
- **Recommendation:**
  - In Indian law (UIDAI Aadhaar Act regulations), storing full unencrypted 12-digit Aadhaar numbers without a licensed Aadhaar Data Vault is illegal.
  - **Recommended Action:** Store masked format `XXXXXXXX1234` in `aadhaarNumber`. For uniqueness checks, store a one-way `SHA-256` hash of the 12 digits.
  - **Decision:** Awaiting your confirmation. If you want zero database schema changes right now, we can continue saving the clean 12 digits in the existing text column, or mask it as `XXXXXXXX1234`.

### Question 2: Name match — compare Aadhaar `full_name` with registered advocate name?
- **Recommendation:** Do **not** block the registration flow automatically on a name mismatch. Legal names in India frequently differ in spelling or initials (e.g. "R. Sharma" vs "Rajesh Sharma").
- Instead, simply calculate a similarity score (or log a warning) and store or surface it for the admin in the advocate approval panel (`AdvocateApprovalStatus`).

### Question 3: Sandbox provider — keep or delete?
- **Recommendation:** **Keep `sandbox.provider.js` marked `@deprecated`**.
- It provides immediate fallback and reference without cluttering the active codebase, easily switchable via `AADHAAR_OTP_PROVIDER=sandbox`.

### Question 4: Do existing IDSPay env vars belong to the same account/credentials as this new endpoint?
- In `.env`, `IDSPAY_CLIENT_ID`, `IDSPAY_CLIENT_SECRET`, and `IDSPAY_API_KEY` are currently configured.
- The new auto-verification endpoint requires `api_id`, `api_key`, and `token_id`.
- If `api_id` matches `IDSPAY_CLIENT_ID` and `api_key` matches `IDSPAY_API_KEY`, they can be reused. However, `IDSPAY_TOKEN_ID` is new and must be provided in `.env`.
- We will support explicit `IDSPAY_API_ID` with automatic fallback to `IDSPAY_CLIENT_ID`.

---

## 9. Current Database Host Notice

Per instructions:
> **Database Host:** `ep-weathered-hat-b47xszyr-pooler.c-6.us-east-2.aws.neon.tech` (Neon AWS Cloud PostgreSQL)
> **Notice:** No live database modifications or test data will be created in this database. No live calls to IDSPay will be made prior to explicit approval.
