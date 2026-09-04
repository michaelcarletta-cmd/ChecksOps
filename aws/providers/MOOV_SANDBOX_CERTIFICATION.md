# Moov sandbox certification (AWS staging)

**Date:** 2026-09-04 (resumed after manual secret configuration)  
**Scope:** Moov sandbox certification only — not production activation.  
**Verdict:** **PARTIAL**

## Scorecard

| Item | Result |
|---|---|
| Moov sandbox certification | **PARTIAL** |
| Sandbox platform account ID | **configured** (redacted in artifacts) |
| Connected sandbox account ID | **not configured** |
| OAuth / auth (`MOOV_SANDBOX_*`) | **PASS** |
| Allowed origin | **PASS** (`https://staging.checksops.com`) |
| Platform account mapping (secret present, ≠ RDS production IDs) | **PASS** |
| `/accounts` list authorization | **FAIL** HTTP **401** |
| `GET /accounts/{platform}` | **FAIL** HTTP **401** (empty body) |
| Capabilities | **BLOCKED** by account 401 |
| Wallet | **BLOCKED** by account 401 |
| Payment methods / bank | **BLOCKED** by account 401 |
| Provider egress | **PASS** |
| AWS staging webhook signature validation | **PASS** |
| Webhook idempotency / replay | **PASS** (`duplicate: true` on replay; bad sig / skew → 401) |
| Cognito → application UUID → tenant | **PASS** |
| Cross-tenant provider isolation | **PASS** (payload `tenant_id` ignored; transfer fail-closed `sandbox_account_unmapped`; production Moov path `provider_disabled`) |
| Simulated sandbox transfer | **not performed** — account reads unauthorized + no sandbox payment-method mapping |

## What progressed since the prior BLOCKED attempt

Configured in `checksops/staging/providers` (values not logged):

- `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID`
- `MOOV_SANDBOX_WEBHOOK_SECRET`
- `MOOV_SANDBOX_ALLOWED_ORIGIN` = `https://staging.checksops.com`
- Rotated `MOOV_SANDBOX_PUBLIC_KEY` / `MOOV_SANDBOX_SECRET_KEY`
- CheckAlt UAT credentials rotated (not exercised in this Moov-only cert)

Webhook path certified against staging endpoint:

`POST /staging/sandbox/webhooks/moov`

## Exact remaining Moov requirement (STOP — do not bypass)

OAuth token mint succeeds **including account-scoped scopes** for the configured platform UUID, but every resource call returns **401**:

- `GET /accounts`
- `GET /accounts/{platformAccountId}`
- wallets / payment-methods / capabilities under that account

This is **not** an AWS IAM/Lambda issue. The sandbox API key cannot authorize that account ID.

### Manual Moov dashboard / API-key action

1. Open the Moov Dashboard for the **same sandbox application** that owns the rotated staging `MOOV_SANDBOX_*` keys.
2. Confirm the platform/facilitator **Account ID** shown for that application matches the value stored as `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID`.
3. If it does not match, replace the secret with the Account ID from that app (do not paste production account IDs from ChecksOps RDS).
4. In API key / application permissions, ensure the key can **read** that account (profile, wallets, payment-methods, capabilities). Token mint alone is insufficient — resource GETs must return 200.
5. Optional: create a sandbox **connected** business account with a wallet payment method; set `MOOV_SANDBOX_CONNECTED_ACCOUNT_ID`.
6. Prove with Moov API explorer or curl that `GET /accounts/{id}` returns **200** using the staging sandbox keys + `Origin: https://staging.checksops.com`.
7. Resume certification for capabilities/wallet/methods and a minimal simulated transfer.

Until step 6 succeeds, ChecksOps will **not** invent payment methods, copy production Moov IDs, or send transfer HTTP.

## Staging code fix deployed

`/sandbox/moov/probe` now prefers the configured `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID` when `GET /accounts` list is unauthorized (still refuses RDS production ID overlap). Live probe now reports `reads.account.httpStatus: 401` instead of skipping account reads.

## Production remains OFF (verified)

```
AWS_PROVIDER_EXECUTION_ENABLED=false
AWS_MOOV_ENABLED=false
AWS_CHECKALT_ENABLED=false
AWS_PLAID_ENABLED=false
AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false
AWS_PROVIDER_WEBHOOK_DRY_RUN=true
AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=true
```

`64_financial_activation_grants.sql` was not applied. Production Moov → Supabase webhooks were not modified.

## Plaid

Plaid is **not required** by ChecksOps and is removed from the genuine production-cutover blocker list. Keep `AWS_PLAID_ENABLED=false`.

## Evidence

- `/opt/cursor/artifacts/moov_sandbox_certification_resume.json`
- `/opt/cursor/artifacts/moov_probe_after_platform_fix.json`
- Repo mirrors under `aws/providers/results/`
