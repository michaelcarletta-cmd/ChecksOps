# Phase 3 STOP — shared staging no longer matches the coherent Integration stack

**Date:** 2026-09-13  
**Workstream:** Functional Audit  
**Agent:** `bc-0789979c-9a64-42a8-a015-4446f4b9d82c`  
**Decision:** STOP before Phase 3 physical testing. Do not overlay. Do not begin Phase 4.

This is a read-only preflight stop, not an inventory conversion and not a product FAIL.

## 1. Baseline

Starting inventory (`docs/audits/inventory-2026-09-11.json` on `cursor/phase2-integration-inventory-3bce` @ `b941ba9b4`):

| Result | Count |
|---|---:|
| Discovered | 1,421 |
| N/A | 285 |
| Live/non-N/A | 1,136 |
| PASS | 714 |
| FAIL | 1 (`A8-035`, Identity-owned, out of scope) |
| INTERNAL BLOCKED | 248 |
| EXTERNAL BLOCKED | 173 |
| AWAITING | 0 |

Operational PASS: **714 / 1,136 = 62.9%**.

Staging identity (Identity/Cognito workstream, previous turn of this agent; Cognito **not** changed in Phase 3):

- `payments@condition1commercial.com` enabled, CONFIRMED, C1C mapped, C1C admin, tenant admin
- application UUID `fd857564-9534-4b0f-95ac-624ed1273725`
- Cognito sub `e418f488-4011-7046-5a09-3f8b51140899`
- tenant `4f172140-f57a-4744-8050-95f4f07b13b4` (`c1c`)
- not master owner; no Freedom membership
- clean-session browser login previously landed on `/c1c/checks`

Phase 3 did **not** reset or otherwise mutate this Cognito user.

Expected coherent stack (Phase 2 Integration PR #288):

| Item | Expected |
|---|---|
| Branch | `cursor/phase2-integration-deploy-3bce` |
| Integrated HEAD | `8ee90ac7b` |
| API | `checksops-staging-api` |
| CodeSha256 | `W3oWlWtMhILouJRPezrrsJOQJQP8VnWDZYo1Ljy/tqE=` |
| API LastModified (documented) | `2026-09-13T10:57:00.000+0000` |
| SPA assets | `index-Bo0IO5sc.js` |
| SQL | 41 + 42 applied; `23_claims_org_backfill.sql` not run |

## 2. Root-cause ranking (unchanged inventory; not physically retested)

Rank remaining INTERNAL root causes by controls unlocked × operational importance ÷ change risk. Physical verification did not run.

| Rank | Attack first when stack is restored | n | Importance | Risk | Why this rank |
|---|---|---:|---|---|---|
| 1 | `c1c_authenticated_session_unavailable` → A5-201–204 settlement/ledger UI | 4 | critical financial workflow | low once C1C session exists | Previous blocker was auth only; fixture `AWS-PR235-LEDGER-TEST-B` already exists |
| 2 | Category A `unsafe_persist` on synthetic Check Command Center (not Delete, not funds/provider) | 16 of 56 `unsafe_persist` historically CCC | high operator workflow | medium | Converts conservative BLOCKED to PASS/FAIL |
| 3 | `status_gated_deposit_controls` via supported application-only transitions | 4 | medium | low | Do not fabricate deposited/funds-released |
| 4 | `no_crc_payee_row` via supported UI/API payee create | 10 | medium | low | Synthetic payee only |
| 5 | `empty_settled_payments` — split internal vs provider-settled | 13 | medium | high if fabricated ACH | Leave EXTERNAL if genuine provider completion required |
| 6 | `valid_paysetup_token_unavailable` | 19 | high count | high (Moov-coupled mint) | Do not enable Moov; investigate SES-free lifecycle only |
| 7 | `claim_portal_action_not_ported` / `BLOCKED_MISSING_FEATURE` | 14+ | medium | medium | Live UI vs missing write path |
| 8 | `control_not_in_live_ui` (EndorsementAdjuster back-image gated) | 14 | medium | low | Do not N/A from navigation failure |
| 9 | S3/image-dependent internals | 2+ | medium | low | Synthetic images only |
| 10 | Payment onboarding / shared fee / legally meaningful signatures | various | high config risk | high | Leave `BLOCKED_UNSAFE_IRREVERSIBLE` unless a dedicated synthetic tenant exists |

Do **not** batch shared `PlatformFeeSchedulePanel`, tenant security config, create-tenant, or C1C payment-account reset.

`empty_moov_invoices` (7) is likely EXTERNAL/provider after accurate reclassification; do not fabricate Moov invoices.

## 3. C1C settlement / ledger (A5-201–A5-204)

**Not physically retested in Phase 3.** STOP fired on stack mismatch before opening Settlement UI.

| ID | Control | Disposition |
|---|---|---|
| A5-201 | ClaimSettlementEditor category tab | remains BLOCKED (`c1c_authenticated_session_unavailable` in inventory; C1C auth is restored, but stack is not the coherent Integration SHA) |
| A5-202 | Cancel | same |
| A5-203 | Save All Categories | same |
| A5-204 | settlement amount input | same |

Inventory rows were **not** converted to PASS. Auth restoration is necessary but not sufficient once shared staging diverged.

Fixture (retained from Phase 2; not modified here):

- Claim `AWS-PR235-LEDGER-TEST-B` / `266e1ae8-ec20-4ed5-9243-3e1424304ec6`
- C1C tenant `4f172140-f57a-4744-8050-95f4f07b13b4`
- Settlement `783788b8-13d8-44c8-97a2-9dc794dd29df`
- RCV 10000 / rec 2000 / non 500 / ded 1000 / expected ACV 6500

## 4–11. Remaining Phase 3 clusters

Not physically executed. STOP.

Check Command Center, status-gated, CRC/payee, settled payments, pay-setup, missing-feature, images/S3, payment onboarding, shared configuration, and signature controls remain at the Phase 2 inventory dispositions.

## 12. New defects

None proven in Phase 3 (no physical exercise on the coherent stack).

## 13. Remediation PRs

None. No application/SQL/Cognito change. This document is a stop/handoff only.

## 14. Fixture ledger

| Fixture | Tenant | IDs | Purpose | Creation | Disposition | Provider invoked |
|---|---|---|---|---|---|---|
| Phase 2 C1C ledger claim | C1C `4f172140-…` | claim `266e1ae8-…`, settlement `783788b8-…` | A5-201–204 | Phase 2 | **Retained.** Not modified in Phase 3 | no |
| Phase 3 synthetics | — | — | — | none | none created | no |

## 15. Inventory movement

Starting:

PASS 714 / FAIL 1 / INTERNAL BLOCKED 248 / EXTERNAL BLOCKED 173 / AWAITING 0 / N/A 285

Ending: **unchanged**.

PASS / 1,136 = **62.9%**. Denominator unchanged.

No PASS inflation. No previously proven PASS was retested against the mismatched stack.

## 16. Remaining internal blockers

Still **248** internal BLOCKED across the Phase 2 clusters. Highest-count inventory `blocker` values:

| blocker | n | category |
|---|---:|---|
| `unsafe_persist` | 56 | BLOCKED_UNSAFE_IRREVERSIBLE |
| `empty_fixture` | 31 | BLOCKED_FIXTURE |
| `unsafe_configuration_mutation` | 28 | BLOCKED_UNSAFE_IRREVERSIBLE |
| `valid_paysetup_token_unavailable` | 19 | BLOCKED_FIXTURE |
| `control_not_in_live_ui` | 14 | BLOCKED_MISSING_FEATURE |
| `claim_portal_action_not_ported` | 14 | BLOCKED_MISSING_FEATURE |
| `empty_settled_payments` | 13 | BLOCKED_FIXTURE |
| `no_crc_payee_row` | 10 | BLOCKED_FIXTURE |
| `c1c_authenticated_session_unavailable` | 4 | BLOCKED_FIXTURE |
| `status_gated_deposit_controls` | 4 | BLOCKED_STATUS |

## 17. Cross-workstream handoffs

| Issue | Owning workstream | Evidence | Blocked Phase 3? | Action here |
|---|---|---|---|---|
| Live API CodeSha256 ≠ PR #288 expected SHA | Integration & Release | Live `OSiyHTQqSq5J3QRZCKdDrQ7PRW5qPWeJS71LZ46LIOE=` LastModified `2026-09-13T11:15:47Z`; expected `W3oWlWtMhILouJRPezrrsJOQJQP8VnWDZYo1Ljy/tqE=` at `10:57:00Z` | **yes** | NONE (do not overlay) |
| Live SPA replaced; expected JS 404 | Integration & Release | Live `index-a512Q1W0.js` + `index-67D8chGr.css` (S3 LastModified `2026-09-13T12:32:09Z`). Expected `index-Bo0IO5sc.js` **404** in `checksops-staging-frontend-c48b` | **yes** | NONE |
| A8-035 Freedom identity FAIL | Identity/Cognito | unchanged | no | NONE |
| staging-master mapping discrepancy | Identity/Cognito | Phase 2 `identity_not_linked` on master `/data/*` | no | NONE |
| Pay-setup mint Moov-coupled | Email/SES is not owner; provider mint is Integration/provider boundary | Phase 2 map | would be later | NONE — do not enable Moov |
| SES / email | Email/SES | not touched | no | NONE |

Handoff to Integration & Release: restore or explicitly re-pin the coherent Phase 2 stack (API SHA `W3oWlWtMhI…` + SPA `index-Bo0IO5sc.js`), **or** publish a new coherent SHA/SPA pair Functional Audit should treat as baseline. Until then Phase 3 physical testing stays stopped.

## 18. Safety confirmation

- production unchanged
- provider execution remained OFF (`AWS_PROVIDER_EXECUTION_ENABLED=false`; Moov/CheckAlt/Plaid enabled flags `false`)
- no real financial transaction
- no real provider execution
- SES/email unchanged
- Cognito unchanged in this Phase 3 turn (no password reset, no user/mapping/pool/client change)
- Freedom A8-035 unchanged
- no unrelated SQL applied
- no shared-staging deployment performed by this workstream
- no PR merged to main
- no other workstream changes overwritten or reverted
- `23_claims_org_backfill.sql` not run

## Live preflight snapshot (read-only)

AWS account `806168576068`, region `us-east-1`, function `checksops-staging-api`.

| Flag | Live |
|---|---|
| `CHECKSOPS_ENV` | `staging` |
| Cognito pool | `us-east-1_vPmQ7cL1F` |
| `AWS_WRITES_ENABLED` | `true` |
| `AWS_APPLICATION_WORKFLOW_WRITES_ENABLED` | `true` |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `false` |
| `AWS_MOOV_ENABLED` / `AWS_CHECKALT_ENABLED` / `AWS_PLAID_ENABLED` | `false` |
| SPA origin | `https://staging.checksops.com/` |

STOP. Do not automatically begin Phase 4.
