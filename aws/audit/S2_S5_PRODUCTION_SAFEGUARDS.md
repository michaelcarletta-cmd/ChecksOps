# S2 / S5 production regression safeguards

**Date:** 2026-09-25  
**Scope:** Safeguard / branch-continuity / CI work only. No production Lambda, SQL, flag, or provider change.  
**S2 / S5:** CLOSED / PRODUCTION PASS. Accepted production baseline: `zb7E5ptHPmRsBegkIFgNzq3rzBktHvpNCJ1QMTHM6l0=`.  
The safeguard does **not** permanently pin that SHA and does not redeploy.

## S5 branch-continuity reconciliation

The accepted production implementation includes `admin_set_check_claim` in `workflow-rpc.mjs` plus `71_admin_set_check_claim.sql`. The S11/S14 continuation tree had dropped that RPC/test/SQL record.

Restored from `origin/cursor/s5-admin-set-check-claim-54b8` as the authority, without inventing a new implementation:

- `executeAdminSetCheckClaim` + `SAFE_WRITE_RPCS` / classification / dispatcher case in `workflow-rpc.mjs`
- `aws/tests/admin-set-check-claim.test.mjs`
- `aws/workflows/sql/71_admin_set_check_claim.sql` (contract/migration record only; not executed)
- accepted `workflow-rpc-bridges.test.mjs` assertions

This is a repository/CI correction. Production is not redeployed because the line is reconciled.

## Where it runs

Existing AWS API pre-deploy guardrail:

```bash
npm run test:aws-api
```

CI: `.github/workflows/aws-migration-ci.yml` → `bun run test:aws-api` (picks up `aws/tests/*.test.mjs`).

Failure output always includes `S2 Material Endorsement Invalidation` or `S5 Audited Claim Association`.

## Files added/changed

| Path | Role |
| --- | --- |
| `aws/functions/api/workflow-rpc.mjs` | Restore accepted S5 RPC bridge only |
| `aws/workflows/sql/71_admin_set_check_claim.sql` | Accepted S5 SQL contract record |
| `aws/tests/admin-set-check-claim.test.mjs` | Accepted S5 tests |
| `aws/tests/workflow-rpc-bridges.test.mjs` | Accepted S5 classification assertions |
| `aws/tests/s2-material-endorsement-invalidation-safeguard.test.mjs` | S2 behavioral + mutation safeguard |
| `aws/tests/lib/s2-material-endorsement-invalidation-safeguard.mjs` | S2 invariant/mutation helpers |
| `aws/tests/s5-audited-claim-association-safeguard.test.mjs` | S5 behavioral + mutation safeguard |
| `aws/tests/lib/s5-audited-claim-association-safeguard.mjs` | S5 invariant/mutation helpers |
| `scripts/aws-s14-deposit-payee-line-safeguard.mjs` | Include new S2/S5/S14 files in optional runner |
| `aws/audit/S2_S5_PRODUCTION_SAFEGUARDS.md` | This record |

S2 runtime behavior is unchanged. Production SQL is not executed or altered.

## S2 invariants

`executePayees` remains coupled to `invalidateEndorsementsForMaterialPayeeChange`.

The safeguard fails if:

- the helper call is removed from `executePayees`
- material `payee_name` change stops invalidating
- material `payee_type` change stops invalidating
- non-material edits begin invalidating
- duplicate-collapse / signature invalidation is lost
- official rear fingerprint clearing is lost
- audit event `endorsement_invalidated_material_edit` is lost

## S5 invariants

1. Authorized admin can set / correct / clear `claim_id` before deposit
2. Target claim must belong to the same tenant
3. Deposited check cannot change / clear `claim_id`
4. Same-value request is a no-op
5. Immutable audit entry records actor / check / prior / new claim
6. Generic `/data/write` `claim_id` remains prohibited
7. RPC remains explicitly allowed / classified through the accepted narrow bridge
8. SQL remains `SECURITY DEFINER` with accepted authorization / deposit / tenant / audit protections
9. SQL does not introduce a direct `GRANT UPDATE(claim_id)` escape path

Mutation probes (local copies only) fail CI if the RPC dispatcher/bridge, deposited protection, tenant protection, audit insertion, or generic `claim_id` prohibition is removed.

## Verification (2026-09-25)

Cross-regression: **131/131 PASS** (S2/S3/S4/S5/S11/S14 unit + safeguard suites).

Read-only production compare of `checksops-production-prep-api`:

- SHA unchanged: `zb7E5ptHPmRsBegkIFgNzq3rzBktHvpNCJ1QMTHM6l0=`
- LastModified unchanged: `2026-09-25T13:43:44.000+0000`
- `workflow-rpc.mjs` is now byte-identical to production (S5 RPC is no longer missing from this line)
- `write-check-workflow.mjs`, `endorsement-material-invalidation.mjs`, `financial-remaining.mjs`, `financial.mjs`, `check-deposited.mjs`, `ocr.mjs`, `ocr-descriptive-persist.mjs` are byte-identical
- Remaining non-S2/S5/S11/S14 diffs: `write-allowlist.mjs` tenants insert/slug allowlist, and `ingest-shared-check.mjs` production tenant INSERT columns (`payment_provider` / `moov_*`). Those are not accepted S2/S5 behavior and were not changed here.

No production Lambda update. No staging runtime update. No SQL execution. No provider calls.

**S2 SAFEGUARD: PASS**  
**S5 SAFEGUARD: PASS**  
**PHASE 1 REMEDIATION SAFEGUARDS COMPLETE: YES**
