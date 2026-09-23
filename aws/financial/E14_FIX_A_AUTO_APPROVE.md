# E14 Fix A — Post-process auto-approval parity + Settings persist

Prepared only. Not deployed. No CheckAlt provider calls. Existing deposit
`b6adc6a6-232f-4748-add3-edff3c4036d4` / reference `123733567` / `$1,546.72` /
`pending_approval` is untouched.

## Auto-approval

`handleProductionCheckAltSubmit` evaluates auto-approval only after a successful
`/fincapture/deposit/process` that parks the item as `pending_approval` with a
reference. It never POSTs `/deposit/process` again.

Policy: tenant-over-global `auto_approve_enabled`, then integer-cent
`auto_approve_max_cents`. Clean + enabled + amount <= ceiling →
`/fincapture/deposit/approve` with the proven 5-attempt lock retry
(`[1500,2500,4000,6000,8000]`). Flagged / over-ceiling / missing ceiling stay
`pending_approval`. Success persists `submitted`, `approved_at`, and
`last_status_payload._auto_approve`.

## NULL ceiling

NULL / blank / non-integer `auto_approve_max_cents` is `missing_auto_approve_ceiling`.
This is fail-closed. Legacy Lovable treated NULL as unlimited. Isolated Freedom
production is currently `enabled=true` with NULL cents while the operator intends
$2,000. Unlimited auto-approval is therefore refused until Settings persists
`200000`.

## Settings persist root cause

`save_checkalt_tenant_auto_deposit` is classified `safe_now` but
`handleSafeWriteRpc` enabled it only when
`AWS_APPLICATION_WORKFLOW_WRITES_ENABLED === 'true'` (T5, default false).
Production endorsement writes use `AWS_WRITES_ENABLED`. SQL 38
(`aws_save_checkalt_tenant_auto_deposit`) exists and is the persist path; it was
never reached. The missing `checkalt_tenant_auto_deposit_public` view is already
rewritten to `checkalt_tenant_accounts` on read.

Fix: `CHECKALT_SETTINGS_RPCS` (`save_checkalt_settings`,
`save_checkalt_tenant_auto_deposit`) are gated by `AWS_WRITES_ENABLED`, same as
session/endorsement writes. Other T5 workflow RPCs stay behind the T5 flag.
TenantAutoApproveCard converts `$2,000` → `200000` cents and fails the save
unless a reload echoes the same integer cents.

Do not write `200000` as a one-off SQL update. After this ships, an operator
saves `$2,000` through Settings; acceptance is the echoed `200000` on reload.
