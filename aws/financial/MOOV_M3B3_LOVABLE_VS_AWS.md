# Moov M3b.3 — forensic compare Lovable/Supabase (known-good) vs AWS

**Status:** STOP FOR REVIEW. Read-only. **No remediation executed.**  
**Date:** 2026-09-10  
**Branch:** `cursor/moov-production-readiness-m3b-1-a508`

No secret values or access tokens are printed. Ids are fingerprints (`first8…last4`).

This agent could **not** list live Supabase Edge secret **values** (no `supabase` CLI / management token). Comparison of Lovable credential **values** is therefore by name + code + RDS history, plus AWS Secrets Manager **metadata** only.

---

## 1. Working Lovable Moov inventory

All server Moov HTTP goes through `supabase/functions/_shared/moovClient.ts` (`moovToken` → `POST /oauth2/token`, then `moovFetch` Bearer).

| Area | Modules / functions |
| --- | --- |
| OAuth / token | `moovClient.ts` `moovToken()` |
| Account reads / sync | `moov-readiness`, `moov-sync`, `moov-selftest` |
| Account create / onboard | `moov-account-create`, `moov-account-onboard`, `moov-onboarding-link`, `moov-account-discover` |
| ToS | `moov-tos-token`, `moov-tos-accept`, `moov-recipient-tos-accept` |
| Capabilities | `moov-sync`, `moov-underwriting`, `moov-readiness` |
| Banks | `moov-bank-link-token`, `moov-bank-account-add`, `moov-micro-deposit-*` |
| Wallets | `moov-wallet-sync`, `moov-wallet-fund`, `_shared/moovWallet.ts` |
| Transfer create | `moov-transfer-create` → `POST /accounts/{facilitator}/transfers` |
| Disburse | `moov-disburse` (same `moovFetch`; internal path can skip `MOOV_ENABLED`) |
| Recipients / payees | `moov-recipient-create`, `moov-recipient-session`, `moov-recipient-kyc-update`, `moov-recipient-bank-add` |
| Webhook | `moov-webhook` (HMAC; `MOOV_WEBHOOK_SECRET`; **no OAuth**) |
| Browser SPA | `src/lib/payments/providers/moovProvider.ts` invokes Edge functions only — **no Moov credentials in the browser except the public_key field returned for Drops** |

Known-good auth path: `requireMoovCaller` → `bindMoovEnvironment(tenant.moov_environment)` → `credentialsFor(env)` → `moovToken` → `moovFetch`.

---

## 2. Working Lovable auth contract (no values)

| Item | Working Lovable |
| --- | --- |
| Base URL | `https://api.moov.io` (sandbox **and** production; host is not the environment switch) |
| Token URL | `POST https://api.moov.io/oauth2/token` |
| Auth | `Authorization: Basic base64(publicKey:secretKey)` via Deno `btoa` |
| Grant | `client_credentials` |
| Body | `application/x-www-form-urlencoded` `grant_type` + `scope` |
| Production public name | `MOOV_PUBLIC_KEY` |
| Production secret name | `MOOV_SECRET_KEY` |
| Sandbox pair | `MOOV_SANDBOX_PUBLIC_KEY` / `MOOV_SANDBOX_SECRET_KEY` |
| Origin | `moovOrigin()`: sandbox uses `MOOV_SANDBOX_ALLOWED_ORIGIN`; else `MOOV_ALLOWED_ORIGIN` \|\| `CHECKSOPS_APP_URL` \|\| `https://checksops.com` (scheme+host, no path) |
| Scopes | per-call; readiness account GET uses `/accounts/{id}/profile.read` |
| API version on GET | `x-moov-version`: `MOOV_API_VERSION` or **`v2024.01.00`** |
| GET headers | `Authorization: Bearer`, `Content-Type: application/json`, `Accept: application/json`, `Origin`, `x-moov-version`; optional `X-Idempotency-Key`, `X-Account-ID` |
| Token cache | yes, per `environment\|origin\|scope` |
| Webhook | HMAC, not OAuth |
| Browser Drop | OAuth token minted server-side; response also includes `public_key: MOOV_PUBLIC_KEY` |

---

## 3. Whether Lovable is Test or Production

**Mixture by tenant. Freedom is Production/Live, not Test Mode.**

Not inferred from variable names:

| Evidence | Result |
| --- | --- |
| Host | always `api.moov.io` (cannot distinguish Test vs Live) |
| Freedom `tenants.moov_environment` | **`production`** (`moov_allowlisted=true`) |
| Freedom `payment_provider_accounts.environment` | **`production`**, `provider_account_id` `60922058…de96`, onboarding `active`, verification `verified`, ToS `2026-08-28`, `last_synced_at` `2026-08-28T19:28:21Z` |
| Freedom wallet | production operating wallet **active**, same account id |
| `payment_event_log` (latest 50 Moov rows) | **46 production / 4 sandbox**; production includes `transfer.created` / `transfer.updated` with provider transfer ids `8a23259b…c0da`, `dacaf768…fb78` |
| Sandbox events | wallet funding / failed disbursement on the pipeline-test tenant |

JWT `aid`/`caid` from live Lovable was **not** obtainable (cannot invoke Edge without a Supabase user JWT; do not mint from AWS).

---

## 4. Working application / account relationship

| Role | Fingerprint | Source |
| --- | --- | --- |
| Freedom connected account (Lovable + AWS RDS) | **`60922058…de96`** | `payment_provider_accounts.provider_account_id` |
| RDS row PK (not sent to Moov) | `26c2dbb1…4005` | same row |
| C1C production connected account | `817e1bf0…1708` | same table |
| Lovable facilitator | `MOOV_PLATFORM_ACCOUNT_ID` (env) | **absent from AWS production secret**; used for `POST /accounts/{facilitator}/transfers` |
| AWS sandbox platform (not Lovable prod) | `36b79957…47bb` | staging `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID`; Test Mode |

Freedom’s stored id **is** the Lovable production connected account. AWS readiness already uses that same id. **No database account-id change** is indicated.

---

## 5–6. Credential metadata and HTTP comparison

### Credential metadata (no values)

| | Lovable working (code + inaccessible Edge store) | AWS `checksops/production/provider` | Working AWS **sandbox** (`checksops/staging/providers`) |
| --- | --- | --- | --- |
| Public name | `MOOV_PUBLIC_KEY` | `MOOV_PUBLIC_KEY` | `MOOV_SANDBOX_PUBLIC_KEY` |
| Public length | **unknown here** (Edge secrets not readable) | **16**, not UUID, sha256-12 `b4dd6a5880e7` | **16**, not UUID, sha256-12 `2e3da5f53f6b` |
| Secret name | `MOOV_SECRET_KEY` | `MOOV_SECRET_KEY` | `MOOV_SANDBOX_SECRET_KEY` |
| Secret length | unknown | **32**, sha256-12 `ed250849c09a` | **32**, sha256-12 `e206c705e65f` |

Known-good **OAuth in this org** (sandbox certification) uses the **same 16/32 length class**. AWS production is therefore **not a wrong credential type vs sandbox**. Hashes **differ** from sandbox (not a copy of Test Mode keys). Lovable production **values** were not readable, so they are **not proven equal** to the AWS pair.

When AWS previously held the Test Mode pair, OAuth was **200**. After human replacement with the current 16/32 pair, OAuth is **401**. That pair is not the pair that minted tokens.

### HTTP: Lovable working vs AWS current

| FIELD | LOVABLE WORKING | AWS CURRENT | MATCH? |
| --- | --- | --- | --- |
| URL | `https://api.moov.io/oauth2/token` | `https://api.moov.io/oauth2/token` | **YES** |
| Method | POST | POST | **YES** |
| Basic construction | `btoa(key:secret)` | `Buffer.from(key:secret).toString('base64')` | **YES** (ASCII) |
| Origin | `moovOrigin()` default `https://checksops.com` | hardcoded `https://checksops.com` | **YES** (value) |
| grant_type | `client_credentials` | `client_credentials` | **YES** |
| Readiness scope | `/accounts/{id}/profile.read` | `/accounts/{id}/profile.read` | **YES** |
| Token Content-Type | `application/x-www-form-urlencoded` | same | **YES** |
| Token Accept | omitted | omitted | **YES** |
| GET x-moov-version | `v2024.01.00` | `v2024.01.00` | **YES** |
| GET Bearer / JSON / Origin | yes | yes | **YES** |
| Token cache | yes | yes | **YES** (keying differs: env vs publicKey) |
| Credential **values** | Edge `MOOV_*` | AWS secret | **NO** (AWS pair does not mint; Lovable did) |

---

## 7. Supabase/Lovable secret **names** (from working code)

Referenced: `MOOV_PUBLIC_KEY`, `MOOV_SECRET_KEY`, `MOOV_SANDBOX_PUBLIC_KEY`, `MOOV_SANDBOX_SECRET_KEY`, `MOOV_ENVIRONMENT`, `MOOV_ALLOWED_ORIGIN`, `MOOV_SANDBOX_ALLOWED_ORIGIN`, `CHECKSOPS_APP_URL`, `MOOV_PLATFORM_ACCOUNT_ID`, `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID`, `MOOV_WEBHOOK_SECRET`, `MOOV_API_VERSION`, `MOOV_ENABLED`, `MOOV_PLATFORM_PAYMENT_METHOD_ID`, `MOOV_FEE_PLAN_ID`, `MOOV_FEE_PLAN_CODES`.

**Not** used by working Moov client: `MOOV_CLIENT_ID`, `MOOV_CLIENT_SECRET` (those appear only in `.env.aws.example`). `MOOV_ACCOUNT_ID` is **not** the facilitator.

Live Edge secret store: **not listed** from this agent.

---

## 8. Historical proof Lovable talked to Moov

RDS copy of production (read-only):

- Freedom production account created/synced: ToS, verified, `last_synced_at`, operating wallet
- C1C production account similarly verified (`last_synced_at` `2026-09-02`)
- Event log: `account.created`, `payment_account.terms_accepted`, `capability.updated` / `requested`, `bankAccount.created`, **production** `transfer.created` + `transfer.updated` with Moov transfer ids
- `payment_transfers` table currently **0 rows** in this copy (events retained transfer ids even if the transfer table is empty here)

No transfer was created in this phase.

---

## 9. Why AWS OAuth returns 401

**Primary: A. AWS has different credentials** than the known-good Lovable production pair.

HTTP construction **matches** the working client. Origin `https://checksops.com` previously minted tokens for a *different* (Test Mode) pair and still 401s for the current pair after apex was registered on the dashboard. Working sandbox keys in this org are the same 16/32 **shape** and do mint tokens — so this is not “16-char keys are the wrong type.”

| Class | Verdict |
| --- | --- |
| A different credentials | **YES — primary** |
| B wrong type | **No** (sandbox working keys are also 16/32) |
| C Basic construction | **No** (ASCII match) |
| D Origin | **Not the remaining 401** (same Origin minted Test Mode tokens; domain add did not change empty 401) |
| E scope | **No** |
| F API version/header | **No** (OAuth has no version header in either client) |
| G wrong application | **Possible consequence of A**, not proven by JWT (no token) |
| H Lovable is Test Mode | **No** for Freedom (production tenant + production events) |
| I different auth flow | **No** for server GETs/POSTs |
| K unknown | **No** for the HTTP layer |

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

Then retry **one** OAuth. If 200, one Freedom account GET.

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
| SQL 72 | **NOT_APPLIED** |
| Money routes | `403 production_execution_blocked`, `liveProviderCalled=false` |
| Moov mutations / transfer create | **none** (no Moov HTTP this forensic pass) |
| Money movement | **zero** |
| Lovable | unchanged |
| Webhooks | unchanged |

---

## 12. STOP FOR REVIEW

1. Lovable auth: OAuth client_credentials + Basic + Origin + Bearer GET, host `api.moov.io`, pin `v2024.01.00`.  
2. Lovable Freedom: **Production/Live** (tenant + RDS + production transfer events). Pipeline-test tenant is sandbox.  
3. Freedom connected account `60922058…de96` is the Lovable account. Facilitator is env `MOOV_PLATFORM_ACCOUNT_ID` (not in AWS GET secret).  
4. Working names: `MOOV_PUBLIC_KEY` / `MOOV_SECRET_KEY` (plus sandbox-prefixed set). Edge values not readable here.  
5. HTTP table: **all MATCH** except credential values.  
6. AWS 16/32 vs sandbox 16/32 same shape, **different hashes**; Lovable values unknown.  
7. Historical: ToS, KYC verified, wallet, capability events, production Moov transfer ids.  
8. AWS 401: **A — different credentials**.  
9. Smallest fix: copy Lovable Edge production key pair into AWS secret. No code change.  
10. **GO** to apply that secret copy and retry one OAuth. **NO-GO** for money / SQL 72.

**STOP FOR REVIEW.** Do not modify anything. Do not enable money execution. Do not apply SQL 72. Do not move money.
