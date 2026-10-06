# Invoice Recovery — Freedom sandbox merchant UAT (STOP)

**STOP before Tests 1–6.** No Invoice Recovery code change. No Lambda / SPA /
SQL / RLS / IAM / Cognito / Release Lock / Deployment Guard / Security
Hardening change. No production provider mutation. No fabricated
`payment_provider_accounts` row. No sandbox merchant was created.

Inspected `2026-10-06T19:24Z`.

## 1 — Freedom-authenticated read: BLOCKED

Required first step: read Freedom
`2eff5f1a-929d-4ce3-9a8b-cd96b98df42a` `payment_provider_accounts` as
`mcarletta@freedomadj.com`.

This Cloud Agent does **not** have that session.

| Check | Result |
|---|---|
| `localStorage['checksops.aws.staging.auth']` | **absent** |
| `/payments` | unauthenticated fail-closed **Organization Not Found** |
| `/identity/me` | not called (no token) |
| Outlook mailbox | `claims@freedomadj.com` (cannot read `mcarletta@` OTP) |
| EMAIL_OTP started this run | **no** |
| Leftover isolation JWTs | **not used** |
| Leftover 2026-10-05 `mcarletta` EMAIL_OTP challenge | `completed:false`; not resumed |
| `checksops_admin` table-owner SELECT | **not used** (not Freedom-authenticated) |

Therefore these Freedom mappings are **not conclusively live-proven** this
run:

| Mapping | Live Freedom-authenticated result |
|---|---|
| Moov production `payment_provider_accounts` row | **unproven** |
| Moov sandbox row | **unproven** |
| `provider_account_id` (redacted) for each | **unproven** |
| environment / status | **unproven** |

Official historical evidence (not a live table-owner proof, not restore
authority): Freedom/C1C restored mappings are `environment=production`.
Invoice Recovery’s 409 as the operator in Freedom is consistent with **no
visible sandbox `provider_account_id`**.

Because the sandbox row was not live-proven absent *or* present as a
Freedom member, this run **did not create another** merchant.

## 2 — Existing supported sandbox onboarding path

Supported mechanism: live `POST /functions/v1/moov-account-create`
(`accountCreate` in `providers/parity/moov-functions.mjs`). UI
`PaymentAccountPanel` / `TenantPaymentAccountPanel` call the same function.

Do **not** use the Payments UI “Set up” button as the sole writer: it
skips create when `readTenantPaymentAccount` already sees
`tenants.moov_account_id` or an **unscoped** provider row (production).
That would open KYB onboard against a missing sandbox row. The API
create is the supported writer.

`accountCreate` isolation (current live source / owned hash
`moov-functions.mjs` `a8e94a69…`):

| Condition | Proven? | Evidence |
|---|---|---|
| Writes only Freedom `environment='sandbox'` Moov mapping | **yes** | INSERT values `provider='moov', environment='sandbox'`. Pre-check is `loadMoovAccount(..., 'sandbox')`. |
| Cannot overwrite Freedom production provider-account row | **yes** | `ON CONFLICT (tenant_id, provider, environment)` — unique key includes environment. Production row is a different key. |
| Cannot change `tenants.moov_account_id` | **yes** | No `UPDATE public.tenants` in `accountCreate`, `moov-sync`, or `accountOnboard`. Repo-wide AWS handler search has no `SET moov_account_id` on `tenants`. |
| Cannot enable production financial flags | **yes** | Handler does not write Lambda env. Current flags stay `EXECUTION=false`, `MOOV=false`. |
| Cannot initiate real-money movement | **yes** | `POST /accounts` with sandbox credentials from `moovParityContext`. No transfer / ACH / wallet / sweep. |
| No Lambda / SPA / SQL / RLS / IAM / Cognito / lock / guard change | **yes** | Existing live handler. `requireAdmin` is Freedom **owner/admin** (or platform admin), not a role remap. |

`moov-sync` updates `payment_provider_accounts WHERE id = $1` using the
**sandbox row UUID** from `loadMoovAccount(..., 'sandbox')`. It cannot
address the production row.

Side effect (disclosed, not a production provider-account write): trigger
`trg_sync_provider_stakeholder_acct` may INSERT/UPDATE
`stakeholder_accounts` keyed by `(tenant_id, provider, provider_environment)`.
A new sandbox row with default `can_receive_payments=false` can cause the
trigger to re-select an existing `can_receive_payments=true` production
account and refresh the **production-environment stakeholder** row with
the same production IDs (`updated_at` would change). That is **not** a
mutation of `payment_provider_accounts` production and does **not** write
`tenants.moov_account_id`. It is why a before/after snapshot of both
provider-account rows is required if create is later authorized with a
Freedom session.

## 3 — Create result

**Not executed.**

Isolation of `moov-account-create` is proven in source. Invoking it still
requires a live Freedom owner/admin Cognito token plus
`body.tenant_id=2eff5f1a-…`. This agent does not have that token.
Fabricating a row, using isolation JWTs, completing the stale Oct 5 OTP,
or connecting as `checksops_admin` to INSERT were all refused.

## 4 — Post-onboard readback

**Not applicable.** No sandbox merchant was created. Production mapping
was not written.

## 5 — Flags / staging sandbox-only

Not re-mutated. Last official inspect (19:15Z):
`AWS_PROVIDER_EXECUTION_ENABLED=false`, `AWS_MOOV_ENABLED=false`,
`AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=true`. Lambda/SPA/owned hashes
unchanged at that inspect. This run did not redeploy.

## Blocker

Freedom-authenticated read and the supported create both need
`mcarletta@freedomadj.com` **in this Cloud Agent browser** (normal
EMAIL_OTP / passkey). A session in the operator’s own browser is not
visible here.

After that session exists, the next authorized step is:

1. `/data/query` `payment_provider_accounts` for Freedom, select
   `provider, environment, onboarding_status, disabled, left(provider_account_id,8)`
   (no secrets).
2. If a sandbox row already has `provider_account_id`, **STOP** and
   diagnose `loadMoovAccount` — do not create another.
3. If not, `POST /functions/v1/moov-account-create` `{ tenant_id: Freedom }`
   only. Do not call `moov-account-onboard` / bank link / transfer.
4. Read back production + sandbox. Prove production
   `payment_provider_accounts` logically unchanged and
   `tenants.moov_account_id` unchanged. Then STOP before Tests 1–6.

## STAGING ACCEPTED?

**No.** Tests 1–6 were not started.
