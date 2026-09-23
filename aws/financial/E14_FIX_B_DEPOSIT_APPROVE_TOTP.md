# E14 Fix B — Manager deposit.approve financial TOTP

Prepared only. Do not deploy. Do not approve existing E14 deposit
`b6adc6a6-232f-4748-add3-edff3c4036d4` / reference `123733567`.

## Binding

`resolveFinancialStepUpBinding` accepts `deposit.submit` and `deposit.approve`.
Other action keys remain `action_mismatch` 409. Tenant, check, and amount are
server-derived. Browser tenant/amount are ignored. A successful TOTP writes
`financial_stepup_log` with `action_key` and `metadata.operation` equal to the
bound action.

`authorizeCheckAltProduction` now takes `actionKey`. Submit still requires
`deposit.submit`. Approve requires `deposit.approve`. A leftover submit step-up
cannot authorize approve.

## Approve path

`handleProductionCheckAltApprove` requires step-up for `approve` and fails
closed on any authz denial (including `step_up_required`). It still loads the
existing `checkalt_deposits` row, refreshes status, and POSTs
`/fincapture/deposit/approve` only when the item remains `pending_approval`.
It never inserts a deposit and never POSTs `/deposit/process`. Existing
reference stays authoritative.

## User errors

- Invalid TOTP: existing verification-code / authenticator message
- Valid TOTP + CheckAlt approve failure: `checkalt_approve_failed` mapped to
  an approval-specific message. Never an authenticator error.
