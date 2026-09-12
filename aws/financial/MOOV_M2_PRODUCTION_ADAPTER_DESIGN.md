# MOOV PRODUCTION READINESS — PHASE M2

**LIVE ACCOUNT TRUTH + AWS PRODUCTION ADAPTER DESIGN.**

**STOP FOR REVIEW.** This phase does **not** authorize Moov activation, secret creation, credential load, webhook redirect, Lovable shutdown, or any transfer.

Prepared: 2026-09-09  
Base: current `main` `0c2daf38` (after PR #183).  
M1 verdict accepted: **NO-GO for production Moov activation.**

Companion: `aws/financial/MOOV_M2_PRODUCTION_READINESS.md` (17-point STOP report), `aws/financial/MOOV_PRODUCTION_SECRET_CONTRACT.md`, `aws/financial/results/moov_m2_live_probes.json`.

## What this phase did not do

- Did not set `AWS_MOOV_ENABLED`, `AWS_PROVIDER_EXECUTION_ENABLED`, or `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`
- Did not create or load production provider secrets
- Did not create or modify Moov accounts, KYC/KYB, or bank links
- Did not initiate ACH, create a transfer, or move money
- Did not redirect webhooks
- Did not disable Lovable production functions
- Did not implement M3 adapter files (design only)

Live HTTP this phase: public `GET` on staging `/sandbox/status`, `/providers/status`; CloudFront `https://checksops.com/prep/providers/status`. No Moov API. No production writes.

---

## 1. Freedom Moov production account — read only

### PROVIDER CREDENTIAL BLOCKER

Live Moov `GET /accounts/{id}` was **not performed**.

| Reason | Evidence |
| --- | --- |
| Instruction | Do not load Moov production credentials |
| AWS staging | `MOOV_PUBLIC_KEY_configured: false`, `MOOV_SECRET_KEY_configured: false`, `productionKeysPresent: false` |
| AWS production-prep | every `MOOV_*` name **MISSING**; `PROVIDER_SECRETS_ARN` unset |
| Lovable | this agent still cannot resolve `*.supabase.co`; live Edge Function probe skipped |

**Restored RDS is secondary evidence only.** It is a copy of production rows, not a live Moov capability read. Last local snapshot: Tranche 4 (`TRANCHE_4_RESULTS.md`) + UAT isolation (`UAT_RESULTS.md` / `SANDBOX_RESULTS.md`).

| Question | Live Moov | Restored RDS (secondary) |
| --- | --- | --- |
| Production Moov account exists | **UNKNOWN** (credential blocker) | **YES** — Freedom `payment_provider_accounts.id` `60922058-7eca-4889-81dd-5720d7b9de96`, `environment=production` |
| Account ID present | **UNKNOWN** | ChecksOps row id present. Moov `provider_account_id` exists on the row (not printed). |
| Account type | **UNKNOWN** | Tenant create path is business connected-account. Not re-read. |
| Identity verification / KYC | **UNKNOWN** | T4 local readiness **pending** |
| Business / KYB | **UNKNOWN** | Same |
| ToS accepted | **UNKNOWN** | T4 pending can include ToS |
| Wallet exists | **UNKNOWN** Freedom-specific | **1** `payment_wallets` row across **3** production Moov accounts |
| Wallet status / available / pending | **UNKNOWN** | Ledger aggregate `payment_wallet_ledger_amount_cents = 0` |
| Bank account exists | **UNKNOWN** | **2** `payment_provider_methods` globally; Freedom last4 **UNKNOWN** |
| Bank verified | **UNKNOWN** | T4 pending |
| ACH credit (`send-funds`) | **UNKNOWN** | Transfer-create requires `can_send_payments` |
| ACH debit (`collect-funds`) | **UNKNOWN** | Requires `can_ach_debit` |
| `wallet.balance` | **UNKNOWN** | |
| Same-day ACH | **UNKNOWN** | Rail router can select `ach-credit-same-day` when methods exist |
| Remaining requirements | **UNKNOWN** | Last snapshot **pending** / Aug 2026 plan `action_required` (stale) |
| Usable as sender today? | **UNKNOWN** — treat as **NO** until a live GET shows `onboarding_status=active`, ToS, verified bank, `send-funds.ach` enabled | Not proven |

C1C also has a production Moov row (`817e1bf0-e1f7-4e9e-95a8-ce15bfa31708`). Do not use as first-test destination.

Restored counts (rehearsal / first copy): `payment_provider_accounts` 3, `payment_provider_methods` 2, `payment_wallets` 1, `external_payment_recipients` 3, `stakeholder_accounts` 67 (mostly non-Moov), `payment_transfers` amount **0**.

Operator M2 follow-up (outside this agent): Moov dashboard or a **read-only** `GET` with already-held production keys. Do not mint keys for this.

---

## 2. Production secret contract — names only

See `aws/financial/MOOV_PRODUCTION_SECRET_CONTRACT.md`.

**Exact names current production code uses:**

Required: `MOOV_PUBLIC_KEY`, `MOOV_SECRET_KEY`, `MOOV_PLATFORM_ACCOUNT_ID`, `MOOV_WEBHOOK_SECRET`, `MOOV_ENVIRONMENT`, `MOOV_ALLOWED_ORIGIN`.

**Do not treat `MOOV_ACCOUNT_ID` as the facilitator.** That name exists only on the AWS inventory list. Tenant account ids are RDS `provider_account_id`.

Availability now:

| Name | AWS staging | Production-prep | Lovable runtime |
| --- | --- | --- | --- |
| Production `MOOV_PUBLIC_KEY` / `SECRET_KEY` | **MISSING** | **MISSING** | **UNKNOWN** |
| `MOOV_PLATFORM_ACCOUNT_ID` | not in staging `configuredFlags`; sandbox platform id **PRESENT** | **MISSING** | **UNKNOWN** |
| `MOOV_WEBHOOK_SECRET` | production name **MISSING** | **MISSING** | **UNKNOWN** |
| `MOOV_ENVIRONMENT` | **MISSING** | **MISSING** | **UNKNOWN** |
| `MOOV_ALLOWED_ORIGIN` | sandbox origin **PRESENT** | **MISSING** | **UNKNOWN** |
| `MOOV_ENABLED` | n/a (AWS uses `AWS_MOOV_ENABLED=false`) | n/a | **UNKNOWN** |

Do not create the secret. Do not copy sandbox values.

---

## 3. AWS production Moov adapter design

Mirror CheckAlt dark production: isolated module, **no** sandbox fallback.

### Files (M3 — not created this phase)

| File | Role |
| --- | --- |
| `aws/functions/api/providers/production/moov-holds.mjs` | `productionMoovExecutionAllowed()` — all holds lifted **and** sandbox flag **false** |
| `aws/functions/api/providers/production/moov-secrets.mjs` | Load **only** production names; refuse sandbox keys / staging origin |
| `aws/functions/api/providers/production/moov-authz.mjs` | Server TOTP / dual-control for `disbursement.send` |
| `aws/functions/api/providers/production/moov-idempotency.mjs` | Persist-before-HTTP + claim + reconcile |
| `aws/functions/api/providers/production/moov-config.mjs` | Load Freedom/tenant account + methods from RDS `environment='production'` |
| `aws/functions/api/providers/production/moov-client.mjs` | OAuth + `x-moov-version: v2024.01.00` + Origin; production keys only |
| `aws/functions/api/providers/production/moov-read.mjs` | Account / caps / banks / wallet GET (still behind holds for live HTTP) |
| `aws/functions/api/providers/production/moov-transfer.mjs` | Transfer create + status |
| `aws/functions/api/providers/production/moov-reconcile.mjs` | Poll by `provider_transfer_id` or Moov idempotency; never second POST |
| `aws/functions/api/providers/production/moov-webhook-apply.mjs` | Production-row apply **only** when dry-run is off **and** holds allow |
| `aws/functions/api/providers/production/moov-dispatch.mjs` | Wired like `checkalt-dispatch.mjs` |

### Routes

| Route | First-transfer need | Behavior with flags false |
| --- | --- | --- |
| `POST /functions/v1/moov-readiness` | Read | Production handler returns `null` → existing sandbox/stub. After M3, production read may stay hold-gated. |
| `POST /functions/v1/moov-transfer-status` | Poll | Same |
| `POST /functions/v1/moov-transfer-create` | First test POST | Fail closed until holds lifted |
| `POST /functions/v1/moov-disburse` | Later | Same + persist-before-HTTP |
| `POST /webhooks/moov` | Dual-run later | Verify + receipt; `applied: false` while dry-run |
| `POST /financial/moov-dual-control` | Authz | Record-only, like CheckAlt; not money |

Do **not** reuse `parity/moov-*.mjs` with a credential swap. Parity binds `productionPublicKey: null` and forces `environment: 'sandbox'`. Production dispatch must run **before** `runParityHandler`, and `productionMoovAmbiguousMode()` (prod flags + sandbox both true) → `409 ambiguous_execution_mode`.

### Hold predicate (fail closed before HTTP)

Mirror `productionCheckAltExecutionAllowed()` in `checkalt-holds.mjs`:

```
productionMoovExecutionAllowed =
  executionAllowed('moov')   // AWS_PROVIDER_EXECUTION_ENABLED && AWS_MOOV_ENABLED
  AND financialPermissionsActivated()
  AND !providerSandboxExecutionEnabled()
```

`runProductionMoovHandler` must be wired in `providers.mjs` **before** the `executionAllowed` hard-block (same slot as CheckAlt). When holds are false, the dispatcher returns `null` so sandbox/UAT parity can still run. The production module itself **never** loads `MOOV_SANDBOX_*` and never falls back to sandbox HTTP.

Ambiguous mode (`executionAllowed('moov')` and financial permissions **and** sandbox execution all true) → `409 ambiguous_execution_mode`, no HTTP.

Today every production conjunct is false; staging has `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=true` → production path **unreachable**. Correct.

If flags are false: no OAuth, no GET, no POST from the production module.

### Required operations

| Operation | Moov HTTP | RDS |
| --- | --- | --- |
| Account / readiness read | `GET /accounts/{id}`, capabilities, bank-accounts | Update `payment_provider_accounts` only when holds allow; first test may read-only |
| Wallet / balance read | wallets + payment-methods | `payment_wallets` |
| Recipient / method validation | payment-methods GET if rails stale | `external_payment_recipients` / `stakeholder_accounts` + `payment_provider_methods` |
| Transfer create | `POST /accounts/{MOOV_PLATFORM_ACCOUNT_ID}/transfers` integer cents | persist intent first |
| Transfer status | `GET /accounts/{facilitator}/transfers/{id}` | write-back status |
| Reconciliation | GET only | report + fill `provider_transfer_id` if known |
| Webhook apply | none | receipts always; financial apply later |

Pin `v2024.01.00`. Amount `{ currency: "USD", value: <integer cents> }`. `X-Idempotency-Key` = UUID derived from ChecksOps transfer row id.

---

## 4. Server-side financial authorization

Port CheckAlt (`checkalt-authz.mjs`) to Moov. React `guardFinancial()` is **not** authority.

Chain for a disbursement / first test transfer:

1. Cognito → `identity_accounts.application_user_id` (never Cognito `sub`, never `x-user-id`)
2. Tenant membership of the **resource** (batch / transfer tenant from RDS, not body `tenant_id`)
3. Role in `{owner, admin, manager}` — `operator` / `staff` denied
4. Current server-side payment: `disbursement_batches` or a dedicated `payment_transfers` intent row
5. Server-derived recipient: split `stakeholder_account_id` / `destination_recipient_id` owned by that tenant
6. Server-derived `amount_cents` from split `amount` or from a pre-inserted intent row — **reject** body `amount` / `amount_cents` / `tenant_id` / Moov ids / payment-method ids
7. `operation = disbursement.send` (first adhoc test uses the same action key bound to the intent id)
8. Fresh Cognito TOTP in `financial_stepup_log` (TTL 30 minutes) **or** dual-control from a **distinct** owner/admin/manager, both bound to `{tenant_id, resource_id, amount_cents, action_key}`
9. `productionMoovExecutionAllowed()`
10. Provider HTTP

Browser must not authorize: tenant, sender, recipient, destination bank, amount, Moov account, payment method.

First-test binding: because there may be no check, bind TOTP to `resource_id = payment_transfers.id` (or `disbursement_splits.id`) plus `amount_cents`. Changing amount or destination invalidates step-up. No tenant-wide TOTP fallback.

`evaluateFinancialAuthorization().canExecuteProduction` stays **false**. Moov uses a separate `canExecuteProductionMoov` like CheckAlt.

---

## 5. Idempotency — before HTTP

Current `moov-disburse` POSTs then writes `disbursement_splits.moov_transfer_id`. **Insufficient.**

`moov-transfer-create` inserts `payment_transfers` `ready` then POSTs, but does not COMMIT/claim `provider_http_attempted_at`. A timeout + retry can double-POST if Moov idempotency is missed.

### Durable intent (M3)

Reuse `payment_transfers` (`environment='production'`). Add (SQL, not applied this phase):

- `provider_http_attempted_at timestamptz`
- `failure_class text`
- status includes `queued` / `submitting` (keep `ready` as alias)

Unique already: `(tenant_id, idempotency_key)` and `(provider, environment, provider_transfer_id)` where id not null.

Idempotency key:

```
sha256(tenant_id | moov_transfer | resource_id | amount_cents | USD | destination_method_id)
```

`resource_id` = `disbursement_splits.id` or first-test `adhoc:{purpose}`.

### Sequence

1. Authorize (section 4)
2. `INSERT payment_transfers` status `queued`, `provider_http_attempted_at` null, `provider_transfer_id` null
3. Unique violation → load existing → if HTTP already attempted or provider id present → **replay / reconcile, no POST**
4. `COMMIT`
5. Compare-and-set: `UPDATE … SET status='submitting', provider_http_attempted_at=now() WHERE id=? AND provider_http_attempted_at IS NULL AND provider_transfer_id IS NULL` — only the claimant POSTs
6. Moov POST with `X-Idempotency-Key` = UUID(`checksops-transfer-{id}`)
7. Persist `provider_transfer_id` + status
8. All other arrivals poll/reconcile

### Case matrix

| Case | Behavior |
| --- | --- |
| Double click | Unique key / existing row → replay |
| Simultaneous requests | One insert; loser 23505 → replay; one claimant |
| Lambda retry | Same key; if `provider_http_attempted_at` set → GET/reconcile |
| Network timeout | Attempt stamped → no second POST |
| Moov accepts, RDS update fails | Row `submitting`; poll by Moov idempotency / list; fill id; **no POST** |
| RDS succeeds, response lost | Retry sees `provider_transfer_id` or attempt stamp → GET |
| Webhook before API response | Apply by Moov transfer id / metadata `checksops_transfer_id`; duplicate receipt ignored |
| Poll before provider reference | If attempt stamped, poll facilitator transfers by metadata; if never attempted, claimant may POST |

No uncontrolled duplicate path: claimant CAS + Moov idempotency header + unique provider id.

Template: `commitDurableAttempt()` / `shouldReconcileInsteadOfPost()` in `checkalt-idempotency.mjs`. First live test **must** use this path, not raw `moov-disburse`.

### Automated test design (must exist before first live POST)

No test may use production credentials or move money. Sandbox/local fixtures only.

| Test | Assert |
| --- | --- |
| Double click | Two sequential `create` with the same `Idempotency-Key` → one `payment_transfers` row, one HTTP (second is poll/replay). |
| Simultaneous requests | Two concurrent Lambdas → one CAS winner; loser `409 duplicate_in_flight` or poll. |
| Lambda retry | After 504, retry same key → no second POST if `provider_http_attempted_at` is set. |
| Network timeout | Claimant set, HTTP aborted → reconcile GET, never second POST. |
| Moov accepts, RDS update fails | Reconcile by `X-Idempotency-Key` / transfer list fills `provider_transfer_id`. |
| RDS succeeds, response lost | Retry sees attempt stamp or provider id → GET, do not POST. |
| Webhook before API response | Receipt insert; apply skipped until the transfer row exists. |
| Poll before provider reference | Returns `queued` / `submitting` / `pending`; never creates a new transfer. |

---

## 6. Stakeholder / recipient production design

### Inventory (Lovable → AWS)

| Step | Production today | AWS today |
| --- | --- | --- |
| Stakeholder invite | `AddExternalStakeholderDialog` → `moov-recipient-create` | Sandbox + Cognito |
| Public onboarding link | `/pay-setup/:token` → `moov-recipient-session` (no JWT) | Cognito wrap — **broken for payees** |
| KYC | `moov-recipient-kyc-update` | Sandbox only |
| ToS | `moov-recipient-tos-accept` | Sandbox only |
| Bank linking | `moov-recipient-bank-add` (collect-funds, not send-funds) | Sandbox only |
| Capability / readiness | `moov-sync` / webhook | Sandbox GET |
| Eligible for payment | `can_receive` + connected method | Sandbox rows |

### Split

| Class | Work |
| --- | --- |
| **A. First controlled transfer** | An **already-existing** Freedom-controlled verified destination payment method. No new onboarding. Confirm via live GET / dashboard (credential blocker now). If none exists, first **send** test is blocked — do not onboard in M2/M3. |
| **B. Broad customer rollout** | Public token session without Cognito; KYC/ToS/bank on AWS production; webhook apply to production recipient rows; email invite; Plaid bridge optional |
| **C. Later** | Bulk import, invoices, disconnect, platform bank, fee plans, sweeps |

Restored RDS: 3 `external_payment_recipients`, 67 `stakeholder_accounts` (mostly legacy). **No verified Freedom Moov recipient confirmed.** Prefer Freedom’s **own** verified bank as destination only if Moov allows credit to a method on the same connected account; otherwise require a distinct verified recipient row. Do not use C1C. Do not onboard anyone this phase.

---

## 7. Legacy Lovable Moov path

AWS flags do **not** gate Supabase. Production SPA (`VITE_AUTH_PROVIDER` unset) invokes Lovable.

| Function | Money? | AWS-flag independent? | Status |
| --- | --- | --- | --- |
| `moov-transfer-create` | ACH/RTP send | Yes, if `MOOV_ENABLED` + allowlist + keys | **UNKNOWN** live / **REACHABLE** in code |
| `moov-disburse` | ACH credit | Yes; **internal path skips `MOOV_ENABLED`** | **UNKNOWN** / **REACHABLE** |
| `initiate-wallet-funding` | ACH collect | Yes | **UNKNOWN** / **REACHABLE** |
| `calculate-payment-funding` | Calc only | Yes | **REACHABLE** (no POST) |
| `process-funded-payment` | Invokes disburse | Service-role header | **UNKNOWN** / **REACHABLE** |
| `moov-webhook` | Apply + funded disburse | HMAC; `verify_jwt=false` | **UNKNOWN** / **REACHABLE** |
| `moov-wallet-fund` / `wallet-fund-on-clear` | ACH collect | Yes | **UNKNOWN** / **REACHABLE** |
| `moov-tenant-fee-charge` | Fee transfer | Platform admin | **UNKNOWN** / **REACHABLE** |
| `moov-fee-schedule-upsert` / `moov-sweep-config` | Recurring / sweeps | Config now, money later via Moov | **UNKNOWN** / **REACHABLE** |
| `homeowner-deductible-pay` | ACH collect | Ledger token + `MOOV_ENABLED` | **UNKNOWN** / **REACHABLE** |
| `moov-recipient-create` / session / KYC / ToS / bank | No ACH POST (bank add not send) | `MOOV_ENABLED` | **UNKNOWN** / **REACHABLE** for onboarding |
| AWS `/functions/v1/moov-*` production | | Flags false | **DISABLED** |

**DISABLED** means AWS production path. Lovable is not disabled.

### Where production credentials live (names only)

| Runtime | Names | Presence |
| --- | --- | --- |
| Supabase Edge secrets | `MOOV_PUBLIC_KEY`, `MOOV_SECRET_KEY`, `MOOV_PLATFORM_ACCOUNT_ID`, `MOOV_WEBHOOK_SECRET`, `MOOV_ENVIRONMENT`, `MOOV_ALLOWED_ORIGIN`, `MOOV_ENABLED` | **UNKNOWN** |
| `checksops/staging/providers` | `MOOV_SANDBOX_*` | **PRESENT**; production names **MISSING** |
| `checksops/production/providers` | intended production names | **UNKNOWN** existence; production-prep does not load it |
| Production-prep Lambda env | none | **MISSING** |

### Defense-in-depth shutdown (do not execute)

1. **SPA:** production AWS frontend (`VITE_AUTH_PROVIDER=cognito`) so `functions.invoke` hits AWS, not `*.supabase.co`.
2. **Lovable fail-closed even if invoked:** set `MOOV_ENABLED=false`; keep allowlist; webhook still verifies but must not call `process-funded-payment` once AWS owns apply (code change, later).
3. **Rotate/remove** `MOOV_PUBLIC_KEY` / `MOOV_SECRET_KEY` / `MOOV_WEBHOOK_SECRET` from the Supabase project **after** AWS production secret is loaded and dual-run is done.
4. Last: Moov dashboard webhook URL → AWS `/webhooks/moov`.

Do not run 1–4 now.

---

## 8. Webhook / reconciliation migration

Do not redirect the Moov dashboard.

| Stage | AWS `/webhooks/moov` | Lovable `moov-webhook` | Apply |
| --- | --- | --- | --- |
| **Now** | Verify (staging fixture or absent prod secret) + receipt; dry-run; skip `environment='production'` | Production apply | Lovable only |
| **M3 dark** | If prod webhook secret later present: verify + receipt only (`AWS_PROVIDER_WEBHOOK_DRY_RUN=true`) | Unchanged | `applied: false` |
| **Dual-run** (later GO) | Same; log mismatches vs RDS | Still authoritative apply | AWS must not double-apply |
| **Cut apply** (later GO) | Idempotent apply to production `payment_transfers` by `provider_transfer_id` / metadata | Disabled or fail-closed | Tenant from RDS mapping; ignore payload `tenant_id` |
| **Poll fallback** | `moov-transfer-status` / reconcile | optional | After timeout / missing webhook |

Rules: unique `(provider, external_event_id)`; duplicate → `duplicate=true`, no re-apply; out-of-order: ignore if local status is already later; never POST because a webhook arrived.

---

## 9. First live test (do not execute)

| Field | Design |
| --- | --- |
| Sender | Freedom connected account only |
| Recipient | Freedom-controlled **already verified** Moov method. If none, **do not onboard** — test blocked |
| Amount | **1 cent** (`amount.value = 1`). Staging `/sandbox/status` documents `sandboxMinCents: 1`. If the originating bank rejects, **100 cents**. Not a real claim batch |
| Auth | Freedom owner/admin/manager + fresh TOTP bound to intent id + 1 |
| Path | AWS `moov-transfer-create` production module (persist → COMMIT → CAS → POST). Not `moov-disburse` |
| Persist | `payment_transfers.provider_transfer_id` |
| Poll | GET facilitator transfer |
| Reconcile | webhook receipt (dry-run OK for first) + GET |
| Retry | If uncertain, GET only |

AWS flags stay **false** until a **separate** human GO. Implementing the dark module (M3) is not that GO.

---

## 10. Return matrix

| # | Item | Result |
| --- | --- | --- |
| 1 | Freedom live production account | **PROVIDER CREDENTIAL BLOCKER.** RDS secondary: row exists, production-labeled |
| 2 | KYC / KYB | **UNKNOWN** live; RDS snapshot **pending** |
| 3 | ToS | **UNKNOWN** live |
| 4 | Wallet | **UNKNOWN** live; 1 wallet among 3 accounts |
| 5 | Bank | **UNKNOWN** live; 2 methods globally |
| 6 | ACH send / collect / same-day | **UNKNOWN** live |
| 7 | Production credential availability | AWS **MISSING**. Lovable **UNKNOWN** |
| 8 | Exact secret names | `MOOV_PUBLIC_KEY`, `MOOV_SECRET_KEY`, `MOOV_PLATFORM_ACCOUNT_ID`, `MOOV_WEBHOOK_SECRET`, `MOOV_ENVIRONMENT`, `MOOV_ALLOWED_ORIGIN`. Not `MOOV_ACCOUNT_ID` as facilitator |
| 9 | Adapter files / routes | Section 3. Dispatch like CheckAlt; no sandbox fallback |
| 10 | TOTP / server authz | Port CheckAlt to `disbursement.send`; bind to server resource + `amount_cents`; ignore browser money fields |
| 11 | Transfer idempotency | Persist + COMMIT + CAS claimant + Moov idempotency; poll if attempted |
| 12 | Stakeholder for first test | **A:** existing verified Freedom destination only. **B/C:** public link KYC later. None confirmed |
| 13 | Legacy Lovable money-path | **REACHABLE** in code; live enablement **UNKNOWN**. Internal disburse bypasses `MOOV_ENABLED` |
| 14 | Webhook migration | Receipts/dry-run first; do not redirect; poll fallback |
| 15 | Code phases before first live transfer | **M3** dark adapter + authz + persist-before-HTTP + webhook receipts; **M4** operator live Freedom GET + secret **create** (human); **M5** Lovable fail-close plan; **M6** one transfer GO |
| 16 | External / provider blockers | Production keys not on AWS; cannot load them; Freedom live caps unknown; no confirmed verified recipient; Lovable still live; SQL 64 not applied (correct) |
| 17 | GO / NO-GO for **beginning M3 implementation** | **GO (dark only)** |

### M3 GO meaning

**GO** to implement the dark production module, secret **loader** (fail closed), authz, idempotency, and webhook receipt path — **flags remain false**, **do not create the secret**, **do not POST to Moov**.

**NO-GO** for activation, first live transfer, credential create/load, webhook redirect, or Lovable shutdown.

---

## Live holds rechecked (2026-09-09)

| Probe | Result |
| --- | --- |
| Staging `/sandbox/status` | `AWS_MOOV_ENABLED=false`, master execution false, financial permissions false, sandbox execution true, `productionKeysPresent: false` |
| Staging `/providers/status` | Production Moov names **MISSING**; sandbox names **PRESENT** |
| `https://checksops.com/prep/providers/status` | All Moov names **MISSING** |
| Moov HTTP | **not called** |

**STOP.** Do not change production. Do not move money.
