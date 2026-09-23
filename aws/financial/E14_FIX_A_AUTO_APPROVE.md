# E14 Fix A — Post-process auto-approval parity

Settings persist shipped separately. Freedom production is
`auto_approve_enabled=true` / `auto_approve_max_cents=200000`. This module
restores post-process auto-approval only.

Do not call `/deposit/process` or `/deposit/approve` against existing
reference `123733567`. Do not insert another deposit to test this path.

## Auto-approval

`handleProductionCheckAltSubmit` evaluates auto-approval only after a successful
`/fincapture/deposit/process` that parks the item as `pending_approval` with the
persisted process reference. It never POSTs `/deposit/process` again and never
inserts another deposit.

Policy: tenant-over-global `auto_approve_enabled`, then a valid integer
`auto_approve_max_cents`. Clean + enabled + amount <= ceiling + persisted
reference → `/fincapture/deposit/approve` with the proven 5-attempt lock retry
(`[1500,2500,4000,6000,8000]`). Retry only on HTTP 404 + locate/locked.
Network and non-lock failures do not retry.

HTTP success and `success === true` persist local `submitted` + `approved_at`
(CheckAlt 127 / Approved). Failed or ambiguous approval stays
`pending_approval`. Flagged / over-ceiling / missing ceiling stay
`pending_approval` for Manager approval + fresh `deposit.approve` TOTP.

## NULL ceiling

NULL / blank / non-integer `auto_approve_max_cents` is
`missing_auto_approve_ceiling`. Fail closed. Legacy Lovable treated NULL as
unlimited. That behavior is not restored.

## Flags

Proven Lovable flags: non-empty `exceptions` / `warnings` / `riskFactors`, or
regex on `statusDescription` + warnings + exceptions. Also fail-closed on
non-empty `errors` or `amountDiscrepancyDetected === true`. Do not treat a
numeric `riskRating` or `riskRatingDescription` as a flag — clean production
process-40 payloads include those keys.
