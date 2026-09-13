# Phase 3 Functional Audit — STOP at staging mismatch

**Superseded for resume:** Integration declared the live overlay as the audit pin. See `docs/audits/PHASE3_FUNCTIONAL_AUDIT_RESUME_2026-09-13.md`. Do not restore `W3oWlWtM…` / `index-Bo0IO5sc.js`.

**Date:** 2026-09-13  
**Workstream:** Functional Audit (`bc-c48d261b-22b3-481c-a28f-ddf0189e3bce`)  
**Inventory baseline:** #291 `cursor/phase2-integration-inventory-3bce` @ `b941ba9b4`  
**Do not begin Phase 4.**

This chat independently confirmed the Phase 3 STOP condition. Another Functional Audit chat (`bc-0789979c-…d82c`, PR #296) already documented the same mismatch. This workstream did **not** modify, close, or overwrite that PR.

## Baseline (verified inventory, not live SHA)

| Metric | Count |
|---|---:|
| Discovered | 1,421 |
| N/A | 285 |
| Live/non-N/A | 1,136 |
| PASS | 714 |
| FAIL | 1 (`A8-035`, out of scope) |
| INTERNAL BLOCKED | 248 |
| EXTERNAL BLOCKED | 173 |
| AWAITING | 0 |
| Operational PASS | 714 / 1,136 = **62.9%** |

Expected Integration stack (PR #288):

| Item | Expected |
|---|---|
| HEAD | `8ee90ac7b` |
| API CodeSha256 | `W3oWlWtMhILouJRPezrrsJOQJQP8VnWDZYo1Ljy/tqE=` |
| API LastModified | `2026-09-13T10:57:00Z` |
| SPA | `index-Bo0IO5sc.js` |
| SQL 41 / 42 | applied; `23_claims_org_backfill.sql` not run |

## Read-only preflight (this chat)

`overlayPerformed=false`. Provider execution remained `"false"`. Application writes `"true"`.

| Resource | Expected | Live 2026-09-13T17:38Z |
|---|---|---|
| API `checksops-staging-api` CodeSha256 | `W3oWlWtMhILouJRPezrrsJOQJQP8VnWDZYo1Ljy/tqE=` | `OSiyHTQqSq5J3QRZCKdDrQ7PRW5qPWeJS71LZ46LIOE=` |
| API LastModified | `2026-09-13T10:57:00Z` | `2026-09-13T11:15:47Z` |
| SPA `index.html` JS | `index-Bo0IO5sc.js` | `index-a512Q1W0.js` (index.html LastModified `2026-09-13T12:32:10Z`) |
| Old SPA object | n/a | `index-Bo0IO5sc.js` still HTTP 200 (orphaned object; **not** referenced by live `index.html`) |

**STOP.** Physical Phase 3 testing was not started. This workstream did not overlay, apply SQL, or merge.

Likely parallel overlays after #288 (handoff only; not investigated beyond names):

- API LastModified `11:15:47Z` — after #288 overlay `10:57Z`
- SPA `index.html` `12:32:10Z` — PR #294 (`cursor/mortgage-ops-coherent-successor-d93c`) updated around that time

## Root-cause ranking (remaining 248 / 72 causes)

Reconciled against `docs/audits/PHASE2_INTERNAL_BLOCKER_REDUCTION_2026-09-13.md`. Unique internal roots still **72**. Categories: FIXTURE 104, UNSAFE_IRREVERSIBLE 100, MISSING_FEATURE 38, STATUS 4, STAGING_INFRA 2.

Ranked for **when Integration restores a coherent stack** (unlock × operational importance ÷ risk). Physical testing was not performed.

| Rank | Root cause | n | Importance | Risk | Planned action after restore |
|---|---:|---|---|---|---|
| 1 | `c1c_authenticated_session_unavailable` (A5-201–204) | 4 | Highest (settlement/ledger) | low (existing fixture) | Physical C1C UI on `AWS-PR235-LEDGER-TEST-B` |
| 2 | `unsafe_persist_checkcommandcenter` | 16 | High | medium | Category A persist on synthetic checks; no deposits |
| 3 | `status_gated_deposit_controls` | 4 | High | medium | Application status only; no fabricated deposited/ACH |
| 4 | `no_crc_payee_row` | 10 | High | low | Supported payee/CRC fixture then physical test |
| 5 | `missing_back_image_adjuster` | 4 | Medium | low | Synthetic back image; no customer docs |
| 6 | `empty_settled_payments` | 13 | Medium | high if provider | Split: internal fixture vs genuine provider-settled |
| 7 | `claim_portal_action_not_ported` | 14 | Medium | medium | Live UI + 501 = FAIL unless documented staging boundary |
| 8 | `control_not_in_live_ui` | 14 | Medium | low | Mounted vs gated vs dead; do not N/A for difficulty |
| 9 | `valid_paysetup_token_unavailable` | 19 | High count | high (Moov-coupled) | Provider-free lifecycle only; no Moov enable |
| 10 | `unsafe_persist_sign` / shared fee/security config | 8+8+6 | Low for coverage | high | Do not mutate live shared fee schedules |

Do **not** batch: shared fee schedule, tenant security, create-tenant, C1C payment-account reset.

## C1C Settlement / Claim Ledger (A5-201–A5-204)

**Not physically tested.** Classification unchanged: **BLOCKED** `c1c_authenticated_session_unavailable`.

Existing fixture retained (not modified this phase): claim `266e1ae8-ec20-4ed5-9243-3e1424304ec6` / `AWS-PR235-LEDGER-TEST-B`; settlement `783788b8-13d8-44c8-97a2-9dc794dd29df`; RCV 10000 / rec 2000 / non 500 / ded 1000 / expected ACV 6500.

C1C login was **not** attempted after the SHA mismatch STOP. This environment has no injected C1C password secret (`CLOUD_AGENT_INJECTED_SECRET_NAMES` is only the AWS assume-role ARN). Listed Secrets Manager names include `checksops/staging/master-uat-password` but no C1C password secret. Do not retrieve master UAT to impersonate C1C. Do not call `AdminSetUserPassword`.

## Priorities 2–10

Not executed (STOP). Remaining blockers unchanged.

## New defects

None proven (no physical testing).

## Remediation PRs

None from this chat. Do not deploy.

## Fixture ledger

| Fixture | Tenant | IDs | Purpose | Creation | Disposition | Provider invoked |
|---|---|---|---|---|---|---|
| C1C ledger claim | C1C `4f172140-…` | `266e1ae8-…` / `AWS-PR235-LEDGER-TEST-B` | A5-201–204 | Phase 2 one-row org_id repair | **Retained; not modified** | No |
| C1C settlement | C1C | `783788b8-…` | Known-number ACV | Phase 2 | **Retained; not modified** | No |
| Phase 2 portal leads | C1C contractor | `ccee4d05-…`, `05360374-…`, pending `e2f3d304-…` | Prior DTP/upload | SES-free mint | **Retained; not used in Phase 3** | No |

No Phase 3 fixtures created.

## Inventory movement

None. Starting = ending.

PASS **714** / FAIL **1** / INTERNAL BLOCKED **248** / EXTERNAL BLOCKED **173** / AWAITING **0** / N/A **285**.  
Operational PASS **714 / 1,136 = 62.9%**.

## Remaining blockers

248 internal / 72 unique causes. Largest: pay-setup 19, CCC persist 16, missing UI 14, portal 501 14, settled payments 13, CRC 10.

## Cross-workstream handoffs

| Issue | Owning workstream | Blocked Phase 3? | Evidence | Action here |
|---|---|---|---|---|
| Live API SHA `OSiyHTQq…` ≠ expected `W3oWlWtM…`; SPA `index-a512Q1W0.js` | Integration & Release | **Yes** — STOP | `/opt/cursor/artifacts/phase3_preflight.json` | NONE (no overlay) |
| Duplicate Phase 3 STOP PR #296 | Parallel Functional Audit (`d82c`) | No | PR #296 | NONE (not overwritten) |
| Mortgage Ops SPA successor #294 around SPA `12:32Z` | Mortgage Ops / Integration | Contributed to mismatch | PR timestamps vs SPA LastModified | NONE |
| C1C password not in this environment’s injected secrets | C1C / Cognito | Would block C1C UI after restore | Secret list; env names | NONE |
| A8-035 Freedom identity FAIL | Cognito / identity | No | Existing FAIL | NONE |
| Moov PRs #290/#293/#297 | Moov / provider | No (flags still false) | Open PRs | NONE |

## Safety

- Production unchanged
- Provider execution remained OFF
- No real financial transaction
- SES/email unchanged
- Cognito unchanged
- C1C password unchanged (not used)
- Freedom A8-035 unchanged
- No unrelated SQL applied
- No shared-staging deployment performed
- No PR merged to main
- No other workstream changes overwritten

**STOP after this report. Do not begin Phase 4.**
