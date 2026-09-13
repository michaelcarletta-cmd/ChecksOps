# Phase 3 read-only Functional Audit prep — 2026-09-13

**Workstream:** Functional Audit (Phase 3)
**Authority:** Shared-staging coordination correction — do not restore
  `W3oWlWtMhILouJRPezrrsJOQJQP8VnWDZYo1Ljy/tqE=` or `index-Bo0IO5sc.js`;
  do not deploy PR #288; wait for Integration & Release to pin the
  authoritative API + SPA baseline.
**Physical testing:** STOPPED until that pin is **explicitly declared stable**.
**Phase 4:** STOPPED. No A8-035, no production, no Freedom, no master-mapping,
  no Email/SES, no other-workstream branch edits.

This document is local/read-only preparation. It does **not** change
inventory counts. It does **not** authorize staging writes.

---

## 1. Frozen inventory (do not mutate)

Source of truth remains `docs/audits/inventory-2026-09-11.json`.

| Bucket | Count |
|---|---:|
| PASS | 714 |
| FAIL | 1 |
| INTERNAL BLOCKED | 248 |
| EXTERNAL BLOCKED | 173 |
| AWAITING | 0 |
| N/A | 285 |
| **Total** | **1,421** |

Live / non-N/A denominator = 1,136. Operational PASS = 62.9%.
The single FAIL remains **A8-035**. Do not reclassify it.

Do **not** change these counts because the live API SHA differs from the
historical Functional Audit / Phase 2 SHA.

---

## 2. Observed live staging (Integration lineage, not yet a pin)

Read-only observation at 2026-09-13T16:47Z. This is **reported**, not adopted
as the Functional Audit expected test baseline.

| Surface | Observed |
|---|---|
| API function | `checksops-staging-api` |
| API CodeSha256 | `OSiyHTQqSq5J3QRZCKdDrQ7PRW5qPWeJS71LZ46LIOE=` |
| API LastModified | 2026-09-13T11:15:47.000+0000 |
| LastUpdateStatus | Successful |
| SPA bucket | `checksops-staging-frontend-c48b` |
| SPA objects | `index-a512Q1W0.js` + `index-67D8chGr.css` (LastModified 12:32:09Z) |
| Historical Phase 2 SPA | `index-Bo0IO5sc.js` → **404** (expected; do not restore) |
| Historical Phase 2 API | `W3oWlWtMhILouJRPezrrsJOQJQP8VnWDZYo1Ljy/tqE=` — **do not restore** |

Coordination states this API SHA is the newer Integration & Release lineage
(coherent Git-derived RC + public-endorsement GET fix). Functional Audit
must **not** classify it as drift merely because it differs from PR #288.

**Resume gate:** Integration & Release must explicitly declare a **pinned**
API CodeSha256 + SPA hashed filename pair as the stable baseline. Until then,
physical Phase 3 testing stays stopped even if the live SHA remains
`OSiyHTQq…`.

---

## 3. Rebase / reconcile procedure (after the pin is declared)

When Integration publishes the pin:

1. Record the declared API CodeSha256 and SPA hashed filename as
   `expected_test_baseline` in a new Phase 3 session note. Do **not**
   treat PR #288 `8ee90ac7b` / historical SHA as the expected artifact.
2. Confirm live Lambda + SPA match the declared pin (read-only). If they
   do not match, STOP and report to Integration. Do **not** overlay.
3. Verify Phase 2 **behavior** is present in the integrated release:
   - A5-201–204 settlement editor (tab, Cancel, Save All Categories, number
     input) in `ClaimSettlementEditor.tsx` of the **deployed** SPA/API.
   - C1C settlement fixture still readable:
     claim `266e1ae8-ec20-4ed5-9243-3e1424304ec6` /
     settlement `783788b8-13d8-44c8-97a2-9dc794dd29df`.
   - No requirement that the historical ZIP or `index-Bo0IO5sc.js` itself
     be present.
4. If a Phase 2 control’s **behavior** is missing from the integrated
   release, report the **control ID + missing behavior** to Integration.
   Do **not** restore or deploy the old artifact.
5. Only then resume the first physical INTERNAL BLOCKED pass below.

---

## 4. Fixtures to retain (do not mutate, do not backfill)

| Fixture | ID | Rule |
|---|---|---|
| C1C settlement claim | `AWS-PR235-LEDGER-TEST-B` / `266e1ae8-ec20-4ed5-9243-3e1424304ec6` | Keep. Do not run `23_claims_org_backfill.sql`. |
| C1C settlement | `783788b8-13d8-44c8-97a2-9dc794dd29df` | RCV 10000 / rec 2000 / non-rec 500 / deductible 1000 / expected ACV 6500. |
| C1C tenant | `4f172140-f57a-4744-8050-95f4f07b13b4` (slug `c1c`) | Isolation subject. |
| C1C admin | `payments@condition1commercial.com` / sub `e418f488-4011-7046-5a09-3f8b51140899` / app UUID `fd857564-9534-4b0f-95ac-624ed1273725` | Login restored by Identity/Cognito. Functional Audit must **not** `AdminSetUserPassword`. |
| Freedom tenant | `a8035-freedom-tenant` | Isolation only. Do not mutate. A8-035 stays FAIL. |

Do **not** GRANT `claim_id` on intake. Do **not** fabricate deposited CheckAlt
rows. Do **not** mint pay-setup tokens. Do **not** seed CRC payee rows unless
a later Integration-approved fixture plan says otherwise.

---

## 5. First physical pass — control IDs (queued, not executed)

Execute **only** after §2 resume gate. Session = C1C
(`payments@condition1commercial.com`) at `https://staging.checksops.com`.
Do not use master UAT as the primary subject except for documented
isolation negatives.

### 5.1 A5-201–204 (first, same session)

| Control | Behavior to prove |
|---|---|
| A5-201 | Line-item category tabs switch visible pane |
| A5-202 | Cancel discards in-progress edits |
| A5-203 | Save All Categories persists |
| A5-204 | Number input accepts/validates amounts |

Source: `src/components/claims/ClaimSettlementEditor.tsx`.
Current inventory blocker: `c1c_authenticated_session_unavailable` (stale
vs Identity restore — retest after pin, do not change the count now).

### 5.2 CCC Category A (synthetic C1C checks only)

Queue / review / endorsing / loss-draft / reissue **status transitions**
and **save amount / field / payee** on existing synthetic checks:

CC-321, CC-322, CC-323, CC-324, CC-325, CC-326, CC-327, CC-345, CC-375,
CC-377, CC-384, CC-408, CC-409, CC-410.

Withhold even after pin:

| Control | Why |
|---|---|
| CC-335, CC-336 | Delete — destructive |
| CC-363 | CheckAlt Deposit — provider-backed |
| CC-364 | Undo CheckAlt Deposit — would need fabricated deposited row |
| CC-365, CC-366 | Move to Deposited / related — funds-adjacent |

### 5.3 Next INTERNAL clusters (still blocked by reason, not SHA)

These stay INTERNAL BLOCKED until a **safe fixture or product change**
exists. Listing them is prep, not a license to execute.

| Cluster | Approx. | Controls / notes | Resume condition |
|---|---:|---|---|
| `unsafe_persist` remainder | 40+ | Non-Category-A persist (templates, settings, payees, email templates) | Per-control safe-write review |
| `empty_fixture` | 31 | Missing rows | Integration-approved seed only |
| `unsafe_configuration_mutation` | 28 | Org/user/settings | Do not mutate shared staging config |
| `valid_paysetup_token_unavailable` | 19 | X-022–041, `RecipientPaymentSetup.tsx` | Do not mint; wait on Payments token design |
| `control_not_in_live_ui` | 14 | Mostly `EndorsementAdjuster` | Product must ship the control |
| `claim_portal_action_not_ported` | 14 | A7-028–041 | Portal port required |
| `empty_settled_payments` | 13 | A5-061–073 TaxSummary / `disbursement_splits` | Real settled payments fixture |
| `no_crc_payee_row` | 10 | CC-087–096 | Do not invent CRC payee |
| Status-gated CheckAlt | 4 | CC-363–366 | Do not fabricate deposited; do not execute CheckAlt |

External blockers (173) stay EXTERNAL. Do not convert them to INTERNAL
by running live Moov / CheckAlt / Plaid / ACH.

---

## 6. What Functional Audit will not do while waiting

- Deploy, restore, overlay, or otherwise modify shared staging.
- Deploy PR #288 / `8ee90ac7b` or any Functional Audit ZIP.
- Restore API `W3oWlWtMhILouJRPezrrsJOQJQP8VnWDZYo1Ljy/tqE=`.
- Restore SPA `index-Bo0IO5sc.js`.
- Merge to `main`.
- Change `docs/audits/inventory-2026-09-11.json` counts.
- Start Phase 4.
- Run `23_claims_org_backfill.sql`.
- `AdminSetUserPassword` / Cognito writes.
- Provider-backed execution (`AWS_PROVIDER_EXECUTION_ENABLED` remains
  observed `false`; do not flip it).

---

## 7. Ask of Integration & Release

1. Declare the authoritative **pinned** API CodeSha256 + SPA hashed
   filename for continued physical Functional Audit testing.
2. Explicitly mark that pin **stable**.
3. Confirm whether Phase 2 settlement-editor behavior (A5-201–204) and
   the C1C settlement fixture are contained in that release.
4. If any Phase 2 behavior is absent, Integration owns the gap; Functional
   Audit will report control IDs rather than overlaying old artifacts.

No restore of historical Functional Audit artifacts is requested.
