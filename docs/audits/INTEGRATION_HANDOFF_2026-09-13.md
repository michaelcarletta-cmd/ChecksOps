# ChecksOps Functional Audit — Integration handoff

**Date:** 2026-09-13
**Workstream:** Functional Audit (`bc-c48d261b-22b3-481c-a28f-ddf0189e3bce`)
**Shared staging:** Integration & Release is the sole owner of `checksops-staging-api` and the shared SPA. This workstream will not overlay, restore SHA `ei+nNC2uAykoe4liskuXS5uZgzho/PERcyG1Cwc8X6Y=`, call `UpdateFunctionCode` / `UpdateFunctionConfiguration`, or modify production / production-prep.

`AWAITING_INTEGRATION_DEPLOYMENT` is not a product FAIL.

## Merge order (do not flatten unless reviewability is preserved)

1. `cursor/p1-endorsed-on-check-3bce` — PR #254 — base `main`
2. `cursor/p2-admin-override-3bce` — PR #257 — base P1
3. `cursor/p3-allowlist-3bce` — PR #258 — base P2
4. `cursor/p4-s3-images-3bce` — PR #260 — base P3
5. `cursor/p5-public-tokens-3bce` — PR #262 — base P4
6. `cursor/p6-negative-amounts-3bce` — PR #263 — base P5
7. `cursor/p7-branding-isolation-3bce` — PR #261 — base P6
8. `cursor/p3b-claim-number-grant-3bce` — PR #264 — base P7
9. `cursor/p8-endorsement-invalid-link-3bce` — PR #276 — stacked on P3b
10. `cursor/p9-owner-checkalt-settings-3bce` — PR #280 — stacked on P8
11. `cursor/p10-claim-settlement-write-3bce` — PR #277 — stacked on P9
12. `cursor/p11-mobile-check-center-clip-3bce` — PR #278 — stacked on P10 (app tip)
13. Inventory lineage is separate: `cursor/blocked-control-verification-3bce` → PR #268 `cursor/phase1-inventory-update-3bce` → PR #279 `cursor/phase2-inventory-awaiting-3bce` → PR #285 `cursor/phase2-internal-blocker-reduction-3bce`
14. Phase 2 app (independent of each other, both base `cursor/integration-awaiting-deploy-3bce`): PR #286 `cursor/phase2-claim-org-id-3bce` (SQL 41), PR #287 `cursor/phase2-dtp-sign-3bce` (SQL 42)

P3b supersedes P5 unknown-invoice 503 behavior and P3 CC-047 (GRANT SQL + workflow invariant restore). Do not merge inventory docs into the app stack.

## SQL / GRANT / flags Integration must apply (do not skip)

| Artifact | Purpose | Apply on shared staging? |
|---|---|---|
| `aws/write-path/sql/39_detected_claim_number_grant.sql` | `GRANT UPDATE (detected_claim_number)` on `check_intake_items` | Yes, with API deploy of P3b |
| `aws/write-path/sql/40_claim_settlements_grant.sql` | Narrow INSERT/UPDATE on settlement figure columns | Yes, with API deploy of P10 (already applied) |
| `aws/write-path/sql/41_claims_org_id_insert_grant.sql` + `41_create_claim_for_staff_org_id.sql` | Future tracking-claim INSERT includes `org_id`; staff RPC fail-closed without unique membership | Yes, with API deploy of PR #286. Do **not** run `23_claims_org_backfill.sql`. |
| `aws/write-path/sql/42_public_homeowner_claim_sign_dtp.sql` | Public token DTP persist (SECURITY DEFINER, checksops EXECUTE only) | Yes, with API+SPA deploy of PR #287 |
| `AWS_APPLICATION_WORKFLOW_WRITES_ENABLED=true` | Tranche 5/6 application writes | Staging only; keep production unset/false |
| `AWS_WRITES_ENABLED=true` / check-workflow / storage writes | Existing T2/T3 | Staging only |
| `AWS_PROVIDER_EXECUTION_ENABLED=false` | Moov / CheckAlt / Plaid / ACH stay off | Required |

Do not GRANT `claim_id` / amount / status / deposit columns on `check_intake_items`. Do not GRANT payments, disbursements, or wallets.

## Overlapping files (review in stack order)

| File | PRs |
|---|---|
| `src/integrations/aws/client.ts` | #254, #257 |
| `src/pages/CheckCommandCenter.tsx` | #257, #258, #260, P11 |
| `aws/functions/api/check-endorsement.mjs` | #254, #262, P8 |
| `aws/functions/api/workflow.mjs` | #257, #260 |
| `aws/functions/api/write-check-workflow.mjs` | #258, #260, #264, P10 |
| `aws/functions/api/write-allowlist.mjs` | #258, #263, P10 |
| `aws/functions/api/write-app-metadata.mjs` | #258, #263, P10 |
| `aws/functions/api/providers.mjs` | #262, #263 |
| `aws/functions/api/public-tokens.mjs` | #262, #264 |

## Batch status

### Existing stack P1–P7 + P3b — READY_FOR_INTEGRATION (AWAITING_INTEGRATION_DEPLOYMENT on live staging)

Physically proven during the previous overlay (PASS retained; do not revert to FAIL): CC-117 (#254), CC-367 (#257), CC-047 (#258+#264), A4-043–046 (#261), X-021 / X-029 (#262).

Git-fixed without physical UI on current staging (AWAITING, not FAIL): A1-066/067/068, CC-368 (#258); CC-219 / CC-361 (#260); A5-088/099/114/220 (#263).

### P8 unknown endorsement token copy — READY_FOR_INTEGRATION

- Branch / commit / PR: `cursor/p8-endorsement-invalid-link-3bce` @ `de96534d42a2c17ff4dec98b1334de7ed2ffa5d2` — PR #276
- Base: `cursor/p3b-claim-number-grant-3bce`
- Before: GET already `invalid_link`; submit/reject said already-used
- After: missing tokens return `invalid_link` / invalid or has expired; UI remaps leftover already-used copy
- Files: `aws/functions/api/check-endorsement.mjs`, `src/components/public/PublicInvalidLink.tsx`, `aws/tests/parity-check-endorsement.test.mjs`
- SQL: none
- Browser still required: `/endorse?token=not-a-real-endorsement-token` after SPA+API deploy
- Classification: READY_FOR_INTEGRATION / AWAITING_INTEGRATION_DEPLOYMENT until deploy

### P9 platform-owner CheckAlt view — READY_FOR_INTEGRATION

- Branch / commit / PR: `cursor/p9-owner-checkalt-settings-3bce` @ `8fd7bca8f82050cc9e38c4fe77abe0b50a262c8e` — PR #280
- Base: P8
- Controls: A4-013–A4-031 (was `owner_isAdmin_false`)
- After: platform owner email can view/load the form. `isAdmin` is unchanged. Test/Register/Poll remain fail-closed. Save of `checkalt_config` is still `financial_or_provider`.
- Files: `src/hooks/usePermissions.tsx`, `src/components/settings/CheckAltSettings.tsx`
- Browser still required: platform owner `/admin/tenants` CheckAlt panel after SPA deploy
- Classification: READY_FOR_INTEGRATION / AWAITING_INTEGRATION_DEPLOYMENT

### P10 claim settlement writes — READY_FOR_INTEGRATION

- Branch / commit / PR: `cursor/p10-claim-settlement-write-3bce` @ `d21b0476ea8b3ce7d7d5de59455dfe91d74d797e` — PR #277
- Base: P9
- Controls: A5-201–A5-204
- After: dedicated tranche-6 handler, tenant-linked claim, non-negative amounts, no claim_id retarget, no payments
- SQL: `aws/write-path/sql/40_claim_settlements_grant.sql`
- Flags: `AWS_APPLICATION_WORKFLOW_WRITES_ENABLED=true`
- Synthetic fixtures: a C1C check whose `claim_id` is already set. Do not GRANT intake `claim_id`.
- Browser still required: Review → Settlement → Save All Categories after deploy + GRANT + fixture
- Classification: READY_FOR_INTEGRATION / AWAITING_INTEGRATION_DEPLOYMENT

### P11 mobile Check Center clip — READY_FOR_INTEGRATION

- Branch / commit / PR: `cursor/p11-mobile-check-center-clip-3bce` @ `eb988a209b8a203dff8de61780c24fa75632ef74` — PR #278
- Base: P10
- Controls: P3-MOB-006
- Files: `src/pages/CheckCommandCenter.tsx`
- Browser still required: 390px Check Center after SPA deploy
- Classification: READY_FOR_INTEGRATION / AWAITING_INTEGRATION_DEPLOYMENT

### Inventory — READY_FOR_INTEGRATION (docs only)

- Branch / PR: `cursor/phase2-inventory-awaiting-3bce` — PR #279
- Base: `cursor/phase1-inventory-update-3bce` / PR #268
- Do not merge into the app stack

## Readiness snapshot (inventory, not a go-live)

| Metric | Phase 1 (#268) | After this continuation |
|---|---|---|
| PASS | 674 / 1,136 = 59.3% | 674 / 1,136 = 59.3% |
| FAIL | 12 | 1 (A8-035 Freedom identity, out of scope) |
| AWAITING_INTEGRATION_DEPLOYMENT | 0 | 34 |
| BLOCKED | 450 (277 internal + 173 external) | 427 (254 internal + 173 external) |
| N/A | 285 | 285 |

AWAITING is not PASS. Do not treat 59.3% as higher because FAILs moved to AWAITING.

## Phase 2 — Functional Audit (SQL 41 / 42, no deploy)

- PR #286 `cursor/phase2-claim-org-id-3bce` @ `dd7ef0214` — future `claims.org_id` on tracking-claim create. Apply SQL 41. Do not mass-backfill. One C1C synthetic row already repaired.
- PR #287 `cursor/phase2-dtp-sign-3bce` @ `3dd9bb6c4` — `aws_public_homeowner_claim_sign_dtp`. Apply SQL 42 with API+SPA. Live `sign_dtp` currently false-succeeds.
- After deploy, retest: synthetic settlement UI if a C1C session exists (do not reset Cognito); portal DTP sign → GET `dtp_signed_at`; malformed/unknown tokens still 400/404.
- Inventory PR #285 records 8 portal field PASSes and 2 AWAITING. A5-201–204 stay BLOCKED on C1C login.

## Still out of scope / do not execute

- A8-035 Freedom Cognito identity
- Provider execution, deposits, ACH/RTP/wires, Moov, CheckAlt execution
- Real SES email, Cognito OTP
- Production and production-prep
- Restoring the Functional Audit Lambda overlay
