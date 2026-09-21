# Tenant Management — staging human-acceptance corrections

STAGING ONLY. No production. No monthly ACH. No Moov transfer POST.
No wallet funding/payout. No CheckAlt financial execution. No Sweep.
M7.12 remains frozen.

This is the business-acceptance matrix after the 2026-09-21 human
corrections. It replaces the earlier “Partner Code editable” and
“custom sending subdomain outstanding” rows.

## Partner Code

| Check | Result |
| --- | --- |
| READ | PASS — displayed on Company and tenant list; searchable |
| EDIT | NOT ALLOWED BY DESIGN |
| SAVE | NOT ALLOWED BY DESIGN |
| PERSISTENCE | Permanent existing value |

Authoritative column: `public.tenants.partner_code`.

Enforcement on the normal Tenant Management path:

- UI is `readOnly`. Save payloads omit `partner_code`.
- `WRITE_ALLOWLIST.tenants.columns` does not include `partner_code`.
- `WRITE_ALLOWLIST.tenants.clientIgnored` includes `partner_code`.
- `executeTenantsNarrow` deletes `out.partner_code` before UPDATE.

INSERT still mints a code via `assign_tenant_partner_code` when empty.
Tenant Management must not regenerate an assigned code.

Staging note: `trg_assign_tenant_partner_code` is present, but the live
function is the INSERT-mint version. `checksops` cannot
`CREATE OR REPLACE` it (`permission denied for schema public`). A raw
SQL UPDATE as `checksops` can still change a code. The TM UI and the
normal AWS write executor cannot.

Acceptance tenants after restore:

- Pipeline Test `3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43` → `B3136BC9`
- Freedom `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a` → `DF9CC985` (never changed)

## Custom sending subdomain

**NOT REQUIRED BY CURRENT BUSINESS DESIGN.**

Not an outstanding Tenant Management parity defect.

Do not enable `AWS_TENANT_EMAIL_DOMAIN_ENABLED` for Lovable parity.
Do not spend more work restoring SES create/verify.

Required email administration remains on `public.tenant_email_settings`:

- sender / display identity (`from_name`)
- Reply-To (`reply_to`)
- email branding plus tenant/company branding on the same settings row

## Standard Check Rate

Authoritative field: `public.tenants.per_check_rate_cents`.

Do not create a second rate column.

| Check | Result |
| --- | --- |
| READ | PASS |
| EDIT | PASS after fix (input is no longer `disabled={!enabled}`) |
| SAVE | writes `{ per_check_billing_enabled, per_check_rate_cents }` |
| PERSIST | VPC probe Pipeline Test `0 → 400 → 0`; Freedom stayed `400` |

Root cause of the human failure: BillingTab disabled the Standard Check
Rate input whenever `per_check_billing_enabled` was false. Pipeline Test
has billing off, so Michael could not type a rate. The AWS allowlist and
`executeTenantsNarrow` already accepted `per_check_rate_cents`.

Billing calculations use `tenants.per_check_rate_cents` for the displayed
unit rate and `check_billing_events.unit_price_cents` for historical totals.

## Disbursement usage — two rates

Do not collapse into one generic “payment processed” charge.

| Option | Field | Rate |
| --- | --- | --- |
| Same-day | `disbursement_splits.requested_speed` else `disbursement_batches.delivery_speed` = `same_day` | $1.00 (100¢) |
| Next-day | same COALESCE = `next_day` | $0.75 (75¢) |

Source of the mapping (not UI copy): `DisbursementConsole` / `RunPayrollDialog`
`SPEED_FEES` and `src/lib/financial/model.ts` `disbursementFeeHigh` / `Low`.

Count billable split statuses only:
`pending`, `submitted`, `processing`, `completed`, `settled`, `paid`.
Failed / voided / `standard` leftovers are excluded.

`payment_transfers` are volume only. They are not added again as a fee.
`check_billing_events` has no `moov_*` rows on Freedom 2026, so those
events are not a second disbursement total.

Sandbox / test: Pipeline Test is `is_test_account=true` and
`moov_environment=sandbox`. Usage queries are tenant-scoped. Test-account
preview is labeled not production billable.

## Monthly vs YTD presentation

Tenant Management Billing & Usage now always shows both:

- **Current Billing Period** — selected month usage + current
  `monthly_rate_cents` / `referral_discount_cents` pricing settings
- **Year-to-Date Usage / Charges** — YTD check / mortgage / disbursement
  events. Recurring maintenance appears in YTD only when
  `tenant_maintenance_payments` records exist. The current monthly rate is
  not multiplied across prior months.

`payment_transfers` remain informational volume at $0.

## Rechecked billing model (established sources only)

Freedom September 2026 (staging snapshot, no collection):

| Source | Event / type | Count | Unit rate | Total |
| --- | --- | --- | --- | --- |
| `tenants.monthly_rate_cents` | monthly maintenance | 1 mo | $100.00 | $100.00 |
| `tenants.referral_discount_cents` | referral discount | — | −$5.00 | −$5.00 |
| `check_billing_events` | `check_processing` | 11 | $4.00 (`unit_price_cents` 400; current `per_check_rate_cents` 400) | $44.00 |
| `check_billing_events` | `mortgage_handling` | 2 | $10.00 | $20.00 |
| `disbursement_splits` + batch speed | `same_day` settled | 9 | $1.00 | $9.00 |
| `disbursement_splits` + batch speed | `next_day` billable | 0 | $0.75 | $0.00 |
| `payment_transfers` | Moov volume only | 1 completed | — | not a fee |

September preview total: **$168.00**. ACH not submitted.

Freedom 2026 YTD (same sources; maintenance is still one month when the
UI is in month scope):

| Source | Event / type | Count | Unit rate | Total |
| --- | --- | --- | --- | --- |
| `check_billing_events` | `check_processing` | 3 | $3.00 historical | $9.00 |
| `check_billing_events` | `check_processing` | 122 | $4.00 | $488.00 |
| `check_billing_events` | `mortgage_handling` | 3 | $10.00 | $30.00 |
| `disbursement_splits` | `same_day` settled | 109 | $1.00 | $109.00 |
| `disbursement_splits` | `next_day` submitted | 1 | $0.75 | $0.75 |

`mortgage_handling_requests` billed YTD = 1 × $10.00. Tenant Management
usage totals use `check_billing_events.mortgage_handling` so the request
row is not added again.

Pipeline Test September 2026: no check, mortgage, or disbursement events.
Four sandbox `payment_transfers` (3 completed, 1 planned) stay volume-only
and are not production billable.

## Safety

| Item | Status |
| --- | --- |
| Production changed | NO |
| Money moved | NO |
| M7.12 changed | NO |
| `AWS_TENANT_EMAIL_DOMAIN_ENABLED` | false |
| Transfer POST / Moov / CheckAlt execution | unset / false |
