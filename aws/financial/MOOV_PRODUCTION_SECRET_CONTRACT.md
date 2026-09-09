# Production Moov secret contract

**DO NOT CREATE this secret in this phase.**
**DO NOT load credential values.**
**DO NOT copy `MOOV_SANDBOX_*` into production names.**
**DO NOT print secret values.**

M3 inventory is **fixed in code**. Production-prep Lambda currently has `PROVIDER_SECRETS_ARN` unset and every `MOOV_*` name **MISSING**. Staging has sandbox names only; production names **MISSING**. **Do not create this secret in M3.**

## Location

| Item | Value |
| --- | --- |
| Secrets Manager id | `checksops/production/providers` (same JSON object as CheckAlt production) |
| Lambda env | `PROVIDER_SECRETS_ARN` pointing at that id — **production Lambda only**, never `checksops/staging/providers` |
| JSON object | one document; CheckAlt and Moov names may coexist; adapters select by **exact name** |

Production Moov execution reads **only** the production names below. `MOOV_SANDBOX_*` cannot satisfy the production path. Same host `https://api.moov.io` is not an environment switch; the **credential set** is.

## Required names (never values)

These are the names current production Edge Functions actually read (`supabase/functions/_shared/moovClient.ts`, `moovGuard.ts`, `moov-webhook`).

| Name | Purpose | Used by current code |
| --- | --- | --- |
| `MOOV_PUBLIC_KEY` | OAuth client id for production | `credentialsFor('production')` |
| `MOOV_SECRET_KEY` | OAuth client secret for production | `credentialsFor('production')` |
| `MOOV_PLATFORM_ACCOUNT_ID` | Facilitator / platform account for `POST /accounts/{id}/transfers` | `facilitatorAccountId()` when `MOOV_ENVIRONMENT=production` |
| `MOOV_WEBHOOK_SECRET` | HMAC for `POST /webhooks/moov` | `moov-webhook` |
| `MOOV_ENVIRONMENT` | Must be the string `production` for this contract | `moovEnvironment()` default; tenant row may still bind per-tenant |
| `MOOV_ALLOWED_ORIGIN` | Origin header for OAuth + API (`https://checksops.com`) | `moovOrigin()` |

## Required for fail-closed production AWS (M3 inventory)

`aws/functions/api/provider-secrets.mjs` and `sandbox-credentials.mjs` now inventory `MOOV_PLATFORM_ACCOUNT_ID` and `MOOV_ALLOWED_ORIGIN`. `MOOV_ACCOUNT_ID` is **not** inventoried as a production facilitator.

| Name | Status |
| --- | --- |
| `MOOV_PLATFORM_ACCOUNT_ID` | **Required.** Facilitator POST. Do not substitute a tenant connected-account id. |
| `MOOV_ALLOWED_ORIGIN` | **Required.** Missing Origin → Moov 401. Production value must be `https://checksops.com`, not `https://staging.checksops.com`. |
| `MOOV_ACCOUNT_ID` | **Do not use as facilitator.** Tenant Moov ids live in `payment_provider_accounts.provider_account_id`, never from the browser. |

## Optional / not for first transfer

| Name | Purpose |
| --- | --- |
| `MOOV_API_VERSION` | Default pin `v2024.01.00` in code if unset |
| `MOOV_FEE_PLAN_ID` / `MOOV_FEE_PLAN_CODES` | Onboarding fee plans — not first-transfer |
| `MOOV_PLATFORM_PAYMENT_METHOD_ID` | Platform fee charge / treasury — not first-transfer |
| `MOOV_ENABLED` | Lovable Edge kill switch only. AWS production must **not** honor this as an enable; AWS uses `AWS_MOOV_ENABLED` + master holds |

## Refused names on the production adapter

| Name | Why |
| --- | --- |
| `MOOV_SANDBOX_PUBLIC_KEY` | Sandbox ledger |
| `MOOV_SANDBOX_SECRET_KEY` | Same |
| `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID` | Sandbox facilitator |
| `MOOV_SANDBOX_ALLOWED_ORIGIN` | Staging origin |
| `MOOV_SANDBOX_WEBHOOK_SECRET` | Staging HMAC fixture |
| Staging `AWS_MOOV_WEBHOOK_SECRET` | Lambda env fallback for sandbox dry-run only |

## Read-only vs money-execution contracts (M3.1)

Do **not** weaken the money-execution list. Distinguish:

| Name | Read-only GET | Money execution |
| --- | --- | --- |
| `MOOV_PUBLIC_KEY` | **required** (OAuth client id) | required |
| `MOOV_SECRET_KEY` | **required** | required |
| `MOOV_ENVIRONMENT` | **required** `production` | required `production` |
| `MOOV_ALLOWED_ORIGIN` | **required** (`https://checksops.com`; this integration's token request 401s without Origin) | required |
| `MOOV_PLATFORM_ACCOUNT_ID` | not required for tenant account/wallet/bank/capability GET; required to GET a facilitator transfer | **required** facilitator |
| `MOOV_WEBHOOK_SECRET` | **not required** for GET | **required** |

`loadProductionMoovReadSecrets()` enforces the read minimum. `loadProductionMoovSecrets()` still enforces all six names.

## Fail closed

If `PROVIDER_SECRETS_ARN` is unset, the secret is missing, any required production name is absent, `MOOV_ENVIRONMENT` is not `production`, Origin is staging/sandbox, or any `MOOV_SANDBOX_*` value equals a production name, the production adapter refuses **before** HTTP.

UAT/sandbox keys in `checksops/staging/providers` are ignored.

## Not selected by the browser

Tenant connected-account id, bank payment-method id, recipient payment-method id, amount, and rail are loaded server-side from `payment_provider_accounts` / `payment_provider_methods` / `external_payment_recipients` / `disbursement_splits` for the **resource** tenant.
