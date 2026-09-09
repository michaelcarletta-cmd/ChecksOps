# Moov production readiness — Phase M3b (environment key recheck)

**Status:** STOP FOR REVIEW. AWSCURRENT on `checksops/production/provider` still does **not** contain the exact key `MOOV_ENVIRONMENT`. The live JSON still has `MOOV_ENVIRO`. **No production Moov HTTP.** Money flags remain false. Live-reads remains true. SQL 72 **NOT_APPLIED**.

**Date:** 2026-09-09  
**Branch:** `cursor/moov-production-readiness-m3b-a508`

There is a single secret version, created `2026-09-09T22:46:40Z`. Key-name lengths on AWSCURRENT: `MOOV_ENVIRO` = 11 characters (the contract key `MOOV_ENVIRONMENT` is 16). Lambda `/providers/status` still reports `MOOV_ENVIRONMENT_configured=false`.

---

## Read-contract names (no values)

| Name | configured |
| --- | --- |
| `MOOV_PUBLIC_KEY` | **true** |
| `MOOV_SECRET_KEY` | **true** |
| `MOOV_ALLOWED_ORIGIN` | **true** |
| `MOOV_ENVIRONMENT` | **false** |

`MOOV_ENVIRONMENT_is_production`: false (name absent).  
`MOOV_ENVIRO` is still present and equals production. The adapter does not accept that alias.

**READ-CONTRACT COMPLETE:** no  
Freedom Moov GET: **not performed**.

---

## Flags

| Flag | Value |
| --- | --- |
| `AWS_PROVIDER_LIVE_READS_ENABLED` | true |
| `AWS_MOOV_ENABLED` | false |
| `AWS_PROVIDER_EXECUTION_ENABLED` | false |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | false |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | false |

---

## Money routes

`moov-transfer-create` → `403 production_execution_blocked`  
`moov-disburse` → `403 production_execution_blocked`

---

## Freedom GET

`POST /functions/v1/moov-readiness` fail-closed: `503 production_secret_missing`, `missingNames: ["MOOV_ENVIRONMENT"]`, `liveProviderCalled=false`.

Live account/KYC/KYB/ToS/wallet/bank/capabilities: **not read**.  
**Sender:** **BLOCKED**  
**Recipient:** **RECIPIENT_NOT_CONFIRMED** (all `awaiting_bank`)

---

## Safety

GET 0. POST 0. SQL 72 NOT_APPLIED. Lovable unchanged. Webhook unchanged. Zero money movement.

---

## Next

In Secrets Manager, create a **new AWSCURRENT version** whose JSON key is exactly `MOOV_ENVIRONMENT` (not `MOOV_ENVIRO`), then retry this GET. Live-reads can stay true. Do not enable money flags.
