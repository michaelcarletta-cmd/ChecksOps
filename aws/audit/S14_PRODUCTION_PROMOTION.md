# S14 deposit payee_line protection — production promotion

**Date:** 2026-09-25  
**Function:** `checksops-production-prep-api`  
**Method:** In-place `UpdateFunctionCode` overlay of the accepted S14 files onto the live production package. No SAM. No `UpdateFunctionConfiguration`. No SQL. No Supabase.

**S2/S3/S4/S5/S11:** CLOSED / PRODUCTION PASS. Not reopened.  
**S14 staging acceptance:** PASS 15/15 (`jJs84yQMaFl0jv2wBloSeUql9bg1GzIn1WD1i3IsVvU=`).

## S2 503 preflight (continue)

The staging S14 regression encountered a 503 on the S2 identify re-sign / `mark_ready_for_deposit` path. Core S2 material-invalidation assertions still passed (invalidation, payee rename, pending endorsement, audit, amount lock, pre-deposit `payee_line` write 200).

Determination: **unrelated / transient / pre-existing. Not an S14 regression. Continue.**

Evidence:

- The 503 is on `POST /workflow/transition` (`workflow.mjs` → `withIdentity` catch → empty `data_query_failed`). `workflow.mjs` does not import `check-deposited.mjs` or the S14 writers.
- Accepted S14 files do not change endorsement eligibility, signature request, or ready-gate logic.
- Live and accepted `write-check-workflow.mjs` still contain `invalidateEndorsementsForMaterialPayeeChange`.
- On the same accepted staging SHA, S4 ready returned the accepted S2 gate: `403 endorsements_incomplete` / `required_payee_unsigned`.
- Empty 503 body matches the pre-existing `data.mjs` identity-query failure wrapper, not `payee_line_locked`.
- S5 already documented the same class of non-fatal `503 data_query_failed` on claims list.

S2 is not reopened or redesigned.

## Pre-deploy gate

Live production SHA was still the required baseline:

`dplSPx8YJoYbkolr2c6mKersDAV7OCzHt5y3UyIOdoc=`

LastModified `2026-09-25T13:00:07.000+0000`. LastUpdateStatus Successful. State Active.

| Check | Result |
| --- | --- |
| Live SHA exact | PASS |
| `check-deposited.mjs` absent from live package | PASS (new) |
| `write-check-workflow.mjs` / `ocr.mjs` / `ocr-descriptive-persist.mjs` vs accepted | S14-only hunks |
| Live `ingest-shared-check.mjs` has newer production tenant INSERT (`payment_provider`, `moov_allowlisted`, `moov_environment='production'`) | PASS — overlay is live file + S14 hunks only |
| Proposed package changes only the five accepted runtime files | PASS |
| `write-allowlist.mjs` untouched; `payee_line` remains in `INTAKE_SAFE_COLUMNS`, not in `INTAKE_PROHIBITED_COLUMNS` | PASS |
| No SQL / schema / IAM / VPC / Cognito / tenant / Moov / CheckAlt / flag change | PASS |

Rollback zip retained at `/tmp/checksops-prod-s14-rollback-before.zip`.

## SHAs

| | Value |
| --- | --- |
| Production SHA before | `dplSPx8YJoYbkolr2c6mKersDAV7OCzHt5y3UyIOdoc=` |
| Production SHA after | _pending deploy_ |
| Last modified after | _pending deploy_ |
| LastUpdateStatus | _pending deploy_ |
| State | Active |

## Exact files promoted

Package vs rollback zip `/tmp/checksops-prod-s14-rollback-before.zip` (preflight overlay `/tmp/checksops-prod-s14-overlay/updated.zip`):

- added `{check-deposited.mjs}`
- changed `{write-check-workflow.mjs, ocr.mjs, ocr-descriptive-persist.mjs, ingest-shared-check.mjs}`
- removed `{}`

`check-deposited.mjs`, `write-check-workflow.mjs`, `ocr.mjs`, and `ocr-descriptive-persist.mjs` match the accepted repo files byte-for-byte. `ingest-shared-check.mjs` is the live production file plus the S14 lock hunks; the production tenant INSERT is preserved.

Every other live file remains byte-for-byte identical (6460 → 6461 files).

## Environment / config before

44 keys. Role `checksops-production-api-execution`. Runtime `nodejs22.x`. Memory 1024. Timeout 45. Handler `index.handler`. VPC `vpc-09f2268778966ce97`. Cognito pool `us-east-1_h00WorYMT`. `UpdateFunctionConfiguration` will not be called.

| Flag | Before |
| --- | --- |
| `AWS_MOOV_ENABLED` | true |
| `AWS_MOOV_TRANSFER_POST_ENABLED` | true |
| `AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED` | false |
| `AWS_CHECKALT_ENABLED` | true |
| `AWS_CHECKALT_STATUS_RECONCILE_ENABLED` | false |
| `AWS_PROVIDER_EXECUTION_ENABLED` | true |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | false |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | true |
| `AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED` | false |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | true |

Public `/prep/financial/status`: `liveProviderTransactions=false`, `productionExecution=false`, `productionSupabaseChanged=false`. Money-movement permissions remain `NOT activated`.

`GET /prep/db-health`: `select1=ok`, `currentDatabase=checksops`, `transactionReadOnly=on`.
