# Phase 3 Functional Audit — live Integration pin resume

**Date:** 2026-09-13  
**Workstream:** Functional Audit  
**Do not begin Phase 4.**  
**Did not restore** `W3oWlWtMhILouJRPezrrsJOQJQP8VnWDZYo1Ljy/tqE=` or `index-Bo0IO5sc.js`.

## Preflight pin verification

Read-only. `overlayPerformed=false`. Verdict: **PIN_MATCH**. No STACK_MISMATCH.

| Item | Expected | Live |
|---|---|---|
| API CodeSha256 | `OSiyHTQqSq5J3QRZCKdDrQ7PRW5qPWeJS71LZ46LIOE=` | match |
| API git HEAD | `320685542f070ba23ed8970d870f3eded590fd9a` | live zip files hash-match this HEAD |
| Function | `checksops-staging-api` `us-east-1` / `806168576068` | match |
| LastModified | `2026-09-13T18:07:57.000+0000` | unchanged since handoff |
| SPA JS | `index-a512Q1W0.js` | match |
| SPA CSS | `index-67D8chGr.css` | match |
| `index.html` ETag | `113dfd26211290d0be78377d4b8e1ee2` | match |
| Provider execution | `false` | `false` |

Evidence: `/opt/cursor/artifacts/phase3_resume_preflight.json`

## Controls physically tested

| ID | Result | Evidence |
|---|---|---|
| A5-201 | **BLOCKED** `c1c_authenticated_session_unavailable` | SPA + `/auth/login` 400 |
| A5-202 | **BLOCKED** same | settlement editor not opened |
| A5-203 | **BLOCKED** same | Save not clicked |
| A5-204 | **BLOCKED** same | numeric input not reached |
| CC-321–327 | **BLOCKED** same | Category A bulk persist not clicked |
| CC-345 | **BLOCKED** same | Upload & Analyze not clicked |
| CC-375 | **BLOCKED** same | Download not clicked |
| CC-377 | **BLOCKED** same | Save amount not clicked |
| CC-384 | **BLOCKED** same | Save field not clicked |
| CC-408–410 | **BLOCKED** same | payee Save/Edit/Remove not clicked |
| A7-024 | **FAIL** Integration regression | API false-success; SPA locked on historical sign |
| P8 unknown-token GET | Confirmed regression (no dedicated inventory ID flipped) | API `token_consumed`; SPA mixed copy |
| A7-028 cluster `complete_action` / `sign_document` / `submit_mortgage_intake` | remain **BLOCKED** `claim_portal_action_not_ported` | live API 501 |
| P9 / P10 / P11 / claim-create `org_id` | **not proven** | C1C session required |
| A7-027 upload | not re-run this pass (distinct from org_id) | prior PASS left unchanged |

C1C login: email `payments@condition1commercial.com`, documented audit password. HTTP 400 `login_failed`. SPA toast: `Password sign-in failed` / `Incorrect username or password.` Cognito not modified. Master UAT was not used as a C1C identity.

## Confirmed Integration regressions / missing controls

1. **A7-024 Sign Direction to Pay — FAIL.** Live Lambda `sign_dtp` runs `UPDATE public.homeowner_intro_requests` (not SQL 42 RPC). POST returned `signed=true`. GET after still `Pat Homeowner` / `2026-09-13T11:13:05.404Z`. `falseSuccess=true`. Short name still 400. Pending still 403. SPA hides Sign because GET still shows signed from the Phase 2 persist. Do not restore the historical zip to make this pass.

2. **P8 unknown endorsement token.** POST `/public/endorsement` `get_endorsement_data` with a nonsense token returns HTTP 404 `token_consumed` / `This endorsement link has already been used or replaced.` SPA `/endorse?token=…` shows title `This link is invalid or has expired` and body `already been used or replaced.` P8 required unknown tokens to be invalid, not consumed.

3. **Claim-create `org_id` (PR #286) and P9/P10/P11** — not executed; C1C session unavailable. Live zip previously hashed as missing Phase 2 org_id insert and P9/P10 commits.

## Inventory

Starting (unchanged until evidence): PASS **714** / FAIL **1** / INTERNAL BLOCKED **248** / EXTERNAL BLOCKED **173** / AWAITING **0** / N/A **285**. Operational PASS 62.9%.

Movement this pass:

| From | To | IDs |
|---|---|---|
| PASS → FAIL | 1 | A7-024 |

Ending: PASS **713** / FAIL **2** (`A8-035`, `A7-024`) / INTERNAL BLOCKED **248** / EXTERNAL BLOCKED **173** / AWAITING **0** / N/A **285**. Live/non-N/A **1,136**. Operational PASS **713 / 1,136 = 62.8%**.

The live pin differing from historical Phase 2 artifacts is not itself an inventory change.

## Fixtures

| Fixture | Disposition |
|---|---|
| Claim `266e1ae8-ec20-4ed5-9243-3e1424304ec6` | Retained; not modified |
| Settlement `783788b8-13d8-44c8-97a2-9dc794dd29df` | Retained; not modified |
| `23_claims_org_backfill.sql` | Not run |
| Portal lead `05360374-…` | GET-only after failed persist; name unchanged |

## Can Phase 3 continue safely?

**Not for the ordered remainder that needs C1C** (A5 settlement UI, CCC Category A persist, CRC, back-image, Check Center status-gated, P9/P10/P11, claim-create org_id). Those stay blocked on `c1c_authenticated_session_unavailable` until Cognito supplies a working C1C password **without this workstream mutating Cognito**.

Public/API surfaces on this pin can continue. Do not restore historical artifacts. Do not start Phase 4.

## Safety

- Production unchanged
- Provider execution remained `false`
- No overlay, deploy, merge, or SQL apply
- SES/Cognito unchanged
- No pay-setup mint, no CRC invention, no CC-335/336 delete, no CC-363–366 fabricated deposits
