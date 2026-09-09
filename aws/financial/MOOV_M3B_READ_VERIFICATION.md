# Moov production readiness — Phase M3b (Freedom GET)

**Status:** STOP FOR REVIEW. Read-contract is complete. Money flags remain false. Money routes stay blocked before provider HTTP. Freedom `POST /functions/v1/moov-readiness` reached Moov. OAuth token POST succeeded. Every production GET returned **401**. Live account/KYC/KYB/ToS/wallet/bank/capability fields were **not** read. SQL 72 **NOT_APPLIED**. Zero money movement.

**Date:** 2026-09-09  
**Branch:** `cursor/moov-production-readiness-m3b-a508`  
**Deployed git:** `fd194ea0`  
**Lambda code SHA-256:** `9rYhhaT6qymQwUsKq8EGNrpPFc9ox4dFLHnLDhd3NTE=`

No secret values are printed. Provider account ids are redacted.

---

## 1. AWSCURRENT read contract

Secret: `checksops/production/provider` (singular). AWSCURRENT created `2026-09-09T23:01:28Z`. Previous typo version is `AWSPREVIOUS`. `MOOV_ENVIRO` is gone.

| Name | configured |
| --- | --- |
| `MOOV_PUBLIC_KEY` | **true** |
| `MOOV_SECRET_KEY` | **true** |
| `MOOV_ENVIRONMENT` | **true** |
| `MOOV_ALLOWED_ORIGIN` | **true** |

`MOOV_ENVIRONMENT` equals `production`.  
Origin host is `checksops.com` with a trailing slash; the adapter normalizes it and accepts `https://checksops.com`.

`MOOV_PLATFORM_ACCOUNT_ID` and `MOOV_WEBHOOK_SECRET` remain absent. Full execution-contract is incomplete (expected for GET-only).

**READ-CONTRACT COMPLETE:** yes

Lambda `/providers/status` booleans match: all four read names `*_configured=true`.

---

## 2. Flags (must stay false except live-reads)

| Flag | Value |
| --- | --- |
| `AWS_PROVIDER_LIVE_READS_ENABLED` | true |
| `AWS_MOOV_ENABLED` | false |
| `AWS_PROVIDER_EXECUTION_ENABLED` | false |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | false |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | false |

Financial permission activations (`deposit_submission`, `disbursement`, `ach`, `rtp`, `wallet_transfer`, `stakeholder_payment`, `provider_configuration`) are all **false**.  
`productionSupabaseChanged=false`. `productionWebhooksRedirected=false`.

---

## 3. Money routes (re-proved after secret correction)

| Route | Lambda | CloudFront | `liveProviderCalled` |
| --- | --- | --- | --- |
| `moov-transfer-create` | `403 production_execution_blocked` | `403 production_execution_blocked` | false |
| `moov-disburse` | `403 production_execution_blocked` | `403 production_execution_blocked` | false |

Blocked before identity/RDS/provider HTTP.

Browser-supplied Moov account id on readiness: `400 untrusted_provider_config`, `liveProviderCalled=false`.

---

## 4. Freedom GET — `POST /functions/v1/moov-readiness`

Empty body. No browser Moov account id. Server derived the Freedom production `payment_provider_accounts` row (`provider_account_id` present).

| Step | Result |
| --- | --- |
| OAuth `POST /oauth2/token` | succeeded (otherwise the client returns authenticate-failed, not GET 401) |
| `GET /accounts/{id}` | **401** |
| `GET /accounts/{id}/capabilities` | **401** |
| `GET /accounts/{id}/wallets` | **401** |
| `GET /accounts/{id}/wallets/{id}` | **401** |
| `GET /accounts/{id}/bank-accounts` | **401** |
| `GET /accounts/{id}/payment-methods` | **401** |

Handler: `502 moov_account_get_failed`, `liveProviderCalled=true`, `productionExecution=false`, `created=false`, `mutated=false`.

### Live Moov fields (not read — GET 401)

| Field | Live value |
| --- | --- |
| account status / type | **not read** |
| KYC / KYB | **not read** |
| ToS | **not read** (`accepted: null`) |
| requirements / action_required | **not read** (`present: false`) |
| wallet status / balance | **not read** |
| bank / payment-method status | **not read** |
| `send-funds.ach` | **not read** |
| `collect-funds.ach` | **not read** |
| `wallet.balance` | **not read** |
| same-day ACH | **not read** |

RDS still has a Freedom production row (business, onboarding `active`, verification `verified`, `can_ach_credit=true`, `can_ach_debit=false`). That is **not** live Moov truth.

**Sender readiness:** **BLOCKED** (`live_account_get_failed`, `send_funds_ach_unknown`, `wallet_missing`, `bank_missing`)

**Controlled recipient readiness:** **RECIPIENT_NOT_CONFIRMED** — 4 Moov recipient rows, all `awaiting_bank` (3 production, 1 sandbox). C1C was not used.

---

## 5. Safety

| Check | Result |
| --- | --- |
| Production GET count | **6** (all 401) |
| Production money POST count | **0** |
| OAuth token POST count | **5** (allowed in read mode; `/oauth2/token` only) |
| Money movement | **zero** |
| SQL 72 | **NOT_APPLIED** (`provider_http_attempted_at` does not exist) |
| Lovable / production Supabase | unchanged |
| Webhook destination | unchanged |
| Money flags | still false |
| Moov account / capabilities / banks | **not modified** |

---

## Next (human review — do not do from this agent)

401 after a successful token request means the production keys can authenticate, then resource GETs are unauthorized. Likely causes for review: key/account access, token scopes, or Origin registration on the Moov application. Do not enable money flags. Do not apply SQL 72. Do not request capabilities, accept ToS, add banks, fund wallets, or create recipients.
