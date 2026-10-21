# Plan: Fix Vercel Deployment Failure Caused by Cron Frequency (Hobby Plan)

## 1. Current State & Findings

### `vercel.json` Inspection
Currently, `vercel.json` contains two cron entries under `crons`:
1. `path`: `"/api/internal/cron/payments-reconcile"`, `schedule`: `"*/15 * * * *"`
   - **Issue:** Runs every 15 minutes (96 times a day). Vercel Hobby plan strictly limits cron executions to **at most once per day**. This causes deployment to fail with:
     > *"Hobby accounts are limited to daily cron jobs."*
2. `path`: `"/api/internal/cron/refund-eligibility"`, `schedule`: `"0 2 * * *"`
   - Runs once per day at 02:00 UTC.

### Route Verification in Code
- In `src/server.js`:
  ```javascript
  app.use('/api/internal/cron', cronPaymentRouter);
  ```
- In `src/routes/payment.routes.js`:
  - `GET /payments-reconcile` -> resolves to `/api/internal/cron/payments-reconcile`
  - `GET /refund-eligibility` -> resolves to `/api/internal/cron/refund-eligibility`
- In `src/controllers/paymentCron.controller.js`:
  - Verified authorization check:
    ```javascript
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${cronSecret}`) {
      res.status(401).json({ success: false, message: 'Unauthorized: Invalid cron secret' });
      return false;
    }
    ```
  - Both endpoints are strictly protected by `Authorization: Bearer ${process.env.CRON_SECRET}`.

---

## 2. Planned Changes

### A. `vercel.json` (Daily Crons for Vercel Hobby)
Change all cron jobs in `vercel.json` to run **once per day** (UTC):
- **Payments Reconcile:** `"30 20 * * *"` (20:30 UTC ≈ 02:00 IST)
- **Refund Eligibility:** `"0 21 * * *"` (21:00 UTC ≈ 02:30 IST)

`vercel.json` structure:
```json
{
  "version": 2,
  "functions": {
    "api/index.js": {
      "includeFiles": "uploads/**"
    }
  },
  "crons": [
    {
      "path": "/api/internal/cron/payments-reconcile",
      "schedule": "30 20 * * *"
    },
    {
      "path": "/api/internal/cron/refund-eligibility",
      "schedule": "0 21 * * *"
    }
  ],
  "rewrites": [
    {
      "source": "/(.*)",
      "destination": "/api/index.js"
    }
  ]
}
```
*`version`, `functions`, and `rewrites` remain completely untouched.*

### B. Frequent Reconcile via GitHub Actions (Free, Outside Vercel)
Create `.github/workflows/payments-reconcile.yml`:
- **Triggers:**
  - `schedule: - cron: "*/15 * * * *"` (runs every ~15 minutes)
  - `workflow_dispatch` (allows manual testing from GitHub Actions UI)
- **Concurrency:**
  - `concurrency: { group: payments-reconcile, cancel-in-progress: false }`
- **Job:**
  - Runner: `ubuntu-latest`
  - Command:
    ```bash
    curl -fsS --max-time 60 \
      -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" \
      "${{ vars.BACKEND_URL || 'https://backend-vakeelsetu.vercel.app' }}/api/internal/cron/payments-reconcile"
    ```
  - Only calls `/payments-reconcile`. Does **not** call `/refund-eligibility` (stays daily on Vercel only).

### C. `README.md` Documentation
Update Section 29 ("Consultancy Payments (Razorpay)"):
- Document Vercel Hobby plan daily constraint and schedule table (UTC & IST).
- Document GitHub Actions 15-minute background reconciler.
- Step-by-step guide for setting `CRON_SECRET` in Vercel and GitHub repository secrets.
- Manual verification `curl` command.
- Note explaining that upgrading to Vercel Pro allows moving `*/15 * * * *` back to `vercel.json`.

---

## 3. Strict Compliance Checks
- No payment logic, models, controllers, services, or migrations are modified.
- No DB scripts, seeds, or migrations will be run.
- No real secrets stored in code.

---
**Status:** Waiting for user confirmation ("approved") before making changes.
