# S11 partial disbursement — production promotion

**Date:** 2026-09-25  
**Function:** `checksops-production-prep-api`  
**Method:** In-place `UpdateFunctionCode` overlay of the accepted S11 files onto the live production package. No SAM. No `UpdateFunctionConfiguration`. No SQL. No Supabase.

**S2/S3/S4/S5:** CLOSED, not reopened.  
**S14:** not started.

## Pre-deploy gate

Live production SHA was still the required baseline:

`4nRr0xh9SelxDuMAzNmgbbpWAaiWmPOgtiN14DkDXgM=`

Live `financial.mjs` and `financial-idempotency.mjs` (package mtime `2026-09-24 12:24:46`) differed from the accepted files **only** by the S11 remediations hunks. `financial-remaining.mjs` was absent from the live package. No newer production financial-path code would be overwritten.

## SHAs

| | Value |
| --- | --- |
| Production SHA before | `4nRr0xh9SelxDuMAzNmgbbpWAaiWmPOgtiN14DkDXgM=` |
| Production SHA after | `dplSPx8YJoYbkolr2c6mKersDAV7OCzHt5y3UyIOdoc=` |
| Last modified after | `2026-09-25T13:00:07.000+0000` |
| LastUpdateStatus | Successful |
| State | Active |

## Exact files promoted

Package vs rollback zip `/tmp/checksops-prod-s11-rollback-before.zip`:

- added `{financial-remaining.mjs}`
- changed `{financial.mjs, financial-idempotency.mjs}`
- removed `{}`

Every other live file remained byte-for-byte identical. Live copies of the three S11 files match the accepted repo files.

## Environment / config before / after

**None.** `Environment.Variables` (44 keys) identical. Role, runtime, memory, timeout, VPC, description, handler, and Cognito ids unchanged. `UpdateFunctionConfiguration` was not called.

| Flag | Before | After |
| --- | --- | --- |
| `AWS_MOOV_ENABLED` | true | true |
| `AWS_MOOV_TRANSFER_POST_ENABLED` | true | true |
| `AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED` | false | false |
| `AWS_CHECKALT_ENABLED` | true | true |
| `AWS_CHECKALT_STATUS_RECONCILE_ENABLED` | false | false |
| `AWS_PROVIDER_EXECUTION_ENABLED` | true | true |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | false | false |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | true | true |
| `AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED` | false | false |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | true | true |

Public `/prep/workflow/status` and `/prep/financial/status` flags match. `liveProviderTransactions` stayed `false`. `productionExecution` stayed `false`. `productionSupabaseChanged` stayed `false`.

`GET /prep/db-health`: `select1=ok`, `currentDatabase=checksops`, `transactionReadOnly=on`.

## Production code-path verification

Live package contains and imports `financial-remaining.mjs`. Present invariants:

- confirmed_in / confirmed_out / remaining / reserved available
- unsuccessful money-out statuses contribute $0
- remaining `max(0, in - out)`
- `requested_partial_cents` parsed server-side
- `rejectUntrustedAmountFields` still used
- sequence distinguisher `seq:N` in the money-out idempotency key
- `pg_advisory_xact_lock(hashtext(check_id))`
- `disbursement_splits` / `disbursement_batches` remain `FINANCIAL_OR_PROVIDER_TABLES`

Unauthenticated `/prep/data/write` of those tables and `/prep/financial/prepare` with `amount_cents` return `401 missing_cognito_token` and do not mutate a row. Behavioral remainder math remains the accepted staging run.

## CloudWatch

`/aws/lambda/checksops-production-prep-api` since `2026-09-25T13:00:07Z`:

- ERROR filter: 0 events
- Recent sample: INIT_START / START / END / REPORT only
- No `requested_partial` or provider-execution errors

## Safety

No real production check was modified. No Moov transfer, CheckAlt transaction, ACH, RTP, wire, wallet movement, or deposit was created.

Rollback zip retained at `/tmp/checksops-prod-s11-rollback-before.zip` (SHA `4nRr0xh9SelxDuMAzNmgbbpWAaiWmPOgtiN14DkDXgM=`).

## S11 PARTIAL DISBURSEMENT PRODUCTION PROMOTION: PASS
