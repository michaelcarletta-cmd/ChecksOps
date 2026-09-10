# Moov production readiness — Phase M3b.1 (GET 401 diagnosis)

**Status:** STOP FOR REVIEW. **NO-GO** to retry the Freedom GET until the production secret holds production-application keys whose allowed Origin includes `https://checksops.com`.

**Date:** 2026-09-09  
**Branch:** `cursor/moov-production-readiness-m3b-1-a508`  
**Lambda code SHA-256:** `neeseSZmQhQf95bLUq7w9GTMMO0r8k3Ms2250pi65Zc=`

No secret values or access tokens are printed. Account ids are fingerprints only (`first8…last4`).

Money flags remain false. SQL 72 **NOT_APPLIED**. Zero money movement. No Moov mutations.

---

## Root-cause classification

**Primary: B. WRONG PRODUCTION CREDENTIALS**  
**Secondary: F. ORIGIN/DOMAIN RESTRICTION**  
**Also: C. WRONG PLATFORM/ACCOUNT RELATIONSHIP** (consequence of B)

Not A (Bearer header is correct).  
Not D (token was issued with the requested `/accounts/{id}/profile.read` scope).  
Not E as the primary cause (RDS `provider_account_id` is present and was used; these keys simply are not that account’s production application).  
Not G — Moov support is optional after dashboard key/origin correction; the JWT already explains the 401.

---

## 1. OAuth metadata (from production-prep Lambda)

Direct `api.moov.io` calls from this Cloud Agent VM are Cloudflare-blocked (403, not Moov). Diagnosis used the production-prep Lambda, which can reach Moov.

| Field | Value |
| --- | --- |
| HTTP | **200** |
| `token_type` | `Bearer` |
| `expires_in` (OAuth body) | `1789002024` (looks like a unix timestamp, not seconds; JWT remaining life is **3600s**) |
| `scope` returned | `/accounts/{id}/profile.read` (matches request) |
| audience (OAuth JSON) | not present |
| `has_access_token` | true |
| cache hit | false (fresh mint) |
| Origin on token POST | `https://checksops.com` |
| OAuth `Authorization` | `Basic` (public:secret) |
| OAuth headers | `Authorization`, `Content-Type`, `Origin` |

### JWT claims (no token printed)

| Claim | Value |
| --- | --- |
| looks like JWT | true (`eyJ…`, length 857, no leading/trailing whitespace) |
| `scp` | `/accounts/{id}/profile.read` |
| `iss` | `https://api.moov.io#applications` |
| `aud` | `https://staging.checksops.com`, `https://www.checksops.com`, `https://api.moov.io`, `https://cards.moov.io`, `https://api.moov.money` |
| `https://checksops.com` in `aud` | **false** |
| `aid` (application) | `2a945f55…9e51` |
| `caid` (token account/platform) | **`36b79957…47bb`** |
| Freedom `provider_account_id` | `60922058…de96` |
| `aid`/`caid` equals Freedom | **false** |

`36b79957…47bb` is the ChecksOps **Test Mode / sandbox platform** already documented in `aws/providers/MOOV_SANDBOX_CERTIFICATION.md` (`36b7…47bb`). The keys in `checksops/production/provider` minted a token for that sandbox application, not the production platform that owns Freedom.

---

## 2. Auth-header verification

Production client GET (unchanged; verified in code and live diagnosis):

| Header | Sent |
| --- | --- |
| `Authorization` | **`Bearer <access_token>`** — one space, no wrapping whitespace |
| `Content-Type` | `application/json` |
| `Accept` | `application/json` |
| `Origin` | `https://checksops.com` |
| `x-moov-version` | `v2024.01.00` |

No stale cache on this invoke (`cache_hit=false`). Sandbox token reuse via cache key is not possible as a mix-up of two key pairs in this secret: the secret contains only production-named names, and those values minted the sandbox-platform JWT above.

Stale/malformed token: **no**.

---

## 3. API version / headers vs Moov docs

| Item | Docs (`v2024.01.00` / current GET account) | Production client |
| --- | --- | --- |
| GET account scope | `/accounts/{accountID}/profile.read` | sent |
| GET `Authorization` | `Bearer {token}` | `Bearer` |
| `X-Moov-Version` | recommended; omit → default `v2024.01.00` | `x-moov-version: v2024.01.00` |
| GET example Origin | omitted on GET curl | **sent** `https://checksops.com` |
| GET `Content-Type` | omitted on GET curl | `application/json` (parity with existing Edge/AWS client) |
| Server-side SDK | Basic auth (username/password = keys) | OAuth Bearer (client-side token flow used server-side) |
| OAuth Origin | required; mismatch → **later calls 401** | sent; **not in token `aud`** |

`x-moov-version: v2024.01.00` is a valid, documented default. It does not explain 401 (malformed version would be 404). No account-specific version header exists.

---

## 4–5. Account / platform relationship

| Id | Fingerprint | Role |
| --- | --- | --- |
| RDS Freedom `provider_account_id` | `60922058…de96` | tenant connected account in `payment_provider_accounts` (`environment=production`, business, onboarding `active`) |
| Token `caid` | `36b79957…47bb` | **sandbox/test-mode platform** |
| Token `aid` | `2a945f55…9e51` | Moov application that owns these keys |
| `MOOV_PLATFORM_ACCOUNT_ID` in secret | **absent** | cannot confirm production facilitator from secret |

Freedom is **not** the platform account in this token. It is a **different** Moov account from the key’s `caid`. These credentials are not proven to own Freedom. Environment of the **keys** is Test Mode (sandbox platform id). RDS row says production — mismatch.

Without a production `MOOV_PLATFORM_ACCOUNT_ID`, production-platform identity cannot be proven from the secret. The JWT `caid` already proves these keys are the sandbox platform.

---

## 6. Origin

Moov docs: Origin on `POST /oauth2/token` and subsequent calls must match a domain registered on the API key (scheme + host, no path). Wrong Origin → **subsequent API calls 401**.

| Check | Result |
| --- | --- |
| Client Origin | `https://checksops.com` (no path; secret value has a trailing slash but the client sends the approved constant) |
| JWT `aud` includes apex | **no** |
| JWT `aud` includes staging | **yes** |
| OAuth still 200 with apex Origin | yes (token mint does not prove GET Origin) |
| GET 401 body | empty (`body_bytes=0`, no `WWW-Authenticate`) |

Server-to-server Basic is documented as not requiring Origin; OAuth tokens **do**. This client uses OAuth, so Origin is in play. The 401 is consistent with Origin not in the key’s domain list, **and** with using sandbox keys against a production account id.

Do not “fix” this by pointing production-prep at `https://staging.checksops.com`.

---

## 7. Scopes

| Expected for `GET /accounts/{id}` | Present |
| --- | --- |
| `/accounts/{accountID}/profile.read` | **yes** (requested and returned) |

Account read is authorized **for the application that minted the token** (sandbox platform `36b79957…47bb`). It is **not** shown to be authorized for Freedom `60922058…de96`. A different auth flow is not required; **different keys** (production application) are.

---

## 8. Smallest change to make `GET /accounts/{Freedom id}` succeed

**Dashboard / secret, not a Lambda header tweak:**

1. In Moov Dashboard (production mode), use the API key that belongs to the production platform that owns Freedom `60922058…de96`.
2. Register allowed domain **`https://checksops.com`** (no path, no trailing slash) on that key.
3. Put that key pair in `checksops/production/provider` as `MOOV_PUBLIC_KEY` / `MOOV_SECRET_KEY` (keep `MOOV_ENVIRONMENT=production`).
4. Then retry **one** `POST /functions/v1/moov-readiness` GET.

Do not change the production client Origin to staging. Do not enable money flags. Do not apply SQL 72.

---

## 9–10. GO / NO-GO and safety

| Question | Answer |
| --- | --- |
| Code change required to fix 401? | **No.** Bearer/Origin/version headers match the existing contract. Optional later: omit `Content-Type` on GET (docs omit it) — not the 401 cause. |
| Moov dashboard / support required? | **Yes** — replace Test Mode keys in the production secret; add `https://checksops.com` on the real production key. Support optional if dashboard is unavailable; attach GET `x-request-id` `896e6f70…70c7`. |
| Retry one GET now? | **NO-GO** |
| Retry after secret/origin correction? | **GO** (one GET-only readiness) |
| Money flags | live-reads true; four money flags **false** |
| Money routes | still `403 production_execution_blocked`, `liveProviderCalled=false` |
| SQL 72 | **NOT_APPLIED** |
| Money movement | **zero** |

Diagnosis instrumentation (OAuth/JWT metadata on readiness, no token) can remain for the next GET retry.
