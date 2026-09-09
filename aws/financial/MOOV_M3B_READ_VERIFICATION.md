# Moov production readiness — Phase M3b (resumed)

**DEPLOY READ-ONLY GATE + HUMAN-CONTROLLED PRODUCTION READ VERIFICATION**

**Status:** STOP FOR REVIEW. Production-prep is on M3.1. Live-reads is **true**. All money flags remain **false**. The human secret **exists** but is **READ-CONTRACT INCOMPLETE**. **No production Moov HTTP** (including no OAuth). SQL 72 still **NOT_APPLIED**.

**Date:** 2026-09-09  
**Branch:** `cursor/moov-production-readiness-m3b-a508`  
**Deployed code SHA:** `feb813af` / Lambda `CodeSha256` `nnTP3XZpEI+pfmKEAhgKI/s6nVNa9ZTCIGd9JGRSV94=`

This resume did **not** enable `AWS_MOOV_ENABLED`, `AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`, or `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED`. It did **not** create secret values, copy sandbox keys, apply SQL 72, move money, redirect webhooks, or change Lovable.

---

## 1. M3.1 deployment SHA / version

Unchanged from the first M3b deploy: git `feb813af`, function `checksops-production-prep-api`, `CodeSha256` `nnTP3XZpEI+pfmKEAhgKI/s6nVNa9ZTCIGd9JGRSV94=`.

Env changes this resume (only):

1. `PROVIDER_SECRETS_ARN` → `checksops/production/providers`
2. `AWS_PROVIDER_LIVE_READS_ENABLED=true`

A Secrets Manager **resource policy** was added so the production-prep Lambda role may `GetSecretValue` on this one secret. IAM `PutRolePolicy` on the execution role was denied and was **not** used.

---

## 2. production-prep Lambda code version / hash

Unchanged. `CodeSha256` `nnTP3XZpEI+pfmKEAhgKI/s6nVNa9ZTCIGd9JGRSV94=`.

---

## 3. Live-read flag state

`AWS_PROVIDER_LIVE_READS_ENABLED=true`

`/ops/readiness` still lists this as a generic cutover hold. That snapshot treats live-reads as a cutover flag. It is **not** a money-execution flag. Money holds remain false.

---

## 4. All money flag states

| Flag | Value |
| --- | --- |
| `AWS_MOOV_ENABLED` | **false** |
| `AWS_PROVIDER_EXECUTION_ENABLED` | **false** |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | **false** |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | **false** |

Verified after ARN connect, after live-reads, and after the readiness call.

---

## 5. Secret contract status — names / booleans only

Secret **exists**: `checksops/production/providers`.  
`PROVIDER_SECRETS_ARN` **configured**. No values printed.

| Name | configured |
| --- | --- |
| `MOOV_PUBLIC_KEY` | **true** |
| `MOOV_SECRET_KEY` | **false** |
| `MOOV_PLATFORM_ACCOUNT_ID` | false |
| `MOOV_WEBHOOK_SECRET` | false |
| `MOOV_ENVIRONMENT` | **false** |
| `MOOV_ALLOWED_ORIGIN` | **false** |

`MOOV_ENVIRONMENT_is_production`: false (name absent)  
`MOOV_ALLOWED_ORIGIN_approved`: false (name absent)  
Sandbox key names present: none  
Sandbox contamination: none  

**READ-CONTRACT COMPLETE:** no  
**FULL EXECUTION-CONTRACT COMPLETE:** no  

Missing for GET: `MOOV_SECRET_KEY`, `MOOV_ENVIRONMENT`, `MOOV_ALLOWED_ORIGIN`.

---

## 6–12. Freedom / Moov live GET fields

`POST /functions/v1/moov-readiness` as a production-prep Cognito user mapped to Freedom **admin**, **no** browser Moov account id.

Result: `503 production_secret_missing` (`reason=required_read_names_missing`).  
`liveProviderCalled=false`. Server **did** derive the Freedom production `payment_provider_accounts` row from RDS, then fail-closed **before** OAuth or any Moov GET.

Spoofed `moov_account_id` → `400 untrusted_provider_config`, no HTTP.

| Field | Live Moov |
| --- | --- |
| Account status / type | **not read** (blocked by incomplete secret) |
| KYC | **not read** |
| KYB | **not read** |
| ToS | **not read** |
| requirements / action_required | **not read** |
| wallet existence/status | **not read** |
| wallet balance | **not read** |
| bank / payment-method status | **not read** |
| send-funds.ach | **not read** |
| collect-funds.ach | **not read** |
| wallet.balance | **not read** |
| same-day ACH | **not read** |

RDS local cache (not live Moov): business, onboarding `active`, verification `verified`, `can_ach_credit=true`, `can_ach_debit=false`. Do not treat as sender truth.

---

## 13. Sender readiness verdict

**BLOCKED**

Moov did not report current capabilities or requirements. The read contract is incomplete, so GET cannot start.

---

## 14. Existing controlled recipient readiness

**RECIPIENT_NOT_CONFIRMED**

Freedom Moov `external_payment_recipients`: 4 rows, all `awaiting_bank` (3 production, 1 sandbox). None verified. C1C was not used. Nobody was onboarded.

---

## 15. Production GET count

**0**

---

## 16. Production POST count

**0** (no Moov resource POST, no OAuth `POST /oauth2/token`)

With live-reads on:

- `moov-transfer-create` → `403 production_execution_blocked`, `liveProviderCalled=false`
- `moov-disburse` → `403 production_execution_blocked`, `liveProviderCalled=false`

---

## 17. Financial / database mutations

**None.**

---

## 18. SQL 72 status

**NOT_APPLIED** — `column "provider_http_attempted_at" does not exist`.

---

## 19. Lovable status

**Unchanged.** Webhook unchanged. Staging sandbox flag still true on staging only; staging was not overlaid.

---

## 20. Remaining blockers before first controlled transfer

1. Human completes `checksops/production/providers` with at least:
   - `MOOV_PUBLIC_KEY` (already present)
   - `MOOV_SECRET_KEY`
   - `MOOV_ENVIRONMENT=production`
   - `MOOV_ALLOWED_ORIGIN=https://checksops.com`
2. Re-run Freedom `POST /functions/v1/moov-readiness` (live-reads already true; do not enable money flags).
3. Live GET must classify sender; do not remediate missing ToS/caps/banks.
4. A verified distinct Freedom recipient still does not exist.
5. SQL 72, Lovable neutralization, and money flags remain out of scope.

---

## 21. GO / NO-GO for the next phase

**NO-GO** for SQL 72, Lovable neutralization, or money execution.

**NO-GO** for treating Freedom as a live Moov sender until the read contract is complete and a GET returns Moov state.

**GO** only to retry this same GET after the missing secret **names** are filled (values never pasted into chat).

---

## Safety

Zero transfer/funding/recipient/capability/bank/ToS POSTs. Zero money movement. SQL 72 still not applied. Money flags still false. Lovable unchanged. Webhook unchanged.
