# CheckAlt UAT certification (AWS staging)

**Date:** 2026-09-04  
**Branch:** `cursor/staging-checkalt-uat-cert-c8f0`  
**PR:** #125  
**Scope:** CheckAlt UAT certification only — not production activation.  
**Moov:** Sandbox certification remains **PASS** (PR #124). Moov implementation was **not** modified.  
**Verdict:** **PARTIAL** — STOP for review

## Authoritative CheckAlt assumptions (updated)

1. **Webhooks are not required** for CheckAlt certification or production cutover. `CHECKALT_SANDBOX_WEBHOOK_SECRET` is **not** a blocker. Deposit/status information is obtained through FinCapture workflow/status/history endpoints.
2. Documented FinCapture workflow: authenticate → register user/depositor → `getUserAccountInformation` → `getDepositAccountInformation` → deposit process → deposit history/status.
3. Per merchant, either `busUnitId` or `busUnitName` may be used. Freedom Adjustment is provisioned as a UAT business unit — use CheckAlt-provided values from configuration/API only; do not invent or substitute production values.
4. Do **not** use sample deposit account `123456789` unless the UAT API independently returns it as authorized for our business unit.

## Scorecard

| Area | Result |
|---|---|
| Authentication | **PASS** — `POST /public/fincapture/authenticate` → JWT on `https://uatapi.checkalt.com` |
| Merchant / FI context | **PASS** — merchant `lockbox5`; `CHECKALT_UAT_FI_KEY` present; Freedom Adjustment UAT business unit present in staging `checkalt_config` |
| Deposit-account binding | **PASS** — `getUserAccountInformation` returned 2 accounts; `getDepositAccountInformation` authorized account redacted `31…73` (fingerprint `46bed6e573bb`). Sample `123456789` **not** used / **not** returned |
| Depositor / ssoKey | **PASS** — synthetic UAT depositor registered via `/fincapture/useraccount/register`; `ssoKey` discoverable (stored as UAT-isolated sandbox object; production `checkalt_tenant_accounts` not written). FI API login is **not** used as `ssoKey` |
| UAT submission | **PARTIAL** — process reached CheckAlt `POST /fincapture/deposit/process` with `testDeposit: true` and registered depositor; CheckAlt returned **HTTP 500** image QA: *"Check deposit processing failed. Please retake the check images and resubmit."* No provider reference issued; `negotiableCheckSubmitted=false` |
| Status / history | **BLOCKED** — no successful deposit reference to poll |
| Callback / webhook | **N/A** — CheckAlt confirmed webhooks are not required |
| Idempotency | **BLOCKED** — success-path idempotency not exercised (no accepted deposit) |
| Reconciliation | **PASS** — `POST /sandbox/reconcile` report-only; `autoCorrected=false` |
| Tenant isolation | **PASS** — C1C lookup of Freedom CheckAlt sandbox op → `404 operation_not_found` |

## FinCapture workflow executed

1. Authenticate (PASS)
2. Register synthetic UAT-only depositor (PASS)
3. `getUserAccountInformation` (PASS — 2 accounts; FI view has no `ssoKey`, as expected)
4. `getDepositAccountInformation` (PASS — one authorized UAT deposit account)
5. Deposit process with synthetic VOID JPEG / check-sized fixtures + `testDeposit: true` (FAIL — CheckAlt image QA HTTP 500)
6. Deposit history/status (not reached)

## What was verified (safe)

1. Fresh Secrets Manager read of `checksops/staging/providers` (`AWSCURRENT`) — credential values never printed.
2. Staging Lambda sandbox harness against UAT only (`AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=true`).
3. Adapter amount unit preview remains integer cents (`userAmount=1` for $0.01).
4. Production flags remain false; production CheckAlt keys absent from staging secret.
5. Deposit account discovered via UAT API (not invented; not sample `123456789`).
6. Synthetic depositor isolated in `aws_provider_sandbox_objects` (`object_type=uat_tenant_account`).

## Exact remaining action (STOP)

**Deposit account number is no longer the primary blocker** — UAT API identified an authorized account.

**Only remaining CheckAlt / operator gap for a full PASS:**

1. CheckAlt-acceptable **UAT check image fixture** (or vendor guidance / image-QA bypass for `testDeposit` on UAT) so synthetic VOID images are accepted by `/fincapture/deposit/process`.
2. After an accepted deposit: verify status/history retrieval, idempotency, and reconciliation against that provider reference.

Do **not** invent bank numbers. Do **not** enable production CheckAlt. Do **not** modify Moov.

## Production remains OFF

```
AWS_PROVIDER_EXECUTION_ENABLED=false
AWS_CHECKALT_ENABLED=false
AWS_MOOV_ENABLED=false
AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false
AWS_PLAID_ENABLED=false
```

No production webhook/DNS/auth/data changes. `64_financial_activation_grants.sql` not applied. Production Supabase/Lovable CheckAlt integration untouched. Certified Moov integration untouched.

## Evidence

- `/opt/cursor/artifacts/checkalt_uat_certification_partial.json`
- `aws/providers/results/checkalt_uat_certification_partial.json`
