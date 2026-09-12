# Moov M3b.7 — new production key OAuth validation

**Status:** STOP FOR REVIEW.  
**Date:** 2026-09-10  
**Branch:** `cursor/moov-production-readiness-m3b-7-a508`

No secret values, Basic headers, or access tokens are printed.

---

## Secret metadata (AWSCURRENT)

Secret: `checksops/production/provider`  
Version: `99f01662-2eb6-4668-bee8-f88a058f6d00`  
Last changed: `2026-09-10T10:31:10Z`

| Name | Present | Notes |
| --- | --- | --- |
| `MOOV_PUBLIC_KEY` | **yes** | length 16, not UUID, sha256-12 `3ad0839428e5` (changed vs prior `b4dd6a5880e7`) |
| `MOOV_SECRET_KEY` | **yes** | length 32, sha256-12 `d37911db8a31` (changed vs prior `ed250849c09a`) |
| `MOOV_ENVIRONMENT` | **production** | unchanged |
| `MOOV_ALLOWED_ORIGIN` | host `checksops.com`, length 21, no trailing slash | **resolves to `https://checksops.com`** |

`MOOV_PLATFORM_ACCOUNT_ID` was **not** added. CheckAlt names are also present in this secret JSON (not used by this probe).

---

## Lambda loaded the new version

In-process secret cache is process-lifetime. Production-prep was overlaid with `account_get_only` (`CodeSha256` `kaXYWfVpljY4Chk1Ytcp1U9vORm1bzSuDqvpGGw/Z2I=`, last modified `2026-09-10T10:33:01Z`) **without** sending the Environment blob. That recycle is after the secret write (`10:31:10Z`). OAuth `cache_hit=false`.

**NEW SECRET VERSION LOADED: YES**

---

## Flags (unchanged)

| Flag | Value |
| --- | --- |
| `AWS_PROVIDER_LIVE_READS_ENABLED` | **true** |
| `AWS_MOOV_ENABLED` | **false** |
| `AWS_PROVIDER_EXECUTION_ENABLED` | **false** |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | **false** |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | **false** |

SQL 72: **NOT_APPLIED**

---

## OAuth — PASS

One `POST https://api.moov.io/oauth2/token` via the existing production client.

| Field | Result |
| --- | --- |
| HTTP | **200** |
| `has_access_token` | **true** |
| token_type | Bearer |
| Origin sent | `https://checksops.com` |
| scope | `/accounts/{id}/profile.read` |
| `aid` | `694a303b…3878` |
| `caid` | `41cb5d67…2208` (not Test Mode `36b79957…47bb`, not Freedom connected id) |
| `aud` | includes **`https://checksops.com`**, `https://api.moov.io`, `https://cards.moov.io`, `https://api.moov.money` |
| `iss` | `https://api.moov.io#applications` |

---

## Freedom account GET — PASS

One `GET /accounts/{server-derived Freedom id}` with `profile.read`. Extra Moov GETs skipped (`account_get_only`).

| Field | Result |
| --- | --- |
| HTTP | **200** |
| account id | `60922058…de96` — matches expected Freedom id |
| display name | Freedom Adjustment LLC |
| **mode** | **production** |
| verification | verified |

**PRODUCTION ACCOUNT CONFIRMED: YES**

---

## Side effects

| Check | Result |
| --- | --- |
| Transfer POST | **0** (`403 production_execution_blocked`) |
| Wallet / bank / account mutation | **0** |
| Extra Moov GETs | **0** |
| Webhooks | unchanged |
| `payment_transfers` | not mutated; SQL 72 **NOT_APPLIED** |
| Money flags | unchanged |
| Money moved | **$0.00** |
| Lovable | unchanged |

---

## Returns

| Item | Result |
| --- | --- |
| OAUTH | **PASS** |
| FREEDOM ACCOUNT GET | **PASS** |
| PRODUCTION ACCOUNT CONFIRMED | **YES** |
| NEW SECRET VERSION LOADED | **YES** |
| MONEY FLAGS | unchanged |
| SQL72 | **NOT_APPLIED** |
| PROVIDER MUTATIONS | **0** |
| MONEY MOVED | **$0.00** |

**STOP FOR REVIEW.** Do not proceed to capabilities/wallet/bank reads. Do not add `MOOV_PLATFORM_ACCOUNT_ID`. Do not enable Moov execution. Do not apply SQL 72. Do not move money.
