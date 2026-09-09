# Moov production readiness — Phase M3b (singular secret)

**Status:** STOP FOR REVIEW. `PROVIDER_SECRETS_ARN` now points at **`checksops/production/provider`** (singular). Live-reads is true. Money flags remain false. The AWSCURRENT JSON is **missing the exact key `MOOV_ENVIRONMENT`** (a nearby key `MOOV_ENVIRO` is present). **No production Moov HTTP.** SQL 72 **NOT_APPLIED**.

**Date:** 2026-09-09  
**Branch:** `cursor/moov-production-readiness-m3b-a508`

This resume did **not** enable money flags, apply SQL 72, onboard anyone, request capabilities, modify Moov, neutralize Lovable, or redirect the webhook.

---

## Secret (names / booleans only)

| Item | Result |
| --- | --- |
| `checksops/production/provider` | **exists**, AWSCURRENT |
| ARN | `arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/provider-At4ZFR` |
| Old `checksops/production/providers` | **deleted** (not used) |
| `PROVIDER_SECRETS_ARN` | singular `provider` only |

| Name | configured |
| --- | --- |
| `MOOV_PUBLIC_KEY` | **true** |
| `MOOV_SECRET_KEY` | **true** |
| `MOOV_ENVIRONMENT` | **false** |
| `MOOV_ALLOWED_ORIGIN` | **true** (approved `https://checksops.com`) |

Unknown key present: `MOOV_ENVIRO` (value equals `production`; name is not the contract key).  
**READ-CONTRACT COMPLETE:** no  
**FULL EXECUTION-CONTRACT COMPLETE:** no  

No values printed. No sandbox names.

---

## Flags

| Flag | Value |
| --- | --- |
| `AWS_PROVIDER_LIVE_READS_ENABLED` | **true** |
| `AWS_MOOV_ENABLED` | **false** |
| `AWS_PROVIDER_EXECUTION_ENABLED` | **false** |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | **false** |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | **false** |

---

## Money routes

`moov-transfer-create` → `403 production_execution_blocked`, `liveProviderCalled=false`  
`moov-disburse` → `403 production_execution_blocked`, `liveProviderCalled=false`  
Provider POST count: **0**

---

## Freedom GET

**Not performed against Moov.** The four exact read-contract names were not all visible.

`POST /functions/v1/moov-readiness` (Freedom admin, no browser account id) fail-closed:

- `503 production_secret_missing`
- `missingNames: ["MOOV_ENVIRONMENT"]`
- `liveProviderCalled=false`
- Server derived Freedom production account from RDS, then stopped before OAuth/GET

Live Moov account/KYC/KYB/ToS/requirements/wallet/bank/capabilities: **not read**.

**Sender verdict:** **BLOCKED**

---

## Recipient

**RECIPIENT_NOT_CONFIRMED** — Freedom Moov recipients remain `awaiting_bank`. C1C unused. Nobody onboarded.

---

## Safety

Production GET **0**. Production POST **0**. SQL 72 **NOT_APPLIED**. Lovable unchanged. Webhook unchanged. Staging not overlaid.

---

## Remaining blocker

Rename `MOOV_ENVIRO` → **`MOOV_ENVIRONMENT`** (keep value `production`) in `checksops/production/provider`. Then retry the same GET. Do not enable money flags. Live-reads can stay true.

**GO/NO-GO:** **NO-GO** for SQL 72, Lovable neutralization, money execution, or live sender classification until `MOOV_ENVIRONMENT` is present and a GET returns Moov state.
