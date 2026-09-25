# S2 material endorsement invalidation — production promotion

**Date:** 2026-09-25  
**Function:** `checksops-production-prep-api`  
**Method:** In-place `UpdateFunctionCode` overlay only. No SAM. No `UpdateFunctionConfiguration`. No SQL. No Supabase.

## Pre-deploy gate

Live production `write-check-workflow.mjs` (package mtime `2026-09-24 12:24:46`) differed from the accepted staging S2 file **only** by the remediations hunks:

1. Import `endorsement-material-invalidation.mjs`
2. `lookupPayee` also selects `payee_name`, `payee_type`
3. `executePayees` receives `mapping` and, after a material `payee_name` / `payee_type` update, calls `invalidateEndorsementsForMaterialPayeeChange`
4. Dispatcher passes `mapping` into `executePayees`

`endorsement-material-invalidation.mjs` was absent from the live production package. No other production files needed to change. The overlay zip added that module and replaced `write-check-workflow.mjs` only.

## SHAs

| | Value |
| --- | --- |
| Production SHA before | `dWaJvede75K80U8lW5kSzaU5fv5MFN3DLfHGZRHrYhM=` |
| Production SHA after | `hjz0G98YOSPT2vyE9+Qy+n8a7pr87e2+Dgodm4zzC2A=` |
| Last modified after | `2026-09-25T01:59:56.000+0000` |
| LastUpdateStatus | Successful |

## Files overlaid

- `endorsement-material-invalidation.mjs` (added; SHA matches repo)
- `write-check-workflow.mjs` (replaced; SHA matches repo)

Live package after deploy: added `{endorsement-material-invalidation.mjs}`, changed `{write-check-workflow.mjs}`, removed `{}`.

## Environment / config diff

**None.** `Environment.Variables` (44 keys) identical before and after. Role, runtime, memory, timeout, VPC, description, and layers unchanged. `UpdateFunctionConfiguration` was not called.

## Provider flags before / after

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

Public `GET https://checksops.com/prep/workflow/status` and `/prep/financial/status` flags were identical after overlay. `liveProviderTransactions` stayed `false`. `productionExecution` stayed `false`.

## Safe verification (no production money movement)

- Live package contains the invalidation module and `executePayees` material-change call.
- `isMaterialPayeeChange` is name/type only. `executeIntakeUpdate` does not call invalidation (notes/address/carrier stay non-material).
- `GET /prep/db-health` still `select1=ok`, `currentDatabase=checksops`, `transactionReadOnly=on`.
- CloudWatch after `2026-09-25T01:59:56Z`: 0 `endorsement_invalidated_material_edit` events, 0 `/data/write` events, 0 ERROR events. Deploying code did not execute the write path or rewrite existing signatures.
- No production check, payee, endorsement, financial prepare/submit, Moov transfer, or CheckAlt deposit was created.
- Staging billing-protected leftovers `b887bd62-…`, `710c9494-…`, `ed194599-…` remain. They were not modified or deleted.

## Confirmations

- No SAM deploy
- No database trigger change
- No provider / Moov / CheckAlt / financial flag change
- No Supabase reconnect (`productionSupabaseChanged=false`)
- No Phase 2 work

Rollback zip retained at `/tmp/checksops-prod-lambda/rollback-before.zip` (SHA `dWaJvede75K80U8lW5kSzaU5fv5MFN3DLfHGZRHrYhM=`).
