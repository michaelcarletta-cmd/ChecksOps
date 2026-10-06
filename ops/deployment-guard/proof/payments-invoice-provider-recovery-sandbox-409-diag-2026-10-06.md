# Freedom sandbox create 409 — read-only diagnose

**STOP.** No second `moov-account-create`. No discover/link/sync invoke.
No Lambda / SPA / SQL / flag / production change. No account id guessed.

Operator result (Freedom `2eff5f1a-…`, once): HTTP 409,
`error: "resource already exists"`, `already_existed: false`,
`liveProviderCalled: true`, `provider_account_id_prefix: null`.
`environment: "staging"` is Lambda `CHECKSOPS_ENV` from `index.mjs`
(error path does not set Moov `environment: 'sandbox'`).

## Root cause

`accountCreate` (`moov-functions.mjs`) called sandbox `POST /accounts`
with `foreignID = Freedom tenant UUID` and idempotency seed
`checksops-account-sandbox-${tenantId}`. Moov returned 409. `moovFetch`
throws `MoovError(message, status, body)`. `wrap()` catch uses only
`error.message` and **drops `error.body`**. Persist never ran.

Local pre-check `loadMoovAccount(..., 'sandbox')` did **not** see a
sandbox `provider_account_id` (otherwise `already_existed: true`,
`liveProviderCalled: false`). So ChecksOps has no usable sandbox
mapping, while the **sandbox Moov ledger** already has a conflicting
resource (most consistent with an account already using that
`foreignID`; idempotent replay of the same POST usually returns 200 +
original account, not 409). Production `(moov, production)` was not
queried and was not written.

## Freedom `payment_provider_accounts` (from this 409, not table-owner)

| Row | Determination |
|---|---|
| `(moov, sandbox)` with `provider_account_id` | **absent** (or null id) |
| `(moov, production)` | **not read** this run; official restore docs still label Freedom production; this 409 is sandbox-ledger only |

## Existing paths — none are a safe live reconcile

| Path | Live AWS behavior | Safe to use now? |
|---|---|---|
| `moov-account-create` | No 409 adopt. Do not call again. | **no** |
| `moov-sync` | Requires sandbox `provider_account_id`; otherwise `{ status: 'not_started' }`. No list/adopt. Updates that sandbox row UUID only. | **no** — nothing to sync |
| `moov-account-discover` | **Aliased to `selftest`**. `GET /accounts` then returns `listed_ok` only — **discards account ids**. | **no** |
| `moov-account-onboard` / bank / transfer | Need sandbox id; money/KYB. | **no** |
| Supabase `moov-account-discover` link / `moov-sync` auto-adopt / `moov-account-create` persist | Not the live AWS handlers. Link/adopt **UPDATE `tenants.moov_account_id`**. | **no** — would violate isolation even if reachable |

## 409 body

`MoovError.body` may contain `accountID` / conflict field. Current
wrapper does not return it. This run therefore **cannot name** the
existing sandbox account.

## Missing capability

A live AWS **read-only** lookup that returns the sandbox account whose
`foreignID` (or equivalent) is Freedom `2eff5f1a-…`, then a persist that
upserts **only** `(tenant=Freedom, provider=moov, environment=sandbox)`
and does **not** write `tenants.moov_account_id`, production provider
rows, flags, wallets, banks, or transfers. That persist does not exist
on live AWS today.

`SANDBOX_MOOV_RECONCILIATION_READY: NO`
