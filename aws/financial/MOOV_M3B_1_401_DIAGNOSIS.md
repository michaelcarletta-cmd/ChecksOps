# Moov production readiness — Phase M3b.1 (GET 401 diagnosis)

**Status:** STOP FOR REVIEW. **NO-GO** to retry the Freedom account GET until the production secret holds production-application keys whose allowed Origin includes `https://checksops.com`.

**Date:** 2026-09-10 (re-verified live)  
**Branch:** `cursor/moov-production-readiness-m3b-1-a508`  
**Lambda:** `checksops-production-prep-api`  
**Lambda code SHA-256:** `neeseSZmQhQf95bLUq7w9GTMMO0r8k3Ms2250pi65Zc=`

No secret values or access tokens are printed. Account ids are fingerprints only (`first8…last4`).

No code change in this diagnosis pass. No secret rotation. No Origin change. Money flags remain false. SQL 72 **NOT_APPLIED**. Zero money movement. No Moov mutations. Lovable unchanged. Webhook unchanged.

This Cloud Agent VM cannot call `api.moov.io` (Cloudflare 403). All OAuth/GET evidence is from production-prep Lambda, which can reach Moov.

---

## Root-cause classification (exactly one primary)

**Primary: C. WRONG PRODUCTION CREDENTIAL/APPLICATION**

The keys in `checksops/production/provider` mint a valid OAuth token for Moov application `aid` `2a945f55…9e51` whose token account/platform (`caid`) is **`36b79957…47bb`**. That `caid` is the ChecksOps **Test Mode / sandbox platform** already certified in `aws/providers/MOOV_SANDBOX_CERTIFICATION.md`. Freedom’s stored production Moov account is `60922058…de96`. These are not the same application/platform.

**Independently sufficient 401 mechanism: G. ORIGIN/DOMAIN RESTRICTION**

The token JWT `aud` includes `https://staging.checksops.com` and `https://www.checksops.com`, and does **not** include `https://checksops.com`. Resource GETs send `Origin: https://checksops.com`. Moov’s OAuth contract: Origin on the token request and later calls must match a domain registered on the API key; mismatch → later calls **401**. The GET 401 bodies are empty (`body_bytes=0`, no `WWW-Authenticate`, no error code). That matches Origin rejection, not a JSON resource error.

Do not “fix” G by sending `https://staging.checksops.com` from production-prep. Do not register the apex domain on this Test Mode key and keep using it as production.

**Related, not primary: D. WRONG PLATFORM/ACCOUNT RELATIONSHIP** — consequence of C. JWT `caid` ≠ Freedom `provider_account_id`. `MOOV_PLATFORM_ACCOUNT_ID` is **not required** to establish this; JWT `caid` already identifies the key’s platform. Do not add it yet.

**Not A.** Authorization is exactly `Bearer <access_token>` (one space, no wrapping whitespace, fresh mint `cache_hit=false`).

**Not B.** `x-moov-version: v2024.01.00` is the documented default. A bad version would 404, not empty 401.

**Not E.** Token `scp` / OAuth `scope` is `/accounts/{id}/profile.read` as requested. The application is not missing the account-read scope string.

**Not F as primary.** RDS has a production Freedom row; `provider_account_id` is present and was used. Empty 401 does not prove the stored id is stale. After C is corrected, one GET can confirm the id.

**Not H / I.** JWT `aid`/`caid`/`aud` already explain the 401. Moov Support is optional, not required, if Dashboard can issue the production application’s keys.

---

## 1. OAuth metadata (production-prep Lambda)

`POST https://api.moov.io/oauth2/token` (client_credentials). Fresh mint.

| Field | Value |
| --- | --- |
| HTTP | **200** |
| `token_type` | `Bearer` |
| `expires_in` (OAuth JSON) | `1789004460` (unix-timestamp shaped; JWT remaining life **3600s**) |
| `scope` returned | `/accounts/{id}/profile.read` (matches request) |
| audience (OAuth JSON) | not present (`response_keys`: `expires_in`, `scope`) |
| `has_access_token` | true |
| cache hit | false |
| Origin on token POST | `https://checksops.com` |
| OAuth `Authorization` | `Basic` (public:secret) |
| OAuth headers | `Authorization`, `Content-Type`, `Origin` |

### JWT claims (token never printed)

| Claim | Value |
| --- | --- |
| looks like JWT | true (`eyJ…`, length 857, no leading/trailing whitespace) |
| `scp` | `/accounts/{id}/profile.read` |
| `iss` | `https://api.moov.io#applications` |
| `aud` | `https://staging.checksops.com`, `https://www.checksops.com`, `https://api.moov.io`, `https://cards.moov.io`, `https://api.moov.money` |
| `https://checksops.com` in `aud` | **false** |
| `aid` (application) | `2a945f55…9e51` |
| `caid` (token account/platform) | **`36b79957…47bb`** (sandbox/test-mode platform) |
| Freedom `provider_account_id` | `60922058…de96` |
| `aid`/`caid` equals Freedom | **false** |

---

## 2. Authorization-header findings

Production GET (code + live diagnosis):

| Check | Result |
| --- | --- |
| Header | **`Authorization: Bearer <access_token>`** |
| Bearer prefix | correct, one space |
| Token | same minted JWT (`cache_hit=false`); not a second cached pair |
| Leading/trailing whitespace on token | false |
| Sandbox-named secret mix-up | production secret has no `MOOV_SANDBOX_*` names configured |
| Token replaced between OAuth and GET | no (same process, same mint) |

**Not A.**

---

## 3. API-header / version findings

| Item | Repo / Moov GET-account contract | Production client sent |
| --- | --- | --- |
| GET `Authorization` | `Bearer {token}` | `Bearer` |
| `X-Moov-Version` | recommended; omit → default `v2024.01.00` | `x-moov-version: v2024.01.00` |
| `Accept` | JSON | `application/json` |
| `Content-Type` | omitted on official GET curl | `application/json` (parity with existing client) |
| Origin on GET | omitted on official GET curl; **required** for this OAuth client-credentials flow | `https://checksops.com` |
| Server-side SDK | Basic auth | OAuth Bearer used server-side |

`v2024.01.00` is the pinned default in this repo. Missing/wrong version is **not** the 401 cause (**not B**). No extra Moov authorization header is missing relative to this client’s documented OAuth path.

---

## 4. Safe 401 response details

One controlled `GET /accounts/{server-derived Freedom account id}` (mutations: none):

| Field | Value |
| --- | --- |
| HTTP | **401** |
| Response error code | none (empty body) |
| Response error/message text | none (`provider_error` empty string; `body_keys=[]`) |
| `WWW-Authenticate` | **null** |
| `Content-Type` | null |
| Request / correlation id | `3c055c60…ac07` (this re-verify) |
| `body_bytes` | **0** |

Same empty 401 on capabilities, wallets, wallet, bank-accounts, payment-methods. Handler: `502 moov_account_get_failed`, `liveProviderCalled=true`, `productionExecution=false`, `created=false`, `mutated=false`.

---

## 5. Freedom account relationship

RDS `payment_provider_accounts` (Freedom tenant `2eff5f1a…f42a`, `environment=production`):

| Id | Fingerprint | Role |
| --- | --- | --- |
| RDS row `id` | `26c2dbb1…4005` | ChecksOps row PK (not sent to Moov) |
| `provider_account_id` | `60922058…de96` | value used in `GET /accounts/{id}` |
| Token `caid` | `36b79957…47bb` | Test Mode platform |
| Token `aid` | `2a945f55…9e51` | application that owns the current keys |

Could it be:

| Hypothesis | Evidence |
| --- | --- |
| Correct connected Freedom account | RDS says production, business, onboarding `active`, verification `verified`. Live Moov did **not** confirm (GET 401). |
| Platform account itself | **No** — `60922058…de96` ≠ `caid` `36b79957…47bb` |
| Stale account id | **Not proven.** Id is present and used. Empty 401 is not “not found”. |
| Sandbox account id | **Not proven from the UUID.** The **keys** are Test Mode; the RDS row is labeled production. |
| Account created under a different production application | **Consistent with C.** These keys’ application is Test Mode; Freedom’s production application is not this `aid`. |

---

## 6. Platform / application findings

Current production credentials belong to:

- Moov application `aid` `2a945f55…9e51`
- Platform / token account `caid` `36b79957…47bb` (ChecksOps Test Mode)

`MOOV_PLATFORM_ACCOUNT_ID` in the production secret: **absent** (`MOOV_PLATFORM_ACCOUNT_ID_configured=false`).

It is **not required** to diagnose this 401. JWT `caid` already identifies the key’s platform. Do **not** add `MOOV_PLATFORM_ACCOUNT_ID` yet. It remains required later for execution / facilitator GETs, and must be the production platform that owns Freedom — not `36b79957…47bb`.

---

## 7. Token scope findings

| Operation | Required (docs / this client) | Token |
| --- | --- | --- |
| `GET /accounts/{id}` | `/accounts/{accountID}/profile.read` | **present** (`scp` and OAuth `scope`) |
| capabilities / wallets / banks / payment-methods | account-scoped `*.read` minted per GET | OAuth 200 for profile.read; those GETs also 401 with empty body |

Account-read scope is **not missing**. The token is authorized for the **application that minted it** (Test Mode platform), not shown to be authorized for Freedom. **Not E.** Do not request/change scopes.

---

## 8. Origin findings

Origin **is relevant** because this server uses Moov’s OAuth client-credentials flow (Origin required). Official server-side Basic auth does not apply to this client.

| Check | Result |
| --- | --- |
| Client Origin sent | `https://checksops.com` (constant; no path) |
| Secret `MOOV_ALLOWED_ORIGIN` | host `checksops.com`; stored with a trailing slash; **normalized** before compare; header does **not** include the slash |
| Trailing slash on the Origin **header** | not sent |
| Would a trailing slash on the header change Moov auth? | possible in general (Origin is scheme+host, no path); **not the current bug** — header is already slash-free |
| JWT `aud` includes apex | **no** |
| JWT `aud` includes staging / www | **yes** |
| OAuth still 200 with apex Origin | yes (token mint does not prove GET Origin) |

Do not modify the configured origin in this phase.

---

## 9–10. Smallest corrective action (DO NOT EXECUTE)

**Dashboard + secret, not a Lambda header tweak.**

1. In Moov Dashboard **production mode**, use the API key for the production application that owns Freedom `60922058…de96`.
2. Register allowed domain **`https://checksops.com`** (scheme + host, no path, no trailing slash) on **that** key.
3. Put that pair in `checksops/production/provider` as `MOOV_PUBLIC_KEY` / `MOOV_SECRET_KEY` (keep `MOOV_ENVIRONMENT=production`).
4. Retry **one** GET-only `POST /functions/v1/moov-readiness`.

| Action type | Required? |
| --- | --- |
| AWS code change | **No** (Bearer / version / Origin constant already match the GET contract) |
| AWS secret / config change | **Yes** — replace the Test Mode key pair currently stored as production |
| Adding `MOOV_PLATFORM_ACCOUNT_ID` | **No, not yet** |
| Correcting Freedom `provider_account_id` | **Not as the first step**; re-evaluate only after the right keys return a non-401 |
| Moov Dashboard change | **Yes** — production application keys + apex Origin registration |
| Moov Support | **No** if Dashboard can issue those keys; optional attach GET `x-request-id` `3c055c60…ac07` |
| Rotate / change the **current** credential pair in place | **No** — that pair is the Test Mode application; replacement with the production application’s keys is the fix |
| Change Lambda Origin to staging | **No** |

---

## 11. Safety recheck (live, this pass)

| Flag / hold | Value |
| --- | --- |
| `AWS_PROVIDER_LIVE_READS_ENABLED` | **true** |
| `AWS_MOOV_ENABLED` | **false** |
| `AWS_PROVIDER_EXECUTION_ENABLED` | **false** |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | **false** |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | **false** |
| SQL 72 | **NOT_APPLIED** (`provider_http_attempted_at` does not exist) |
| `moov-transfer-create` | `403 production_execution_blocked`, `liveProviderCalled=false` |
| `moov-disburse` | `403 production_execution_blocked`, `liveProviderCalled=false` |
| Transfer POSTs | **zero** |
| Money movement | **zero** |
| Lovable / production Supabase | unchanged (`productionSupabaseChanged=false`) |
| Webhook | unchanged (`productionWebhooksRedirected=false`) |

Read-contract names still configured: `MOOV_PUBLIC_KEY`, `MOOV_SECRET_KEY`, `MOOV_ENVIRONMENT`, `MOOV_ALLOWED_ORIGIN`. `MOOV_PLATFORM_ACCOUNT_ID` and `MOOV_WEBHOOK_SECRET` remain absent.

---

## 12. STOP FOR REVIEW

| # | Item | Result |
| --- | --- | --- |
| 1 | OAuth metadata | HTTP **200**, `token_type=Bearer`, scope `/accounts/{id}/profile.read`, no OAuth audience, `expires_in` timestamp-shaped, JWT life 3600s |
| 2 | Authorization header | **Bearer**, correct, fresh, not stale/sandbox-named |
| 3 | API header / version | `x-moov-version: v2024.01.00`, Accept/Content-Type JSON, Origin apex; **not** the 401 cause |
| 4 | Safe 401 details | HTTP **401**, empty body, no error code, `WWW-Authenticate` null, request id `3c055c60…ac07` |
| 5 | Freedom account relationship | RDS production row present; GET uses `60922058…de96`; not the token platform |
| 6 | Platform / application | Keys are Test Mode `caid` `36b79957…47bb` / `aid` `2a945f55…9e51`. `MOOV_PLATFORM_ACCOUNT_ID` not required to diagnose; do not add yet |
| 7 | Token scopes | profile.read **present**; not a missing-scope bug |
| 8 | Origin | Relevant; apex **not** in JWT `aud`; trailing slash **not** on the sent header |
| 9 | Root cause | **C. WRONG PRODUCTION CREDENTIAL/APPLICATION** (G independently sufficient for empty 401) |
| 10 | Smallest corrective action | Moov Dashboard production keys + register `https://checksops.com`; write that pair into the production secret. No Lambda code change. Do not add platform id yet. |
| 11 | Moov Support required? | **No** (optional if Dashboard cannot issue the production application’s keys) |
| 12 | GO/NO-GO for correcting and retrying ONE account GET | **NO-GO** until C (and G on the **correct** application) are fixed |

**STOP FOR REVIEW.** Do not execute the fix. Do not enable money execution. Do not apply SQL 72. Do not move money.
