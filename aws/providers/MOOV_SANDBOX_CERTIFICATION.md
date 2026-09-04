# Moov sandbox certification (AWS staging)

**Date:** 2026-09-04  
**Scope:** Moov sandbox certification only — not production activation.  
**Verdict:** **BLOCKED**

## Scorecard

| Item | Result |
|---|---|
| Moov sandbox certification | **BLOCKED** |
| Sandbox platform account ID | **not configured** |
| Auth (OAuth client_credentials with `MOOV_SANDBOX_*`) | **PASS** |
| Capabilities lookup | **BLOCKED** (no platform/connected account to read) |
| Wallet lookup | **BLOCKED** (no account context) |
| Payment-method / bank lookup | **BLOCKED** (no account context) |
| Provider egress | **PASS** (`moovReachable: true`) |
| Sandbox transfer | **not attempted** — fail-closed `sandbox_account_unmapped` (no HTTP to Moov) |
| Webhook signature / idempotency | **BLOCKED** — `MOOV_SANDBOX_WEBHOOK_SECRET` absent (`sandbox_webhook_secret_unavailable`) |
| Tenant isolation / kill switches | **PASS** (production Moov `provider_disabled`; financial flags false; transfer refuses production IDs) |
| Cognito → app UUID mapping | **PASS** (master `7dbb3009-…`) |

## Why blocked (no guessing)

Existing bootstrap (`aws/providers/oneshot/bootstrap-moov-sandbox.mjs`) and live probes prove:

1. `MOOV_SANDBOX_PUBLIC_KEY` / `MOOV_SANDBOX_SECRET_KEY` are present in `checksops/staging/providers`.
2. OAuth token mint succeeds for `/accounts.read` and `/accounts.write` scopes.
3. `GET /accounts` → **401**; `POST /accounts` → **401**.
4. No `MOOV_SANDBOX_CONNECTED_ACCOUNT_ID` exists to resolve `wallet.partnerAccountID`.
5. Therefore `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID` **cannot** be discovered programmatically from these keys.

Do **not** copy production RDS `provider_account_id` values or invent an ID.

## Exact manual action required

Perform these steps in the **Moov Dashboard for the sandbox application that owns the AWS staging API keys** (the key pair already stored as `MOOV_SANDBOX_*` — not production keys):

1. Sign in to [Moov Dashboard](https://dashboard.moov.io) for that **sandbox** app.
2. Open the platform / business account that owns the API keys.
3. Copy the **platform (facilitator) account ID**.
4. Optionally create or select a **sandbox connected business account** and copy its account ID (needed if payment-method / wallet probes should run against a connected account).
5. Confirm the API key can read that platform account (and, if you want bootstrap to create test accounts later, grant `/accounts.write` that actually authorizes `POST /accounts` — token mint alone is not enough; today create returns 401).
6. In AWS account **806168576068**, Secrets Manager secret `checksops/staging/providers`, add:

| Key | Value |
|---|---|
| `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID` | platform/facilitator account ID from step 3 |
| `MOOV_SANDBOX_CONNECTED_ACCOUNT_ID` | (optional) sandbox connected account from step 4 |
| `MOOV_SANDBOX_ALLOWED_ORIGIN` | Origin allowlisted on the Moov app (recommend `https://staging.checksops.com` or the origin already allowlisted; default code fallback is `https://checksops.com`) |
| `MOOV_SANDBOX_WEBHOOK_SECRET` | (optional but required for webhook cert) signing secret for staging webhooks |

7. Do **not** set production `MOOV_PLATFORM_ACCOUNT_ID` / production account IDs into these sandbox fields.
8. Tell the agent to resume Moov sandbox certification after the secret is updated (no production activation).

Optional Moov dashboard webhook wiring (after secret exists):

- Endpoint: `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging/sandbox/webhooks/moov`
- Use the same signing secret as `MOOV_SANDBOX_WEBHOOK_SECRET`
- Do **not** redirect production Moov webhooks

## Production remains OFF (verified)

```
AWS_PROVIDER_EXECUTION_ENABLED=false
AWS_MOOV_ENABLED=false
AWS_CHECKALT_ENABLED=false
AWS_PLAID_ENABLED=false
AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false
AWS_PROVIDER_WEBHOOK_DRY_RUN=true
AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=true   # sandbox HTTP only
```

`64_financial_activation_grants.sql` was **not** applied. Deposit Ops money RPCs remain disabled.

## Evidence artifacts

- `/opt/cursor/artifacts/moov_sandbox_certification_blocked.json`
- `/opt/cursor/artifacts/moov_bootstrap_result.json`
- Repo: `aws/providers/results/moov_sandbox_certification_blocked.json`

## Architecture note

No second Moov integration was added. Certification uses the existing sandbox harness (`/sandbox/moov/*`, `bootstrap-moov-sandbox.mjs`, parity client). Host is `https://api.moov.io` for both sandbox and production; **keys** select the ledger.
