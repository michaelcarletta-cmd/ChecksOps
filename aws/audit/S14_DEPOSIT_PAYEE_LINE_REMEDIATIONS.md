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

Filled after overlay.

## Production

Not modified. Do not promote from this document until an explicit production-promotion request.
