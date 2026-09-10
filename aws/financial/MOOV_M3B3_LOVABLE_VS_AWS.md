# Moov M3b.3 — forensic compare Lovable/Supabase (known-good) vs AWS

**Status:** STOP FOR REVIEW. Read-only. **No remediation executed.**  
**Date:** 2026-09-10  
**Branch:** `cursor/moov-production-readiness-m3b-1-a508`  
**Re-verify capture:** `2026-09-10T02:19:18Z` (flags, secret metadata, RDS). **Zero Moov HTTP this pass.**

No secret values or access tokens are printed. Ids are fingerprints (`first8…last4`).

Live Supabase Edge secret **values** are not readable from this agent (no management token). Comparison of Lovable credential **values** is therefore by name + code + RDS history (including Moov `mode` on stored account payloads), plus AWS Secrets Manager **metadata** only.

---

## 1. Working Lovable Moov inventory

All server Moov REST goes through `supabase/functions/_shared/moovClient.ts`:

`requireMoovCaller` / `bindMoovEnvironment` → `credentialsFor(env)` → `moovToken()` (`POST /oauth2/token`) → `moovFetch` / `moovUpload` (Bearer).

Browser SPA (`src/lib/payments/providers/moovProvider.ts`) only invokes Edge functions. No Moov credentials in the browser except the `public_key` field returned for Drops.

| Area | Functions / modules | Auth to Moov |
| --- | --- | --- |
| OAuth / token | `_shared/moovClient.ts` `moovToken()` | OAuth `client_credentials` + Basic |
| Account reads / sync / readiness | `moov-readiness`, `moov-sync`, `moov-selftest`, `platform-treasury` | OAuth then GET |
| Account create / onboard | `moov-account-create` (`POST /accounts`), `moov-account-onboard`, `moov-onboarding-link`, `moov-account-discover` | OAuth |
| ToS | `moov-tos-token` (server-mints Drop token), `moov-tos-accept`, `moov-recipient-tos-accept` | OAuth |
| Capabilities / underwriting / files | `moov-sync`, `moov-underwriting`, `moov-account-files`, `moov-account-file-upload`, `moov-account-file-view` | OAuth |
| Banks | `moov-bank-link-token`, `moov-bank-account-add`, `moov-micro-deposit-initiate`, `moov-micro-deposit-confirm` | OAuth |
| Wallets / funding | `moov-wallet-sync`, `moov-wallet-fund`, `initiate-wallet-funding`, `cancel-wallet-funding`, `wallet-fund-on-clear`, `_shared/moovWallet.ts` | OAuth |
| Transfer create | `moov-transfer-create` → `POST /accounts/{facilitator}/transfers` | OAuth (`transfers.write` on facilitator) |
| Transfer group / status | `moov-transfer-group-create`, `moov-transfer-status` | OAuth |
| Disburse | `moov-disburse` (same `moovFetch`; **internal** `process-funded-payment` path skips `requireMoovCaller`, still uses `moovFetch`) | OAuth |
| Recipients / payees | `moov-recipient-create`, `moov-recipient-session`, `moov-recipient-kyc-update`, `moov-recipient-tos-accept`, `moov-recipient-bank-add`, `moov-recipient-disconnect` | OAuth; public-link routes bind `recipient.environment` |
| Fees / sweeps / invoices | `moov-tenant-fee-charge`, `moov-fee-schedule-*`, `moov-fee-rollup`, `moov-sweep-config`, `moov-invoice` | OAuth |
| Platform bank | `moov-platform-bank` | OAuth against `MOOV_PLATFORM_ACCOUNT_ID` |
| Webhook | `moov-webhook` | **HMAC** (`MOOV_WEBHOOK_SECRET`); **no OAuth** |
| Plaid bridge | `moov-plaid-bridge` | OAuth (Moov) + Plaid separately |

**Known-good auth path that minted tokens in production:** tenant with `moov_environment=production` → `credentialsFor('production')` reads `MOOV_PUBLIC_KEY` + `MOOV_SECRET_KEY` → `POST https://api.moov.io/oauth2/token` with Basic + Origin → Bearer GET/POST.

---

## 2. Working Lovable auth contract (no values)

| Item | Working Lovable |
| --- | --- |
| Base URL | `https://api.moov.io` (sandbox **and** production; host is not the environment switch) |
| Token URL | `POST https://api.moov.io/oauth2/token` |
| Auth | `Authorization: Basic base64(publicKey:secretKey)` via Deno `btoa` |
| Grant | `client_credentials` |
| Body encoding | `application/x-www-form-urlencoded` via `URLSearchParams({ grant_type, scope })` |
| Production public name | `MOOV_PUBLIC_KEY` |
| Production secret name | `MOOV_SECRET_KEY` |
| Sandbox pair | `MOOV_SANDBOX_PUBLIC_KEY` / `MOOV_SANDBOX_SECRET_KEY` |
| Origin | `moovOrigin()`: sandbox uses `MOOV_SANDBOX_ALLOWED_ORIGIN`; else `MOOV_ALLOWED_ORIGIN` \|\| `CHECKSOPS_APP_URL` \|\| `https://checksops.com` (scheme+host, no path) |
| `requestOrigin` override | **unused** by current callers; every `moovToken` / `moovFetch` uses `moovOrigin()` |
| Registered domain expected | whatever is stored in `MOOV_ALLOWED_ORIGIN` / `CHECKSOPS_APP_URL`; code default is **`https://checksops.com`** |
| Scopes | per-call; readiness/account GET uses `/accounts/{id}/profile.read` |
| `x-moov-version` | **not sent on OAuth**; on GET: `MOOV_API_VERSION` or **`v2024.01.00`** |
| Token Accept | omitted |
| GET headers | `Authorization: Bearer`, `Content-Type: application/json`, `Accept: application/json`, `Origin`, `x-moov-version`; optional `X-Idempotency-Key`, `X-Account-ID` |
| Token cache | yes, per `environment\|origin\|scope` |
| OAuth used for every REST route? | **Yes**, except webhook HMAC |
| Different auth mechanism | **Webhook HMAC only.** Drop endpoints mint OAuth server-side and also return `public_key: MOOV_PUBLIC_KEY` (production **name**, even if the bound env is sandbox) |

Lovable does **not** reference `MOOV_CLIENT_ID`, `MOOV_CLIENT_SECRET`, or `MOOV_ACCOUNT_ID`.

---

## 3. Whether Lovable is Test or Production

**Mixture by tenant. Freedom’s working connected account is Moov Production/Live, not Test Mode.**

Not inferred from variable names:

| Evidence | Result |
| --- | --- |
| Host | always `api.moov.io` (cannot distinguish Test vs Live) |
| Freedom `tenants.moov_environment` | **`production`** (`moov_allowlisted=true`) |
| Freedom `payment_provider_accounts.environment` | **`production`**, `provider_account_id` `60922058…de96` |
| **Moov account payload `mode`** (stored from live Lovable GET/create) | **`production`** for Freedom, C1C, and the pipeline-test **production** row |
| Freedom display name on that payload | `Freedom Adjustment LLC` |
| Freedom capabilities on that payload | `send-funds:enabled`, `transfers:enabled`, `wallet:enabled`; `collect-funds` / ACH send still in-review |
| Freedom ToS / verification | ToS `2026-08-28`, verification `verified`, onboarding `active`, `last_synced_at` `2026-08-28T19:28:21Z` |
| Freedom wallet | production operating wallet **active**, same account id |
| Freedom `payment_event_log` (latest 50 for that tenant) | **both** historical **sandbox** (funding, micro-deposits, invoices) **and** later **production** (account create, ToS, capabilities, recipient create, sweep_config) |
| Org-wide transfer events | production `transfer.created` ids `8a23259b…c0da` (2026-08-26) and `dacaf768…fb78` (2026-09-02); `tenant_id` null on those webhook rows |

JWT `aid`/`caid` from live Lovable was **not** obtainable (cannot invoke Edge without a Supabase user JWT; this pass did not mint from AWS).

---

## 4. Working application / account relationship

| Role | Fingerprint | Source |
| --- | --- | --- |
| Freedom connected account (Lovable + AWS RDS) | **`60922058…de96`** | `payment_provider_accounts.provider_account_id` **and** Moov payload `mode=production` |
| RDS row PK (not sent to Moov) | `26c2dbb1…4005` | same row |
| C1C production connected account | `817e1bf0…1708` | same table; Moov `mode=production` |
| Pipeline-test production row (incomplete) | `7597a1f1…bb73` | tenant `moov_environment=sandbox` but a **production-mode** account row exists |
| Lovable facilitator | `MOOV_PLATFORM_ACCOUNT_ID` (Edge env) | **absent from AWS production secret**; used for `POST /accounts/{facilitator}/transfers` |
| AWS sandbox / Test Mode platform (not Lovable prod) | `36b79957…47bb` | staging `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID` |

Freedom’s stored id **is** the Lovable production connected account. AWS readiness already targets that same id. **No database account-id change** is indicated.

Production platform/facilitator UUID is **not** in RDS and **not** in the AWS GET secret. It lives in Lovable Edge `MOOV_PLATFORM_ACCOUNT_ID`. Do not substitute `36b79957…47bb` or Freedom’s connected id.

---

## 5. Credential metadata (no values)

| | Lovable working (code + inaccessible Edge store) | AWS `checksops/production/provider` AWSCURRENT `e4d68c6b…5057` | Working AWS **sandbox** (`checksops/staging/providers`) |
| --- | --- | --- | --- |
| Public name | `MOOV_PUBLIC_KEY` | `MOOV_PUBLIC_KEY` | `MOOV_SANDBOX_PUBLIC_KEY` |
| Public length / shape | **unknown here** | **16**, mixed alnum, **not UUID**, sha256-12 `b4dd6a5880e7` | **16**, mixed alnum+other, **not UUID**, sha256-12 `2e3da5f53f6b` |
| Secret name | `MOOV_SECRET_KEY` | `MOOV_SECRET_KEY` | `MOOV_SANDBOX_SECRET_KEY` |
| Secret length / shape | unknown | **32**, alnum+other, sha256-12 `ed250849c09a` | **32**, alnum+other, sha256-12 `e206c705e65f` |

Same **type** as the org’s working sandbox API-key pair (16/32 Basic OAuth client). AWS production is **not** a UUID client-id, **not** a missing-type problem versus sandbox. Hashes **differ** from sandbox (not a copy of Test Mode keys).

Lovable production **values** were not readable, so they are **not proven equal** to the AWS pair. Behavioral proof they differ: this AWS pair **does not mint** (`POST /oauth2/token` **401** on M3b.1 retries). Lovable **did** mint (production account payload + production events exist).

---

## 6. HTTP: Lovable working vs AWS current

| FIELD | LOVABLE WORKING | AWS CURRENT | MATCH? |
| --- | --- | --- | --- |
| URL | `https://api.moov.io/oauth2/token` | `https://api.moov.io/oauth2/token` | **YES** |
| Method | POST | POST | **YES** |
| Basic construction | `btoa(key:secret)` | `Buffer.from(key:secret).toString('base64')` | **YES** (ASCII) |
| Origin sent | `moovOrigin()` default `https://checksops.com` | hardcoded `PRODUCTION_MOOV_ORIGIN` = `https://checksops.com` | **YES** (value) |
| Stored origin | `MOOV_ALLOWED_ORIGIN` or `CHECKSOPS_APP_URL` (Edge, unread) | host `checksops.com`, stored length 22 (trailing slash); **not** sent with slash | n/a (AWS client ignores path) |
| grant_type | `client_credentials` | `client_credentials` | **YES** |
| Readiness scope | `/accounts/{id}/profile.read` | `/accounts/{id}/profile.read` | **YES** |
| Token Content-Type | `application/x-www-form-urlencoded` | same | **YES** |
| Token body encoding | `URLSearchParams` | `URLSearchParams` | **YES** |
| Token Accept | omitted | omitted | **YES** |
| Token x-moov-version | omitted | omitted | **YES** |
| GET x-moov-version | `v2024.01.00` | `v2024.01.00` | **YES** |
| GET Bearer / JSON / Origin | yes | yes | **YES** |
| Token cache | yes (`env\|origin\|scope`) | yes (`publicKey\|origin\|scope`) | **YES** (keying differs; not a 401 cause) |
| Credential **values** | Edge `MOOV_*` | AWS secret hash `b4dd6a5880e7` / `ed250849c09a` | **NO** (AWS pair does not mint; Lovable did) |

**Every HTTP header/body field MATCHES.** The only identified non-match that can produce OAuth 401 is the **credential values**.

---

## 7. Supabase/Lovable secret **names** (from working code)

Referenced by working code:

- `MOOV_PUBLIC_KEY`, `MOOV_SECRET_KEY`
- `MOOV_SANDBOX_PUBLIC_KEY`, `MOOV_SANDBOX_SECRET_KEY`
- `MOOV_ENVIRONMENT` (default if tenant env unset; internal disburse uses this)
- `MOOV_ALLOWED_ORIGIN`, `MOOV_SANDBOX_ALLOWED_ORIGIN`, `CHECKSOPS_APP_URL`
- `MOOV_PLATFORM_ACCOUNT_ID`, `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID`
- `MOOV_WEBHOOK_SECRET`
- `MOOV_API_VERSION`
- `MOOV_ENABLED`
- `MOOV_PLATFORM_PAYMENT_METHOD_ID`, `MOOV_FEE_PLAN_ID`, `MOOV_FEE_PLAN_CODES`

**Not** used by working Moov client: `MOOV_CLIENT_ID`, `MOOV_CLIENT_SECRET` (`.env.aws.example` only). `MOOV_ACCOUNT_ID` is **not** referenced under `supabase/`.

Live Edge secret store: **not listed** from this agent. AWS production secret currently has only four Moov names: `MOOV_PUBLIC_KEY`, `MOOV_SECRET_KEY`, `MOOV_ENVIRONMENT`, `MOOV_ALLOWED_ORIGIN`.

---

## 8. Historical proof Lovable talked to Moov

RDS copy of production (read-only). No transfer was created in this phase.

Freedom **production** (Moov payload `mode=production`):

- `account.created`, `payment_account.created`, `payment_account.onboarding_link_generated`
- `payment_account.status_changed` → `active`
- `capability.requested` / `capability.updated` (`send-funds` / `transfers` / `wallet` enabled)
- `recipient.created`, `recipient.terms.accepted`, `recipient.bank_account.connected`
- `sweep_config.created`
- `verification_document.submitted`
- operating wallet row **active**

C1C **production** (`mode=production`): ToS, verified, `send-funds:enabled`, `last_synced_at` `2026-09-02`.

Production Moov transfer ids (webhook `transfer.created`, `tenant_id` null in this copy): `8a23259b…c0da`, `dacaf768…fb78`. `payment_transfers` currently **0 rows** in this copy (events retained the ids).

Freedom **recipients:** 4 Moov rows — 3 production + 1 sandbox — all `onboarding_status=awaiting_bank` (payee bank not complete; does not contradict sender-account success).

Freedom also has **older sandbox** events (wallet funding, micro-deposits, invoices). That is prior Test Mode work on the same tenant, not the current Freedom connected account `60922058…de96`.

---

## 9. Why AWS OAuth returns 401

**Primary: A. AWS has different credentials** than the known-good Lovable production pair.

HTTP construction **matches** the working client. Origin `https://checksops.com` previously minted tokens for a *different* (Test Mode) pair and still 401s for the current pair after apex was registered. Working sandbox keys in this org are the same 16/32 **shape** and do mint tokens — so this is not “16-char keys are the wrong type.”

| Class | Verdict |
| --- | --- |
| **A different credentials** | **YES — primary.** AWS pair hash `b4dd6a5880e7` fails token mint; Lovable production pair created `mode=production` accounts. |
| B wrong type | **No** (sandbox working keys are also 16/32 Basic API keys) |
| C Basic construction | **No** (ASCII `btoa` ≡ `Buffer.from`) |
| D Origin | **Not the remaining 401** (same Origin minted Test Mode tokens; domain add did not change empty 401) |
| E scope | **No** |
| F API version/header | **No** (OAuth has no version header in either client) |
| G wrong application | **Possible consequence of A**, not proven by JWT (no token on current pair) |
| H Lovable is Test Mode | **No** for Freedom’s working account (`mode=production`) |
| I different auth flow | **No** for server GETs/POSTs (OAuth). Webhook is HMAC, unused by AWS readiness. |
| J other | **No** additional HTTP-layer difference identified |
| K unknown | **No** for the HTTP layer. Lovable **values** remain unread, so the human must copy the Edge pair to prove A by minting. |

---

## 10. Smallest migration fix (DO NOT EXECUTE)

| Kind | Required? |
| --- | --- |
| **SECRET CHANGE** | **Yes.** Copy **exact** live Lovable/Supabase Edge `MOOV_PUBLIC_KEY` and `MOOV_SECRET_KEY` (character-for-character; do not retype) into `checksops/production/provider`. Keep `MOOV_ENVIRONMENT=production`. |
| CODE CHANGE | **No** for OAuth/GET headers |
| CONFIG CHANGE | **No** (money flags stay false) |
| MOOV DASHBOARD | Apex `https://checksops.com` already requested; keep. Do not point AWS Origin at staging. |
| DATABASE ACCOUNT-ID | **No** — keep Freedom `60922058…de96` |
| Add `MOOV_PLATFORM_ACCOUNT_ID` | **Not for this 401.** Required later to **execute** transfers (Lovable facilitator). Do not add yet. |

Then retry **one** OAuth. If not 200, STOP. If 200, one Freedom `GET /accounts/{60922058…de96}`.

**GO/NO-GO for applying that secret copy:** **GO** (secret-only, then one OAuth). **NO-GO** for money execution / SQL 72.

---

## 11. Safety (this pass)

| Flag / hold | Value |
| --- | --- |
| `AWS_PROVIDER_LIVE_READS_ENABLED` | **true** |
| `AWS_MOOV_ENABLED` | **false** |
| `AWS_PROVIDER_EXECUTION_ENABLED` | **false** |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | **false** |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | **false** |
| SQL 72 | **NOT_APPLIED** (`provider_http_attempted_at` does not exist) |
| Money routes | `403 production_execution_blocked`, `liveProviderCalled=false` |
| Moov mutations / transfer create / Moov HTTP | **none this forensic pass** |
| Money movement | **zero** |
| Lovable | unchanged (`productionSupabaseChanged=false`) |
| Webhooks | unchanged (`productionWebhooksRedirected=false`) |
| Lambda last modified | `2026-09-10T01:24:16Z` (description-only cachebust from M3b.1; **not** changed this pass) |

---

## 12. STOP FOR REVIEW

1. Lovable auth: OAuth `client_credentials` + Basic(`MOOV_PUBLIC_KEY:MOOV_SECRET_KEY`) + Origin + Bearer GET, host `api.moov.io`, pin `v2024.01.00`. Webhook is HMAC only.
2. Lovable Freedom working account: **Production/Live** — Moov payload **`mode=production`**, not Test Mode. Same tenant also has older sandbox events.
3. Freedom connected account `60922058…de96` is the Lovable production account. Facilitator is Edge `MOOV_PLATFORM_ACCOUNT_ID` (not in AWS GET secret). Sandbox platform `36b79957…47bb` is **not** that facilitator.
4. Working names: `MOOV_PUBLIC_KEY` / `MOOV_SECRET_KEY`. Edge values not readable here.
5. HTTP table: **all MATCH** except credential values.
6. AWS 16/32 vs sandbox 16/32 same type, **different hashes**; Lovable values unknown.
7. Historical: Freedom/C1C `mode=production` payloads, ToS, KYC verified, wallet, capabilities, production Moov transfer ids.
8. AWS 401: **A — different credentials**.
9. Smallest fix: copy Lovable Edge production key pair into AWS secret. No code change.
10. **GO** to apply that secret copy and retry one OAuth. **NO-GO** for money / SQL 72.

**STOP FOR REVIEW.** Do not modify anything. Do not enable money execution. Do not apply SQL 72. Do not move money.
