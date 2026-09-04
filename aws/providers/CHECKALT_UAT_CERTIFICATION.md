# CheckAlt UAT certification (AWS staging)

**Date:** 2026-09-04  
**Branch:** `cursor/staging-checkalt-uat-cert-c8f0`  
**Scope:** CheckAlt UAT certification only — not production activation.  
**Moov:** Sandbox certification remains **PASS** (PR #124). Moov implementation was **not** modified.  
**Verdict:** **BLOCKED**

## Scorecard

| Area | Result |
|---|---|
| Authentication | **PASS** — `POST https://uatapi.checkalt.com/public/fincapture/authenticate` → JWT |
| Merchant / FI context | **PASS** — merchant header `lockbox5`; `CHECKALT_UAT_FI_KEY` present; host allowlisted |
| Deposit-account binding | **BLOCKED** — `CHECKALT_UAT_DEPOSIT_ACCOUNT_NUMBER` absent; `getDepositAccountInformation` → 400 `[accountNumber] must not be null` |
| Depositor / ssoKey | **BLOCKED** — `getUserAccountInformation` returns 2 accounts with keys `accountNumber`, `availableDepositLimit`, `dailyDepositLimit` only; **no `ssoKey`** |
| UAT submission | **BLOCKED** — fail-closed `409 account_unregistered` (`missing_depositor_sso_key`); `negotiableCheckSubmitted=false`; no bank numbers invented |
| Status retrieval | **BLOCKED** — no provider reference (submission never reached CheckAlt process) |
| Callback / webhook | **BLOCKED** — `CHECKALT_SANDBOX_WEBHOOK_SECRET` not configured → `401 sandbox_webhook_secret_unavailable` |
| Idempotency | **PARTIAL** — successful-deposit idempotency not exercised; fail-closed path refuses process without ssoKey |
| Reconciliation | **PASS** — `POST /sandbox/reconcile` report-only; `autoCorrected=false` |
| Tenant isolation | **PASS** — C1C lookup of Freedom CheckAlt sandbox op → `404 operation_not_found` |

## What was verified (safe)

1. Fresh Secrets Manager read of `checksops/staging/providers` (`AWSCURRENT`) — credential values never printed.
2. Staging Lambda sandbox harness against UAT only (`AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=true`).
3. Adapter amount unit preview remains integer cents (`userAmount=1` for $0.01).
4. Production flags remain false; production CheckAlt keys absent from staging secret.

## Exact remaining manual / vendor action

CheckAlt (or the operator with CheckAlt) must provide/configure on **UAT** / merchant **lockbox5**:

1. **Approved UAT deposit account number** — store as `CHECKALT_UAT_DEPOSIT_ACCOUNT_NUMBER` in `checksops/staging/providers`. Do **not** invent numbers. Do **not** copy production.
2. **Registered FinCapture depositor** whose `getUserAccountInformation` returns `accountDataList[].ssoKey`. The FI/API login is the operator view and must **never** be substituted as `ssoKey`.
3. Optionally **`CHECKALT_SANDBOX_WEBHOOK_SECRET`** for UAT callback signature/idempotency certification.

After those are in place, resume certification: synthetic `testDeposit` submission → status mapping → webhook → idempotency → reconcile.

## Production remains OFF

```
AWS_PROVIDER_EXECUTION_ENABLED=false
AWS_CHECKALT_ENABLED=false
AWS_MOOV_ENABLED=false
AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false
AWS_PLAID_ENABLED=false
```

No production webhook/DNS/auth/data changes. `64_financial_activation_grants.sql` not applied. Production Supabase/Lovable CheckAlt integration untouched.

## Evidence

- `/opt/cursor/artifacts/checkalt_uat_certification_blocked.json`
- `aws/providers/results/checkalt_uat_certification_blocked.json`
