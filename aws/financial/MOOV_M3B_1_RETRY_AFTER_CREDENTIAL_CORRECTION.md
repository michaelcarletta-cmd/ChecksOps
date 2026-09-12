# Moov production readiness — M3b.1 retry after credential correction

**Status:** STOP FOR REVIEW. **NO-GO** for money execution. Account GET did **not** succeed. Inventory fields were **not** live-read. No remediation.

**Date:** 2026-09-10  
**Branch:** `cursor/moov-production-readiness-m3b-1-a508`  
**Lambda:** `checksops-production-prep-api`  
**Lambda code SHA-256:** `neeseSZmQhQf95bLUq7w9GTMMO0r8k3Ms2250pi65Zc=` (unchanged)

Secret values and access tokens are not printed. Ids are fingerprints only.

---

## Verdict

| Question | Result |
| --- | --- |
| Secret version changed? | **Yes.** AWSCURRENT created `2026-09-10T00:56:19Z` (was `2026-09-09T23:01:28Z`) |
| Read-contract names configured? | **Yes** — all four |
| JWT belongs to production/live application? | **No — no access token was issued** |
| Account GET HTTP | **not sent.** `POST /oauth2/token` returned **401** (empty body). Handler surfaces that as GET 401 `Could not authenticate with the payment provider` |
| Freedom sender readiness | **BLOCKED** (`live_account_get_failed`, `send_funds_ach_unknown`, `wallet_missing`, `bank_missing`) |
| Recipient readiness | **RECIPIENT_NOT_CONFIRMED** (RDS: 4 Moov rows, all `awaiting_bank`) |
| Production resource GET count | **0** (token mint failed before resource GET) |
| Production money POST count | **0** |
| OAuth token POST count | **6** (one per readiness probe; all 401) |
| Money flags | live-reads true; four money flags **false** |
| SQL 72 | **NOT_APPLIED** |
| Money movement | **zero** |

Compared with the prior Test Mode pair: those keys **minted** a token (OAuth 200) then resource GETs 401’d. The new pair **fails OAuth**. Lambda is using the new secret (behavior changed; version timestamp is new).

---

## 1. Secret version and read contract

Secret: `checksops/production/provider` (ARN suffix `provider-At4ZFR`).

| Item | Value |
| --- | --- |
| AWSCURRENT created | **2026-09-10T00:56:19.734Z** |
| AWSPREVIOUS created | `2026-09-09T23:01:28.208Z` (the Test Mode pair that minted tokens) |
| Version id fingerprint | `03e09efd…9b97` |
| `MOOV_PUBLIC_KEY` | configured (length 16, mixed alnum, **not UUID-shaped**) |
| `MOOV_SECRET_KEY` | configured (length 32, alnum + `_`) |
| `MOOV_ENVIRONMENT` | `production` |
| `MOOV_ALLOWED_ORIGIN` | host `checksops.com`, stored length 22 (trailing slash); client still sends `https://checksops.com` |
| `MOOV_PLATFORM_ACCOUNT_ID` | still absent |
| `MOOV_WEBHOOK_SECRET` | still absent |
| `MOOV_SANDBOX_*` / `MOOV_ENVIRO` | not present |

Lambda `GET /providers/status`: all four `*_configured=true`.

Public key length **16** is not the UUID-shaped OAuth client id this adapter used when token mint succeeded. That is a format observation only; the live proof is OAuth **401** with `has_access_token=false`.

---

## 2. Flags

| Flag | Value |
| --- | --- |
| `AWS_PROVIDER_LIVE_READS_ENABLED` | **true** |
| `AWS_MOOV_ENABLED` | **false** |
| `AWS_PROVIDER_EXECUTION_ENABLED` | **false** |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | **false** |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | **false** |

---

## 3. Money routes

| Route | HTTP | error | `liveProviderCalled` |
| --- | --- | --- | --- |
| `moov-transfer-create` | 403 | `production_execution_blocked` | false |
| `moov-disburse` | 403 | `production_execution_blocked` | false |

Blocked before identity / RDS / provider HTTP.

---

## 4. One authorized account GET

`POST /functions/v1/moov-readiness` empty body. Server-derived Freedom `provider_account_id` present (`60922058…de96`).

| Step | Result |
| --- | --- |
| OAuth `POST /oauth2/token` | **401**, `token_type=null`, `has_access_token=false`, `response_keys=[]`, `content_type=null`, Origin `https://checksops.com`, Basic client auth |
| JWT | **none** — cannot compare `aid`/`caid`/`aud` to Test Mode `2a945f55…9e51` / `36b79957…47bb` |
| `GET /accounts/{Freedom}` | **not issued** |

Handler: `502 moov_account_get_failed`, `liveProviderCalled=true`, `productionExecution=false`, `created=false`, `mutated=false`.

---

## 5. GET-only inventory (not live-read)

Account GET did not succeed, so the approved inventory was **not** filled from Moov:

| Field | Live value |
| --- | --- |
| account state / type | **not read** |
| KYC / KYB | **not read** |
| ToS | **not read** (`accepted: null`) |
| requirements / action_required | **not read** (`present: false`) |
| capabilities | **not read** |
| wallet | **not read** |
| bank / payment method | **not read** |
| ACH send | **not read** |
| ACH collect | **not read** |
| `wallet.balance` | **not read** |
| same-day ACH | **not read** |

**Sender:** BLOCKED.  
**Recipient (RDS only):** 4 Moov rows (3 production, 1 sandbox), all `awaiting_bank` → **RECIPIENT_NOT_CONFIRMED**. C1C was not used.

---

## 6. Safety

| Check | Result |
| --- | --- |
| Money flags | live-reads true; four money flags false |
| SQL 72 | **NOT_APPLIED** (`provider_http_attempted_at` does not exist) |
| Moov mutations | none |
| Lovable | unchanged (`productionSupabaseChanged=false`) |
| Webhook | unchanged (`productionWebhooksRedirected=false`) |
| Code / Origin / SQL / money flags | **not changed** this pass |

---

## STOP FOR REVIEW

Do not enable money execution. Do not apply SQL 72. Do not modify Moov.

Smallest next human action (not executed here): confirm the values in `MOOV_PUBLIC_KEY` / `MOOV_SECRET_KEY` are the Moov Dashboard **production application API key** pair (OAuth client id / secret), then retry **one** GET-only readiness. Do not add `MOOV_PLATFORM_ACCOUNT_ID` yet. Do not change Lambda Origin to staging.
