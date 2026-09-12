# Moov production readiness — M3b.1 retry after second public-key character correction

**Status:** STOP FOR REVIEW. **OAuth HTTP 401.** Resource GETs **not sent**. No remediation. **NO-GO** for the next Moov phase.

**Date:** 2026-09-10  
**Branch:** `cursor/moov-production-readiness-m3b-1-a508`

Secret values and access tokens are not printed.

---

## 1. Lambda vs new AWSCURRENT

| Item | Value |
| --- | --- |
| AWSCURRENT created | **2026-09-10T01:22:23.418Z** |
| AWSPREVIOUS created | `2026-09-10T01:10:55.509Z` |
| Version fingerprint | `e4d68c6b…5057` |
| Public-key sha256-12 | `b4dd6a5880e7` (changed from `a1044344f8bc`) |
| Public key length | 16 (still not UUID-shaped) |
| Secret key length | 32 |
| Lambda recycle | description-only `m3b1-awscurrent-cachebust-20260910T0123Z` — money flags **not** in the update |
| Flags after recycle | live-reads true; four money flags **false** |
| Read contract | all four names configured; `MOOV_ENVIRONMENT=production`; origin host `checksops.com` |

Cold start after recycle + OAuth **401** (Test Mode pair used to mint **200**) means Lambda used this AWSCURRENT pair.

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

## 3. OAuth — STOP (not 200)

`POST /oauth2/token` client_credentials, Basic, Origin `https://checksops.com`, scope `/accounts/{id}/profile.read`.

| Field | Value |
| --- | --- |
| HTTP | **401** |
| `has_access_token` | **false** |
| `token_type` / `expires_in` / `scope` / audience | null |
| `response_keys` | `[]` |
| `content_type` | null |
| cache_hit | false |
| JWT | **none** |

Resource GETs were **not** issued.

---

## Requested returns

| Item | Result |
| --- | --- |
| OAuth | **401**, empty body, no token |
| Production/live application | **cannot determine** (no JWT `aid`/`caid`) |
| Freedom account GET | **not sent** |
| Freedom sender readiness | **BLOCKED** (not live Moov truth) |
| Recipient readiness | **RECIPIENT_NOT_CONFIRMED** (RDS: 4 Moov rows, all `awaiting_bank`) |
| Remaining blockers | current key pair rejected at token mint |
| Next Moov phase | **NO-GO** |

---

## Safety

| Check | Result |
| --- | --- |
| `moov-transfer-create` | `403 production_execution_blocked`, `liveProviderCalled=false` |
| `moov-disburse` | `403 production_execution_blocked`, `liveProviderCalled=false` |
| Production money POST | **0** |
| Production resource GET | **0** |
| SQL 72 | **NOT_APPLIED** |
| Money movement | **zero** |
| Lovable | unchanged (`productionSupabaseChanged=false`) |
| Webhooks | unchanged (`productionWebhooksRedirected=false`) |

**STOP FOR REVIEW.** Do not enable money execution. Do not apply SQL 72. Do not move money.
