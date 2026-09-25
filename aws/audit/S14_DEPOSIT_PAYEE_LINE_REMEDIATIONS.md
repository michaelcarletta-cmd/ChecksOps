# S14 deposit payee_line protection — staging remediations

**Date:** 2026-09-25  
**Scope:** Staging Lambda overlay only. No production deploy.  
**S2/S3/S4/S5/S11:** CLOSED / PRODUCTION PASS. Not reopened.  
**Production Lambda:** frozen `dplSPx8YJoYbkolr2c6mKersDAV7OCzHt5y3UyIOdoc=`

## Requirement

`payee_line` is immutable once either:

1. `check_intake_items.deposited_at IS NOT NULL`, or
2. a confirmed provider deposit exists for that check (`aws_financial_operations` money-in type `checkalt_deposit` in `provider_confirmed` / `settled`).

Pre-deposit descriptive correction remains allowed. Same-value post-deposit requests no-op. Lookup failures fail closed.

## Canonical deposited-state logic

`isCheckDeposited(client, checkId)` in `aws/functions/api/check-deposited.mjs`:

1. Invalid client / invalid UUID / missing row / query error → `{ deposited: true, failClosed: true }`
2. `deposited_at` present → `{ deposited: true, reason: 'deposited_at' }`
3. Confirmed money-in row exists (same sets as `financial-remaining.mjs`) → `{ deposited: true, reason: 'confirmed_provider_deposit' }`
4. Else `{ deposited: false, reason: 'not_deposited' }`

Confirmed-provider lookup raises `request.financial_certification='1'` inside `SAVEPOINT s14_deposit_lookup` and rolls that savepoint back so `/data/write` can see `aws_financial_operations` without leaving the GUC set for the rest of the transaction. Savepoint, GUC, or ops errors fail closed.

`rejectPayeeLineIfDeposited` allows a same-value no-op without mutation. A changed value is rejected with `payee_line_locked` when deposited or fail-closed.

`payee_line` is **not** added to `INTAKE_PROHIBITED_COLUMNS`.

## Writers protected

| Writer | File |
| --- | --- |
| `executeIntakeUpdate` | `write-check-workflow.mjs` |
| `executeClaimChecks` | `write-check-workflow.mjs` |
| OCR descriptive `COALESCE` update | `ocr.mjs` |
| `persistOcrDescriptiveHandoff` | `ocr-descriptive-persist.mjs` |
| Existing-row ingest update | `ingest-shared-check.mjs` |

Create-check insert and first-time ingest insert remain unlocked (new undeposited rows).

## Staging Lambda SHA

| When | SHA |
| --- | --- |
| Before S14 overlay | `jSjcGOr9efEuixUEKSU3WSdHsc+Nmd7P21cRaRi0zBk=` |
| After first lock overlay | `4KQcLgmEb+xqhc30WLoL5huWUStJlWqEEKrUDmRiZKg=` |
| After GUC fail-closed overlay (accepted) | `jJs84yQMaFl0jv2wBloSeUql9bg1GzIn1WD1i3IsVvU=` |

The first overlay still failed open on confirmed sandbox deposits because `/data/write` could not see `aws_financial_operations` without `request.financial_certification='1'`. The accepted SHA includes the savepoint GUC lookup.

## Staging acceptance (synthetic)

`scripts/aws-s14-deposit-payee-line-accept.mjs` — 15/15 PASS. Artifact: `/opt/cursor/artifacts/s14-deposit-payee-line-accept.json`.

| Case | Result |
| --- | --- |
| 1 Pre-deposit `/data/write` correction | PASS — 200, Original → Corrected |
| 2 After confirmed sandbox deposit, change denied | PASS — 403 `payee_line_locked` |
| 3 `deposited_at IS NOT NULL` change denied | PASS — 403 `payee_line_locked` |
| 4 OCR cannot overwrite after deposit | PASS — payee unchanged (intake S3 key missing this run) |
| 5 Existing-row ingest cannot overwrite | PASS — same `check_id`, payee unchanged |
| 6 `claim_checks` cannot bypass | PASS — 403 `payee_line_locked` |
| 7 Fail-closed on lookup error | PASS — unit coverage (`lookup_failed` / missing / invalid / GUC / savepoint) |
| 8 Same-value post-deposit does not mutate | PASS — 200 no-op, no UPDATE |
| 9 Denied attempts leave related state unchanged | PASS — payees, endorsements, amount, status, deposit state, financial history unchanged |
| Live CheckAlt remains blocked | PASS — 403 `checkalt_mutation_blocked` |
| Synthetic cleanup | PASS — no leftovers; prior ingest leftovers deleted |

No live CheckAlt/Moov. No production writes.

## Closed-item regressions

| Suite | Result |
| --- | --- |
| S2 material invalidation (unit + phase1 core asserts) | PASS — pre-deposit `payee_line` write still allowed; invalidation/audit/amount lock unchanged. Phase1 identify re-sign/ready returned 503 (pre-existing signature/ready path; not a payee_line lock regression). |
| S3 non-material edit | PASS |
| S4 partial endorsement rollback | PASS |
| S5 claim association | PASS — generic `claim_id` still denied |
| S11 remaining-balance accept | PASS — `scripts/aws-s11-partial-disbursement-accept.mjs` 18/18 |

S2/S3/S4/S5/S11 remain CLOSED. Not reopened.

## Cleanup

S14 synthetics deleted. Prior leftover ingest rows `7a7b6a07-…`, `eb0696a2-…`, `96fb3132-…` deleted. Phase1 regression leftovers `5fcfb1f2-…`, `1425da38-…`, `61cf9d6a-…` deleted. Four billing-protected leftovers untouched. Temporary stamp/cleanup Lambdas deleted.

## Production

Not modified. Live SHA remains `dplSPx8YJoYbkolr2c6mKersDAV7OCzHt5y3UyIOdoc=`.

**S14 is ready for a later explicit production-promotion request.** Do not promote from this document.
