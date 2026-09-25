# S5 claim association — staging remediations

**Date:** 2026-09-25  
**Scope:** Narrow Phase 1 S5 remediations. Staging Lambda overlay + one SECURITY DEFINER function. Production promotion is documented in `S5_PRODUCTION_PROMOTION.md`.  
**S2/S3/S4/S11/S14:** not reopened.  
**API:** `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging`  
**Function:** `checksops-staging-api` (in-place `UpdateFunctionCode`, not SAM)

## Requirement

An authorized admin can set, correct, or clear `check_intake_items.claim_id` only before deposit, only inside the caller tenant, and only onto a same-tenant claim. Every real change writes an immutable `check_audit_log` row. Generic `/data/write` of `claim_id` stays denied.

## Exact files changed

- `aws/functions/api/workflow-rpc.mjs` — `admin_set_check_claim` in `SAFE_WRITE_RPCS` + `executeAdminSetCheckClaim`
- `aws/workflows/sql/71_admin_set_check_claim.sql` — SECURITY DEFINER writer (no `GRANT UPDATE(claim_id)`)
- `aws/tests/admin-set-check-claim.test.mjs`
- `aws/tests/workflow-rpc-bridges.test.mjs`
- `scripts/aws-s5-claim-association-accept.mjs`
- `aws/audit/S5_CLAIM_ASSOCIATION.md`
- `aws/audit/S5_CLAIM_ASSOCIATION_REMEDIATIONS.md`

## Why a DEFINER function

Column grants on `check_intake_items` intentionally omit `claim_id`. A direct `UPDATE ... SET claim_id` from the `checksops` role returns `permission denied for table check_intake_items`. The RPC therefore calls `public.admin_set_check_claim(actor, check, claim)`, which is the only privileged writer. `INTAKE_PROHIBITED_COLUMNS` still contains `claim_id`. Generic `/data/write` is unchanged.

## Staging Lambda SHA

| | Value |
| --- | --- |
| Before (S2 baseline) | `mybLtCmFjsfK7tfSSo7GPIqQRvjjjQwNewVyUCHLM3M=` |
| After S5 overlay | `x/2kTsBOzLCoBErLjVoNEKtEGibJbN+XRbx1QsbS5z0=` |
| Current (S5 RPC still present) | `P8eTuIEr7GNEiwLC5og1ba8Ajp06kTPUvlSstBCYfzI=` |
| Overlay file | `workflow-rpc.mjs` only |
| Production before S5 promotion | `hjz0G98YOSPT2vyE9+Qy+n8a7pr87e2+Dgodm4zzC2A=` |

Live staging `workflow-rpc.mjs` differed from this branch only by the S5 hunks before overlay.

## Unit tests

`node --test aws/tests/admin-set-check-claim.test.mjs aws/tests/workflow-rpc-bridges.test.mjs aws/tests/endorsement-material-invalidation.test.mjs`

13 passed, 0 failed.

## Staging acceptance (synthetic Freedom check `53af4199-7867-411f-a974-61409069c6f9`)

Claims used (created for the run, then deleted):

- A `1eac7214-0f49-4e7f-a2ee-d97ed53556ee` `AWS-S5-SYNTHETIC-A`
- B `b0130c85-ff3e-4051-aee2-dd21f0382d4a` `AWS-S5-SYNTHETIC-B`
- C1C `266e1ae8-ec20-4ed5-9243-3e1424304ec6` (existing, not deleted)

Actor: `e3b2f5e6-0e25-4bb6-9f4e-6c2dfba5fb87` (Freedom admin mapped from `checksops-tester@freedomadj.com`).

| # | Case | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Unlinked → Claim A | **PASS** | audit `ea2e95c4-b7ac-4bd9-a834-2363b3ca5ff7` prior `null` → A |
| 2 | Claim A → Claim B | **PASS** | audit `f00aa7cc-301f-405b-b861-1c6f9726f965` A → B |
| 3 | Claim B → NULL | **PASS** | audit `70ded061-3378-42c8-8273-4b8d2c2847f9` B → `null` |
| 4 | Cross-tenant target claim | **PASS** | `403 cross_tenant_denied`, `claim_id` stayed `null` |
| 5 | Unauthorized/non-admin (C1C token on Freedom check) | **PASS** | `403 not_authorized`, no mutation |
| 6 | Deposited check | **PASS** | `5f14f3f1-4db1-4fe5-b2cd-5ec72e840fb7` change/clear `403 already_deposited` |
| 7 | Generic `/data/write` `claim_id` | **PASS** | `403 column_not_allowlisted` `columns=["claim_id"]` |
| 8 | Same-value no-op | **PASS** | `noop=true`, audit count stayed 2 |
| 9 | Amount / payees / endorsement / deposit / financial unchanged | **PASS** | amount `150`, 1 payee, 1 endorsement, 0 deposits, 0 billing, `deposited_at` null |
| 10 | S2/S3/S4 regressions | **PASS** | Phase 1 harness `PHASE1_SCENARIOS=2,3,4`: 26 passed, 0 failed, no findings |

Synthetic check deleted (`200`). Synthetic Freedom claims deleted. Four previously retained billing-protected leftovers were not touched. S2 regression left three new `cleanup_denied` checks (`748d3bad`, `1e2895fc`, `9ff91f9e`) because Ready created `check_billing_events`; they were retained, not force-deleted.

## Audit-row evidence

All three mutation rows are `event_type=admin_set_check_claim` with actor, `created_at`, check id, `prior_claim_id`, and `new_claim_id`:

1. `ea2e95c4-b7ac-4bd9-a834-2363b3ca5ff7` — `prior_claim_id=null`, `new_claim_id=1eac7214-...`
2. `f00aa7cc-301f-405b-b861-1c6f9726f965` — A → B
3. `70ded061-3378-42c8-8273-4b8d2c2847f9` — B → `null`

The identical B → B request did not insert a fourth row.

## Generic claim_id write

Still blocked after cleanup: `403 column_not_allowlisted` `columns=["claim_id"]` on `POST /data/write` `check_intake_items`.

## Production promotion

**Promoted 2026-09-25.** See `S5_PRODUCTION_PROMOTION.md`.

1. Applied `aws/workflows/sql/71_admin_set_check_claim.sql` on production RDS
2. Overlaid accepted `workflow-rpc.mjs` onto live `checksops-production-prep-api`

| | Value |
| --- | --- |
| Production SHA before | `hjz0G98YOSPT2vyE9+Qy+n8a7pr87e2+Dgodm4zzC2A=` |
| Production SHA after | `4nRr0xh9SelxDuMAzNmgbbpWAaiWmPOgtiN14DkDXgM=` |

JS without the DEFINER function fails with `permission denied` / `data_query_failed`. The accepted SQL does not `GRANT UPDATE(claim_id)` on `check_intake_items`.

## S5 CLAIM ASSOCIATION STAGING REMEDIATIONS: PASS
