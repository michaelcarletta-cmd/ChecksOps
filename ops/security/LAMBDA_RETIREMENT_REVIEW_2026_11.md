# Lambda retirement review, November 2026

Owner, 2026-11-03: "Let's proceed with step three" (step 3 of `NODE_RUNTIME_PLAN_2026_11.md`).

This file is a review list. Nothing is deleted by it. The owner marks each function **retire** or **keep** in the last column; deletion follows as its own step, on the owner's words, run by the owner.

## What was checked (read-only, 2026-11-03)

All 86 functions in `us-east-1` minus the four live ones (`production-prep-api`, `staging-api`, `production-origin-verify`, `staging-guarded-sql-executor`): **82 functions**. For each:

- **Use:** CloudWatch `Invocations` per day for 90 days. **None of the 82 has run since 2026-10-05.**
- **Triggers:** resource policy, EventBridge rules, event-source mappings and function URLs. **None of the 82 has any**, so nothing invokes them automatically.
- **Repo references:** names found in `scripts/`, `.github/`, `aws/`, `src/`, `ops/deployment-guard/` and `ops/release-locks/`, excluding Markdown.
- **CloudFormation:** stack membership by physical resource id.
- **Role reach:** the secrets each role's inline and customer-managed policies name, and IAM simulation of `secretsmanager:GetSecretValue`. **No role in review can read the production database admin secret** (`rds-db-credentials/checksops-production/checksops_admin/…`, the one the SQL runner reads). 77 of the 82 run under roles that can read the **staging** admin secret.

## Proposed

- **keep:** 1
- **owner decides:** 2
- **retire (delete stack):** 2
- **retire:** 77

## Roles

Deleting a function does not delete its role. The 82 use 7 roles:

| Role | Functions in review using it | After retirement |
|---|---|---|
| `checksops-staging-rehearsal-oneshot` | 75 | **Keep.** The live staging SQL executor runs under this role. |
| `checksops-staging-pr129-sql70-3a4a` | 2 | Unused once its functions are retired; list for a follow-up role cleanup. |
| `Checksops-role-ku1r91ck` | 1 | Unused once its functions are retired; list for a follow-up role cleanup. |
| `checksops-ocr-azure-validation-504e-role` | 1 | Deleted with its CloudFormation stack. |
| `checksops-textract-parser-test-504e-role` | 1 | Deleted with its CloudFormation stack. |
| `checksops-staging-ApiFunctionRole-7E7XRyLe3nyi` | 1 | **Keep.** The live `checksops-staging-api` runs under this role. |
| `checksops-staging-mortgage-desk-e2e-harness-role` | 1 | Unused once its functions are retired; list for a follow-up role cleanup. |

## Review list

Rollback data for every row, covering the configuration, CodeSha256, role, VPC and environment variable names, is in `lambda-retirement-2026-11.json`.

| Function | Proposed | Last run (90 d) | Runs (90 d) | Last modified | Role | Repo / stack references | Owner mark |
|---|---|---|---|---|---|---|---|
| `checksops-staging-rehearsal-oneshot` | keep | 2026-09-27 | 165 | 2026-09-22 | `checksops-staging-rehearsal-oneshot` | `.github/workflows/guarded-staging-sql-executor.yml`, `aws/db-copy/rehearsal/oneshot-apply/package.json` |  |
| `Checksops` | owner decides | none | 0 | 2026-09-01 | `Checksops-role-ku1r91ck` | (name matches unrelated text only) |  |
| `checksops-staging-sql44-2d41` | owner decides | 2026-09-27 | 2 | 2026-09-25 | `checksops-staging-rehearsal-oneshot` | `aws/tests/sql-executor-auth.test.mjs`, `ops/deployment-guard/bypass-inventory.json` |  |
| `checksops-ocr-azure-validation-504e` | retire (delete stack) | 2026-09-18 | 5 | 2026-09-18 | `checksops-ocr-azure-validation-504e-role` | `aws/isolated/ocr-azure-validation-504e/pack.sh`, `aws/isolated/ocr-azure-validation-504e/package.json`, stack `checksops-ocr-azure-validation-504e` |  |
| `checksops-textract-parser-test-504e` | retire (delete stack) | 2026-09-18 | 2 | 2026-09-18 | `checksops-textract-parser-test-504e-role` | `aws/isolated/textract-parser-test-504e/template.yaml`, stack `checksops-textract-parser-test-504e` |  |
| `checksops-cursor-moov-monitor-temp` | retire | 2026-09-15 | 3 | 2026-09-15 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-endorsement-transition-inspect-e3dd` | retire | 2026-09-23 | 53 | 2026-09-23 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-m79-sql77-b844` | retire | 2026-09-22 | 368 | 2026-09-22 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-claim-ledger-sql-apply-a2a4` | retire | 2026-10-02 | 2 | 2026-10-02 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-claim-ledger-sql-inspect-a2a4` | retire | 2026-10-03 | 10 | 2026-10-02 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-macomp47-oneshot-ad99` | retire | 2026-10-03 | 12 | 2026-10-03 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-macomp48-oneshot-ad99` | retire | 2026-10-03 | 9 | 2026-10-03 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-macomp49-oneshot-ad99` | retire | 2026-10-04 | 11 | 2026-10-03 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-moov-billing-inspect-ro-2d41` | retire | 2026-09-29 | 7 | 2026-09-25 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-moov-billing-sql-43-2d41` | retire | 2026-09-25 | 1 | 2026-09-25 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-mops-accept-inspect-ad99` | retire | 2026-10-03 | 29 | 2026-10-03 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-mops-accept-seed-ad99` | retire | 2026-10-03 | 2 | 2026-10-03 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-mops-sql-transition-ad99` | retire | 2026-10-03 | 3 | 2026-10-03 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-mops-sql39-inspect-ad99` | retire | 2026-10-03 | 15 | 2026-10-03 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-mortgage-ops-audit-2d41` | retire | 2026-09-27 | 9 | 2026-09-25 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-mortgage-ops-preview-2d41` | retire | 2026-09-27 | 5 | 2026-09-25 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-mortgage-ops-sql-2d41` | retire | 2026-09-25 | 1 | 2026-09-25 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-pr601-sql-inspect-a2a4` | retire | 2026-10-03 | 13 | 2026-10-02 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-sig-check-file-probe-ad99` | retire | 2026-09-28 | 6 | 2026-09-28 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-signature-inspect-ad99` | retire | 2026-10-02 | 2 | 2026-09-27 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-signature-sql-apply-ad99` | retire | 2026-09-27 | 2 | 2026-09-27 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-signature-verify-ad99` | retire | 2026-09-27 | 2 | 2026-09-27 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-sql44-apply-2d41` | retire | 2026-09-25 | 1 | 2026-09-25 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-sql44-inspect-2d41` | retire | 2026-10-03 | 15 | 2026-09-25 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-sql47-apply-2d41` | retire | 2026-09-25 | 1 | 2026-09-25 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-sql47-inspect-2d41` | retire | 2026-10-03 | 18 | 2026-09-25 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-sql70-grant-a2a4` | retire | 2026-10-02 | 2 | 2026-10-02 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-sql70-priv-inspect-a2a4` | retire | 2026-10-02 | 2 | 2026-10-02 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-ui-sig-fixture-ad99` | retire | 2026-09-28 | 9 | 2026-09-28 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-v2-live-collect-2d41` | retire | 2026-09-29 | 4 | 2026-09-29 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-v3-identity-inspect-2d41` | retire | 2026-09-25 | 9 | 2026-09-25 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-v3d-inspect-2d41` | retire | 2026-09-26 | 3 | 2026-09-25 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-v3e-inspect-2d41` | retire | 2026-09-29 | 8 | 2026-09-25 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-prod-wallet-fund-recover-2d41` | retire | 2026-09-30 | 3 | 2026-09-30 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-production-legacy-tenant-preflight` | retire | 2026-09-26 | 13 | 2026-09-24 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-production-loss-draft-inspect-b5e0` | retire | 2026-09-26 | 2 | 2026-09-23 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-production-loss-draft-view-apply-b5e0` | retire | 2026-09-23 | 1 | 2026-09-23 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-production-loss-draft-view-verify-b5e0` | retire | 2026-09-26 | 2 | 2026-09-23 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-production-tenant-onboard-59ff` | retire | 2026-09-24 | 64 | 2026-09-24 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-production-workflow-grants-83c9` | retire | 2026-09-26 | 5 | 2026-09-24 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-sql65-status-read-inspect-6136` | retire | 2026-09-23 | 122 | 2026-09-23 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-billing-verification-2d41` | retire | 2026-09-25 | 2 | 2026-09-25 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-c1c-share-inspect-46ac` | retire | 2026-09-22 | 27 | 2026-09-16 | `checksops-staging-rehearsal-oneshot` | `scripts/c1c-partner-share-aws-inspect.mjs` |  |
| `checksops-staging-cbe-index-inspect` | retire | 2026-10-04 | 3 | 2026-10-03 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-checkalt-config-diagnose-6136` | retire | 2026-09-17 | 4 | 2026-09-17 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-checkalt-ui-access-validate-6136` | retire | 2026-09-17 | 3 | 2026-09-17 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-external-recording-grants-83c9` | retire | 2026-09-23 | 4 | 2026-09-23 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-identity-inspect-2d41` | retire | 2026-10-02 | 6 | 2026-09-25 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-identity-preflight-6136` | retire | 2026-10-03 | 24 | 2026-09-21 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-loss-draft-inspect-b5e0` | retire | 2026-09-27 | 2 | 2026-09-23 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-loss-draft-view-apply-b5e0` | retire | 2026-09-23 | 1 | 2026-09-23 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-macomp48-oneshot` | retire | 2026-10-04 | 6 | 2026-10-03 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-macomp50-oneshot` | retire | 2026-10-04 | 7 | 2026-10-04 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-mde2e-identity-oneshot` | retire | 2026-10-03 | 58 | 2026-09-27 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-moov-billing-2d41` | retire | 2026-09-25 | 6 | 2026-09-25 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-moov-billing-dest-2d41` | retire | 2026-09-25 | 1 | 2026-09-25 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-moov-billing-inspect-2d41` | retire | 2026-09-30 | 5 | 2026-09-25 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-moov-billing-inspect-2d41-moov` | retire | 2026-09-25 | 1 | 2026-09-25 | `checksops-staging-ApiFunctionRole-7E7XRyLe3nyi` |  |  |
| `checksops-staging-moov-billing-tenant-2d41` | retire | 2026-09-25 | 18 | 2026-09-25 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-mops-gate4-oneshot` | retire | 2026-10-03 | 16 | 2026-10-03 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-mortgage-desk-e2e-harness` | retire | 2026-09-30 | 14 | 2026-09-27 | `checksops-staging-mortgage-desk-e2e-harness-role` |  |  |
| `checksops-staging-mortgage-ops-billing-2d41` | retire | 2026-09-27 | 20 | 2026-09-25 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-org-membership-diagnose-6136` | retire | 2026-09-21 | 3 | 2026-09-17 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-owner-relink-6136` | retire | 2026-09-21 | 20 | 2026-09-17 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-partner-integrity-3bce` | retire | 2026-09-16 | 4 | 2026-09-16 | `checksops-staging-rehearsal-oneshot` | `ops/deployment-guard/bypass-inventory.json`, `scripts/staging-partner-integrity-inspect.mjs` |  |
| `checksops-staging-pending-sync-diagnose-6136` | retire | 2026-09-22 | 11 | 2026-09-17 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-pr129-sql70-3a4a` | retire | 2026-09-05 | 4 | 2026-09-05 | `checksops-staging-pr129-sql70-3a4a` |  |  |
| `checksops-staging-pr235-sql69` | retire | 2026-09-14 | 13 | 2026-09-11 | `checksops-staging-pr129-sql70-3a4a` |  |  |
| `checksops-staging-sig-check-file-ad99` | retire | 2026-09-28 | 2 | 2026-09-28 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-sql35-apply-6136` | retire | 2026-09-17 | 4 | 2026-09-17 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-sql38-apply-6136` | retire | 2026-09-24 | 2 | 2026-09-24 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-sql44-seed-2d41` | retire | 2026-09-27 | 9 | 2026-09-25 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-synthetic-cleanup-83c9` | retire | 2026-09-27 | 5 | 2026-09-24 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-tenant-logo-fixture` | retire | 2026-09-28 | 13 | 2026-09-28 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-tenant-onboard-59ff` | retire | 2026-09-24 | 19 | 2026-09-24 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-v2-provider-collect-2d41` | retire | 2026-09-29 | 4 | 2026-09-29 | `checksops-staging-rehearsal-oneshot` |  |  |
| `checksops-staging-v2-provider-inspect-2d41` | retire | 2026-10-05 | 2 | 2026-09-29 | `checksops-staging-rehearsal-oneshot` |  |  |

### Notes on the rows that are not a plain retire

- `checksops-staging-rehearsal-oneshot`: Keep: the live staging SQL executor reads its role and environment (`sql-executor-ensure.mjs`, `github-staging-sql-executor.mjs`) and the staging executor policy names it.
- `Checksops`: Owner decides: console-created on 2026-09-01 (role `Checksops-role-ku1r91ck`, nodejs24.x), no invocations in 90 days, no repo source. Retire unless it is yours.
- `checksops-staging-sql44-2d41`: Owner decides: named in the executor guard's deny-list and `bypass-inventory.json` as a function the guard must never retarget. Deleting it does not break that code, but the inventory then names a function that no longer exists.
- `checksops-ocr-azure-validation-504e`: Belongs to CloudFormation stack `checksops-ocr-azure-validation-504e`: delete the stack, not the function.
- `checksops-textract-parser-test-504e`: Belongs to CloudFormation stack `checksops-textract-parser-test-504e`: delete the stack, not the function.

## After the owner marks the list

1. **Archive, recommended.** Before deleting, the owner copies each marked function's code package into `s3://checksops-sql53-transfer-806168576068/archive/lambda-retire-2026-11/`. The configuration record alone cannot restore code that is not in the repo.
2. **Delete.** The owner deletes the marked functions in CloudShell, and the two CloudFormation stacks with a stack delete. Claude prepares the exact commands from the marked list and checks afterwards, read-only, that each one is gone and that nothing live changed.
3. **Roles.** A follow-up lists the roles no remaining function uses, for removal.
