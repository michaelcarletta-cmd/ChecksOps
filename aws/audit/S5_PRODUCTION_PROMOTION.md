# S5 claim association — production promotion

**Date:** 2026-09-25  
**Function:** `checksops-production-prep-api`  
**Method:** Apply only `aws/workflows/sql/71_admin_set_check_claim.sql` on production RDS, then in-place `UpdateFunctionCode` overlay of accepted `workflow-rpc.mjs` onto the live package. No SAM. No `UpdateFunctionConfiguration`. No other SQL. No Supabase.

**S2/S3/S4:** CLOSED, not reopened.  
**S11/S14:** later Phase 1 gaps, not started.

## Pre-deploy gate

Live production SHA before overlay was still the required baseline:

`hjz0G98YOSPT2vyE9+Qy+n8a7pr87e2+Dgodm4zzC2A=`

Live `workflow-rpc.mjs` (package mtime `2026-09-24 12:24:46`) differed from the accepted S5 file **only** by the remediations hunks:

1. `SAFE_WRITE_RPC_CLASSIFICATION.admin_set_check_claim = 'safe_now'`
2. `SAFE_WRITE_RPCS` includes `'admin_set_check_claim'`
3. `sameClaimId` helper + `executeAdminSetCheckClaim`
4. Dispatcher `case 'admin_set_check_claim'`

No other production files needed to change. The overlay zip replaced `workflow-rpc.mjs` only. Every other live file remained byte-for-byte identical.

Production RDS had no existing `public.admin_set_check_claim` (`existing: []`). Preflight did not STOP.

## SHAs

| | Value |
| --- | --- |
| Production SHA before | `hjz0G98YOSPT2vyE9+Qy+n8a7pr87e2+Dgodm4zzC2A=` |
| Production SHA after | `4nRr0xh9SelxDuMAzNmgbbpWAaiWmPOgtiN14DkDXgM=` |
| Last modified after | `2026-09-25T12:25:20.000+0000` |
| LastUpdateStatus | Successful |
| State | Active |

Re-checked after verification: SHA, LastUpdateStatus, LastModified, and RevisionId `67c4489b-64b1-4c0c-b34a-169ee285d56d` are unchanged.

## Exact Lambda diff promoted

Package vs rollback zip `/tmp/checksops-prod-s5-rollback-before.zip`:

- added `{}`
- removed `{}`
- changed `{workflow-rpc.mjs}` only

Live `workflow-rpc.mjs` matches the accepted repo file. Live `write-allowlist.mjs` matches the pre-S5 rollback byte-for-byte and still lists `claim_id` in `INTAKE_PROHIBITED_COLUMNS`.

## SQL applied and verification

Applied only `aws/workflows/sql/71_admin_set_check_claim.sql`.

| Check | Result |
| --- | --- |
| Function present | `public.admin_set_check_claim(p_actor_id uuid, p_check_id uuid, p_claim_id uuid)` |
| SECURITY DEFINER | true |
| `already_deposited` | true |
| `cross_tenant_denied` | true |
| `not_authorized` | true |
| audit `admin_set_check_claim` | true |
| no-op when prior IS NOT DISTINCT FROM new | true |
| `deposited_at IS NULL` on UPDATE | true |
| GRANT | `EXECUTE` to `checksops` only; `REVOKE ALL FROM PUBLIC` |
| GRANT UPDATE(claim_id) | **not** issued |

## Direct claim_id privilege status

**Unchanged. S5 did not grant UPDATE(claim_id).**

Privilege snapshot before and after the migration is identical:

- `checksops`: INSERT, SELECT, UPDATE on `check_intake_items.claim_id`
- `checksops_admin`: INSERT, REFERENCES, SELECT, UPDATE

Production already had table-level `UPDATE` on `check_intake_items` for `checksops` (includes `claim_id`, `amount`, `deposited_at`, and the rest of the table). That grant predates S5 and was recorded in preflight. The accepted SQL does not `GRANT UPDATE(claim_id)` and was not used to revoke the pre-existing table UPDATE. Application-layer generic `/data/write` remains the control that keeps `claim_id` off the intake allowlist.

## Generic /data/write protection status

`INTAKE_PROHIBITED_COLUMNS` still contains `claim_id` in the live production package. Unauthenticated `POST /prep/data/write` with `claim_id` returns `401 missing_cognito_token` and does not mutate a row. Staging acceptance already proved the authenticated path returns `403 column_not_allowlisted`. No production check was used to re-prove that write.

Unauthenticated `POST /prep/data/rpc` `admin_set_check_claim` also returns `401 missing_cognito_token`.

## Environment / config before / after

**None.** `Environment.Variables` (44 keys) identical before and after. Role, runtime, memory, timeout, VPC, description, layers, handler, and Cognito ids unchanged. `UpdateFunctionConfiguration` was not called.

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

Public `GET https://checksops.com/prep/workflow/status` and `/prep/financial/status` flags match. `liveProviderTransactions` stayed `false`. `productionExecution` stayed `false`. `productionSupabaseChanged` stayed `false`.

`GET /prep/db-health`: `select1=ok`, `currentDatabase=checksops`, `transactionReadOnly=on`.

## CloudWatch

`/aws/lambda/checksops-production-prep-api` since `2026-09-25T12:25:20Z`:

- ERROR filter: 0 events
- Recent sample: INIT_START / START / END / REPORT only
- No `admin_set_check_claim` invocations
- No timeouts, permission-denied, or connection errors

## Safe verification (no production money movement)

- No existing production check or claim was updated.
- No synthetic production check or claim was created.
- No deposit, transfer, wallet, CheckAlt, or other provider operation was created.
- Behavioral proof remains the accepted staging 10-case run. Production verification is code + SQL + flags + CloudWatch.

Rollback zip retained at `/tmp/checksops-prod-s5-rollback-before.zip` (SHA `hjz0G98YOSPT2vyE9+Qy+n8a7pr87e2+Dgodm4zzC2A=`). Temporary oneshot Lambda `checksops-production-s5-sql-54b8` was deleted after SQL apply/verify.

## Confirmations

- No SAM deploy
- No unrelated migration
- No provider / Moov / CheckAlt / financial / Cognito / tenant / Supabase change
- S2/S3/S4 not reopened
- S11/S14 not started

## S5 PRODUCTION PROMOTION: PASS
