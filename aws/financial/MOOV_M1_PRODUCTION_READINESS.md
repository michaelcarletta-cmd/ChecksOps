# MOOV PRODUCTION READINESS — PHASE M1

**READ-ONLY AWS MONEY MOVEMENT INVENTORY.**

**STOP FOR REVIEW.** This document does **not** authorize Moov activation, flag changes, secret creation, KYC/KYB changes, or any transfer.

Prepared: 2026-09-09  
Base: current `main` `0660a783` (after PR #182 TOTP persist enroll).  
Runs in parallel with the CheckAlt launch gate (Phase 3A PR #177).

## What this phase did not do

- Did not set `AWS_MOOV_ENABLED`, `AWS_PROVIDER_EXECUTION_ENABLED`, or `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`
- Did not create or change production secrets
- Did not send or collect ACH
- Did not create a transfer, move money, change KYC/KYB, or modify Moov accounts
- Did not apply financial SQL or change production data

Live HTTP this phase: public `GET` on AWS staging `/health`, `/providers/status`, `/sandbox/status`, `/db-health`; CloudFront `https://checksops.com/prep/health`, `/prep/providers/status`, `/prep/sandbox/status`. No Moov API POST. No production writes.

## How close is ChecksOps to a first controlled production Moov transfer?

**Not close enough to activate.** AWS has a complete **sandbox/UAT** port of the Lovable Moov Edge Functions, sandbox certification **PASS**, and production flags **false**. Production ChecksOps.com still invokes **Supabase Edge Functions**. There is **no** AWS `providers/production/moov-*` module (CheckAlt has one; Moov does not). Production Moov keys are **MISSING** on AWS staging and production-prep. Freedom has a restored **production-labeled** Moov account row whose live KYC/bank/capability state was **pending** on the last local snapshot and was **not** re-read from Moov in this phase.

**Verdict: NO-GO for controlled Moov activation.**

Classification legend:

| Class | Meaning |
| --- | --- |
| **A** | AWS production implementation (can run with production keys/flags) |
| **B** | AWS staging / sandbox / UAT only |
| **C** | Legacy Supabase / Lovable implementation (production ChecksOps.com today) |
| **D** | Frontend only / placeholder |
| **E** | Missing |

---

## 1. Inventory — current Moov implementation

Authoritative production code: `supabase/functions/moov-*`, `_shared/moov*.ts`, related money functions. Authoritative AWS code: `aws/functions/api/providers/parity/moov-*.mjs`. Frontend: `src/lib/payments/providers/moovProvider.ts`, `DisbursementConsole`, `RecipientPaymentSetup`.

Production SPA (`isAwsStaging() === false`) still uses `supabase.functions.invoke(...)`. AWS `/functions/v1/*` is used only when `VITE_AUTH_PROVIDER=cognito`.

| Capability | Class | Evidence |
| --- | --- | --- |
| Account creation | **B + C** | `moov-account-create`. AWS parity writes `environment='sandbox'` only. Production flags on → `403 production_execution_blocked`, not a production adapter. |
| Individual KYC | **B + C** | Recipient: `moov-recipient-kyc-update`. Tenant KYC is primarily business/KYB. |
| Business KYB | **B + C** | `moov-account-onboard`, `moov-underwriting`, files, `moov-onboarding-link`. |
| Stakeholder onboarding | **B + C** | `moov-recipient-*` + `stakeholder-resend-verification`. AWS recipient public-token routes still wrapped in Cognito. |
| Terms of Service | **B + C** | `moov-tos-token` / `moov-tos-accept` / recipient TOS. AWS withholds public key from the browser. |
| Capabilities | **B + C** | Requested on create/onboard; live via `moov-sync` / `moov-readiness`. |
| Bank account linking | **B + C** | Manual add, bank-link token, micro-deposits, Plaid bridge. |
| Wallets | **B + C** | `moov-wallet-sync` → `payment_wallets`. |
| Wallet balances | **B + C** | Live sync into `payment_wallets`. |
| ACH collect | **B + C** | `moov-wallet-fund`, `initiate-wallet-funding`, `homeowner-deductible-pay`. |
| ACH send | **B + C** | `moov-transfer-create`, `moov-disburse`. |
| Same-day ACH | **B + C** | `railRouter` / `rail-router.mjs` selects `ach-credit-same-day` when eligible. Not a separate product flag. |
| Transfer creation | **B + C** | Full facilitator `POST /accounts/{id}/transfers`. AWS runtime sandbox-only. **A: missing.** |
| Transfer status | **B + C** | `moov-transfer-status` live GET + webhook apply. |
| Webhooks | **B + C** | Production dashboard still points at Lovable `moov-webhook`. AWS `POST /webhooks/moov` dry-run; skips `environment='production'` rows. |
| Reconciliation | **B + C** | AWS `/sandbox/reconcile` report-only. Production relies on webhook apply + transfer-status. No production Moov ledger reconcile on AWS. |
| Idempotency | **B + C** | `moov-transfer-create`: persist draft **before** HTTP + `X-Idempotency-Key`. `moov-disburse`: split POST then write `moov_transfer_id` **after** HTTP (gap). |
| Tenant authorization | **B + C** | Membership + allowlist. Spoofed tenant denied. |
| Financial step-up | **D** (Moov) | Frontend `useFinancialGuard("disbursement.send")` TOTP. **No server TOTP on Moov Edge Functions or AWS Moov.** CheckAlt has production dual-control; Moov does not. |
| Recipient / stakeholder authz | **B + C** | Token-based recipient routes on Lovable (no JWT). AWS wraps them in Cognito. Payer role: owner/admin/manager. |

**A (AWS production Moov money/execution): none.**  
**E:** `aws/functions/api/providers/production/moov-*` (CheckAlt-equivalent dual-control / TOTP / production secret contract).

### AWS endpoints (do not execute)

| Surface | Role |
| --- | --- |
| `GET /providers/status` | Flags + `*_configured` booleans only |
| `POST /providers/moov/status` | Local RDS snapshot; `liveProviderCalled: false` |
| `POST /functions/v1/moov-*` | Sandbox parity iff `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` and production flags false |
| `POST /sandbox/moov/{probe,transfer,retrieve}` | Sandbox certification harness |
| `POST /webhooks/moov` | HMAC verify; dry-run default; sandbox apply only |

If production flags are flipped **on**, `/functions/v1/*` returns `403 production_execution_blocked` and never binds production keys (`aws/functions/api/providers.mjs`). That is a hard stop, not a dark production Moov path.

---

## 2. Production Moov configuration (read-only)

Do not print secrets. Status is **PRESENT / MISSING / INVALID / UNKNOWN**.

Live AWS status endpoints (this phase):

| Item | AWS staging `checksops-staging-api` | AWS production-prep (`checksops.com/prep`) |
| --- | --- | --- |
| `AWS_MOOV_ENABLED` | **PRESENT** value `false` | **PRESENT** value `false` |
| `AWS_PROVIDER_EXECUTION_ENABLED` | **PRESENT** `false` | **PRESENT** `false` |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | **PRESENT** `false` (`/sandbox/status`) | **PRESENT** `false` |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | **PRESENT** `true` | **PRESENT** `false` |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | **PRESENT** `true` | **PRESENT** `true` |
| `PROVIDER_SECRETS_ARN` | **PRESENT** (staging secret) | **MISSING** |
| Production `MOOV_PUBLIC_KEY` / `MOOV_SECRET_KEY` | **MISSING** | **MISSING** |
| Production `MOOV_ACCOUNT_ID` | **MISSING** | **MISSING** |
| Production `MOOV_WEBHOOK_SECRET` | **MISSING** (`MOOV_WEBHOOK_SECRET_configured: false`) | **MISSING** |
| Production `MOOV_ENVIRONMENT` | **MISSING** | **MISSING** |
| Production `MOOV_PLATFORM_ACCOUNT_ID` | **UNKNOWN** on AWS secret object (not in staging `configuredFlags` list) | **MISSING** |
| Sandbox `MOOV_SANDBOX_PUBLIC_KEY` / `SECRET_KEY` | **PRESENT** | **MISSING** |
| Sandbox platform account / origin / webhook | **PRESENT** | **MISSING** |
| Production domain / base URL | **PRESENT** as host `https://api.moov.io` (same host for sandbox and production; ledger = credential set) | same host, unused |
| Webhook callback (AWS) | **PRESENT** route `POST /webhooks/moov`; production dashboard **not** redirected (`productionWebhooksRedirected: false`) | route exists; dry-run |
| Required OAuth scopes (code) | **PRESENT** in client (`profile.read/write`, `capabilities.*`, `bank-accounts.*`, `transfers.read/write`, `accounts.read/write`, files, representatives) | not loaded |
| Wallet capability | **UNKNOWN** on production tenant (not read from Moov this phase) | n/a |
| ACH send / collect / same-day | **UNKNOWN** on production tenant live; code requests `send-funds` / `collect-funds` / `wallet` / `send-funds.ach` | n/a |

`checksops/production/providers` is the CheckAlt production secret contract id. This agent could not `describe-secret` (no AWS CLI / instance credentials). Whether that secret **exists** is **UNKNOWN**. Even if it exists, production-prep reports every Moov production name **MISSING**, and staging reports production Moov names **MISSING**.

Lovable/Supabase production:

| Item | Status |
| --- | --- |
| `MOOV_ENABLED` | **UNKNOWN** (this agent cannot resolve `*.supabase.co`) |
| `MOOV_PUBLIC_KEY` / `MOOV_SECRET_KEY` | **UNKNOWN** live; **code expects them** when `MOOV_ENVIRONMENT=production` |
| `MOOV_WEBHOOK_SECRET` | **UNKNOWN** live; webhook HMAC required |
| Webhook callback | **PRESENT** as deployed Edge Function `moov-webhook` (`verify_jwt=false`). Dashboard still on Lovable per cutover matrix. |
| `MOOV_PLATFORM_ACCOUNT_ID` | **UNKNOWN** live; required for facilitator POST |

Staging sandbox capability snapshot (`/sandbox/status`): `productionKeysPresent: false`, `refuseProductionKeys: true`, `available: true` (sandbox keys only). Production-prep: `available: false`, `reason: sandbox_keys_missing`, `productionKeysPresent: false`.

---

## 3. Freedom Adjustment Moov account

Tenant UUID `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a`. Ordinary connected-account tenant — not the platform facilitator (`moov-transfer-create` comment; `moov-account-create`).

Live Moov GET was **not** performed. Values below are from **restored production RDS** used by AWS staging (Tranche 4 / UAT isolation), not a 2026-09-09 Moov API read.

| Question | Status |
| --- | --- |
| Account exists? | **YES** — `payment_provider_accounts.id` `60922058-7eca-4889-81dd-5720d7b9de96` (ChecksOps row id, not a Moov account number). Isolation docs: Freedom/C1C rows labeled `environment=production`. |
| Account type | **UNKNOWN** live. Code path creates business connected accounts for tenants. |
| Verification / KYC / KYB | **PENDING** on last local snapshot (T4: Freedom readiness `pending`, `liveProviderCalled=false`). Aug 2026 onboarding plan reported `action_required` for ToS + identity. **Not re-verified this phase.** |
| ToS accepted? | **UNKNOWN** live. T4 overall readiness `pending` can include ToS. |
| Wallet exists? | **PARTIAL** — isolation snapshot: **1** Moov wallet across **3** production Moov account rows (Freedom + C1C + one other). Freedom-specific wallet **UNKNOWN**. `payment_wallet_ledger` aggregate **0**. |
| Bank account connected? | **UNKNOWN** live. Last4 not printed in T4. |
| send ACH / collect ACH / `wallet.balance` / same-day ACH | **UNKNOWN** live. Transfer-create requires `onboarding_status=active` and `can_send_payments` + `can_ach_debit`. |
| requirements / `action_required` | **UNKNOWN** live. Last snapshot: readiness **pending**. |

C1C also has a production Moov row (`817e1bf0-e1f7-4e9e-95a8-ce15bfa31708`). Do not use C1C as the first live test destination without an explicit decision.

`payment_transfers_amount_cents` financial aggregate at T4: **0** — no persisted Moov transfers in the restored production ledger.

---

## 4. Stakeholder / recipient flow

Current production (Lovable) path:

```
AddExternalStakeholderDialog / stakeholder-resend-verification
  → moov-recipient-create          (JWT + requireMoovCaller)
  → email / copy link /pay-setup/:token
  → RecipientPaymentSetup
       → moov-recipient-session     (public token; MOOV_ENABLED)
       → moov-recipient-kyc-update  (individual KYC)
       → moov-recipient-tos-accept
       → moov-recipient-bank-add    (collect-funds only; not send-funds)
  → moov-sync / webhook / readiness
  → stakeholder eligible
  → DisbursementConsole → moov-disburse
```

Optional Plaid: `moov-plaid-bridge` from stakeholder managers.

### Can AWS production do this end-to-end today?

| Step | AWS production | Notes |
| --- | --- | --- |
| Stakeholder link | **NO** | Parity exists as sandbox + Cognito. Production SPA does not call AWS. |
| Moov KYC | **NO** (AWS prod) | Sandbox parity only. |
| ToS | **NO** (AWS prod) | Same. |
| Bank connection | **NO** (AWS prod) | Same. |
| Capability approval | **NO** (AWS prod) | Live GET only in sandbox. |
| Eligible recipient | **NO** (AWS prod) | Rows would be `environment='sandbox'` if AWS ran. |
| Receive transfer | **NO** (AWS prod) | Production flags hard-block. |

Remaining Supabase/Lovable dependencies: **all of them** for production ChecksOps.com — recipient public token (no Cognito), email send, `MOOV_ENABLED`, production keys, webhook apply, `external_payment_recipients` / `stakeholder_accounts`.

AWS intentional gap: `moov-recipient-session` still requires Cognito `withIdentityWrite`. A real payee with only a link **cannot** complete onboarding on AWS staging without a Cognito session.

---

## 5. Money execution path (SEND FUNDS) — do not execute

There is no button labeled exactly `SEND FUNDS`. The production money button is **Disburse Funds**.

| Step | What happens |
| --- | --- |
| Frontend component | `FundsTab` “Disburse to Stakeholders” → `DisbursementConsole` (“Disburse Funds”). Payroll: `RunPayrollDialog`. Wallet fund: `WalletPanel` “Add funds from bank”. Library ACH: `moovProvider.sendPayment`. `SendPaymentPanel` is a **dead** rail (throws “legacy payment rail has been removed”). |
| API endpoint | `supabase.functions.invoke("moov-disburse")` after optional `calculate-payment-funding` + `initiate-wallet-funding`. Alternate: `moov-transfer-create`. |
| AWS vs legacy | **Production = legacy Supabase.** AWS only if Cognito SPA. |
| Authorization | `requireMoovCaller`: `MOOV_ENABLED=true` + `tenants.moov_allowlisted` + credentials + membership. Role owner/admin/manager. Internal `process-funded-payment` uses `x-checksops-internal` = service role and **skips** `requireMoovCaller`. |
| TOTP financial step-up | Frontend `guardFinancial("disbursement.send")` → `useFinancialGuard` → `requireStepUp`. **Not enforced in `moov-disburse`.** Browser amount is used to build splits; server re-reads split `amount` from DB. Check-bound TOTP (`deposit.submit`) is CheckAlt-only. |
| Tenant derivation | Batch `tenant_id` from `disbursement_batches`, not a spoofable payer account. Transfer-create uses body `tenant_id` checked against membership. |
| Amount derivation | Disburse: `Math.round(Number(split.amount) * 100)` from DB splits (dollars → cents). Transfer-create: client `amount_cents` after auth (not CheckAlt-style server amount). |
| Idempotency | Disburse: Moov `X-Idempotency-Key` `checksops-disb-split-{split.id}`. **No** `payment_transfers` draft before HTTP. Transfer-create: unique `(tenant_id, idempotency_key)` insert **before** POST. |
| Moov transfer POST | `POST /accounts/{facilitatorId}/transfers` with integer cents `{ currency: "USD", value }`, pin `v2024.01.00`. |
| Transfer ID persistence | Disburse: `disbursement_splits.moov_transfer_id` **after** POST. Gap: HTTP success + DB fail → retry must not second-POST; Moov idempotency key is the only safety. Transfer-create: `payment_transfers.provider_transfer_id` after draft. |
| Status polling | `moov-transfer-status`. Disburse relies mainly on webhooks. |
| Webhook processing | Lovable `moov-webhook` HMAC → apply + on funding completed → `process-funded-payment` → `moov-disburse` internal. AWS: dry-run receipts; production-env rows skipped. |
| Reconciliation | No production AWS Moov reconcile. `/sandbox/reconcile` is report-only. T4 `payment_transfers_amount_cents = 0`. |

Frontend `PAYMENT_FLAGS.USE_MOOV` defaults **true**. UI shows Moov whenever `tenants.moov_allowlisted`. Backend `MOOV_ENABLED` is the real kill switch (independent of AWS flags).

---

## 6. Legacy Moov risk (same class as CheckAlt)

**Yes. Lovable/Supabase Moov can still move money while all AWS flags are false.**

AWS flags only gate Lambda. Production ChecksOps.com uses `VITE_SUPABASE_URL`. Kill switches that actually matter for Lovable:

1. `MOOV_ENABLED` on the Supabase project
2. `tenants.moov_allowlisted`
3. Presence of `MOOV_*` / `MOOV_SANDBOX_*` secrets
4. Moov dashboard webhook URL still hitting `moov-webhook`

This phase could not list live Supabase secrets (`*.supabase.co` NXDOMAIN from this agent). Treat live `MOOV_ENABLED` as **UNKNOWN** and **do not assume it is false**.

Money-moving Edge Functions (not disabled by AWS flags):

| Function | Money action | Extra risk |
| --- | --- | --- |
| `moov-transfer-create` | ACH/RTP send | Role gate only; no TOTP |
| `moov-transfer-group-create` | Parent + child POSTs | Same |
| `moov-disburse` | ACH credit per split | Internal service-role path **skips** `MOOV_ENABLED` |
| `moov-wallet-fund` / `initiate-wallet-funding` / `wallet-fund-on-clear` | ACH collect | |
| `moov-tenant-fee-charge` | Fee transfer | Platform admin |
| `homeowner-deductible-pay` | ACH collect | Public ledger token + `MOOV_ENABLED` |
| `moov-micro-deposit-initiate` | Micro-deposits | Small money |
| `moov-fee-schedule-upsert` / `moov-sweep-config` | Moov-native recurring / sweeps | Can move money after config with no new UI click |
| `moov-webhook` → `process-funded-payment` | Completes funded disbursement | HMAC only; `verify_jwt=false`; downstream bypasses `requireMoovCaller` |

**Do not disable anything in this phase.** Operator follow-up (later phase): confirm `MOOV_ENABLED`, rotate or isolate production keys, and decide whether Lovable money paths must be fail-closed before any AWS Moov flag is considered.

---

## 7. First live Moov test design (do not execute)

Smallest safe production test, after a later human GO:

1. **Payer:** Freedom connected account only. Not C1C. Not the platform facilitator as source of customer funds.
2. **Amount:** `$0.01` (`amount.value = 1`) if Moov production allows it; otherwise the smallest ACH credit Freedom’s bank will originate. Prefer a dedicated test check / adhoc transfer — do **not** reuse a real claim disbursement batch.
3. **Recipient:** a bank account Freedom controls (same legal entity or a known test recipient that already completed KYC/ToS/bank). Do not onboard a new real homeowner for the first POST.
4. **Path:** `moov-transfer-create` (persist-before-HTTP), **not** `moov-disburse` (persist-after-HTTP gap) and **not** auto-funding → webhook → internal disburse.
5. **Auth:** real Freedom owner/admin/manager + frontend TOTP. Do not use the service-role internal header.
6. **Idempotency:** pre-allocate `idempotency_key = freedom:{destination}:{1}:m1-test`. Insert `payment_transfers` `ready` **before** Moov POST. Moov `X-Idempotency-Key` = `checksops-transfer-{draft.id}`.
7. **Uncertain result:** if HTTP times out or DB update after POST fails, **do not retry POST**. GET transfer by idempotency / poll `moov-transfer-status` / webhook only.
8. **Webhooks:** dual-run or confirm Lovable `moov-webhook` will apply this transfer. Do not redirect the Moov dashboard yet.
9. **AWS flags:** remain **false** for this first test if the test is still on Lovable. Do not flip `AWS_MOOV_ENABLED` to “try” AWS. First live transfer and AWS activation are separate decisions.
10. **Holds:** no SQL 64, no SQL 65, no production secret create from an agent.

Prerequisites before that test is even scheduled: live Freedom Moov GET (ToS, verified bank, `send-funds.ach` enabled), confirm `MOOV_ENABLED` and production keys on Lovable, close or accept the disburse persistence gap, and confirm webhook secret.

---

## 8. Readiness matrix

| # | Area | Status |
| --- | --- | --- |
| 1 | AWS Moov implementation completeness | **PARTIAL** — sandbox/UAT parity **complete** (39 named functions). Production adapter **missing**. Enabling production flags **blocks** rather than activates. |
| 2 | Legacy / Supabase dependencies | **FULL** on ChecksOps.com. Frontend invoke, secrets, webhook, recipient public token, allowlist. |
| 3 | Production credentials readiness | **MISSING** on AWS (staging + prep). Lovable **UNKNOWN**. |
| 4 | Freedom Moov account readiness | **PARTIAL** — production row exists; live KYC/bank/caps **UNKNOWN**; last snapshot **pending**. |
| 5 | KYC / KYB readiness | **UNKNOWN** live / **pending** last snapshot. |
| 6 | Wallet readiness | **UNKNOWN** Freedom-specific; one production wallet exists among three accounts; ledger **0**. |
| 7 | Bank readiness | **UNKNOWN** live. |
| 8 | Capabilities readiness | **UNKNOWN** live. Code requires send-funds + collect-funds (debit) + wallet for treasury. |
| 9 | Stakeholder onboarding readiness | **C only** for production. AWS cannot serve a payee link without Cognito. |
| 10 | Transfer persistence / idempotency | **PARTIAL** — transfer-create persist-before-HTTP **ready in code**. Disburse persist-after-HTTP **gap**. No production transfers in restored ledger. |
| 11 | Webhook / reconciliation readiness | **PARTIAL** — Lovable apply exists. AWS dry-run + skip production rows. Dual-run **not started**. |
| 12 | Legacy money-path risk | **OPEN** — same class as CheckAlt. AWS flags do not stop Lovable. Internal disburse bypasses `MOOV_ENABLED`. |
| 13 | Blockers for first live Moov transfer | See below. |
| 14 | Estimated engineering phases remaining | **M2–M8** below (not calendar). |
| 15 | GO / NO-GO for controlled Moov activation | **NO-GO** |

### Blockers for first live Moov transfer

1. No AWS production Moov adapter; production flags are a hard block.
2. Production Moov keys **MISSING** on AWS; Lovable key/`MOOV_ENABLED` state **UNKNOWN** from this agent.
3. Freedom live ToS / KYC / bank / `send-funds.ach` **not confirmed** (last snapshot pending).
4. Production SPA still on Supabase; TOTP not server-enforced on Moov.
5. `moov-disburse` does not persist transfer id before POST (if that UI path is used).
6. Webhooks still Lovable; AWS dry-run; no dual-run.
7. `64_financial_activation_grants.sql` not applied; financial permissions deactivated (correct hold).
8. Recipient onboarding on AWS requires Cognito (payee link broken on AWS).
9. Open Lovable money-path risk until `MOOV_ENABLED` / secrets are inventoried and gated.

### Engineering phases remaining (technical)

| Phase | Work | Activates money? |
| --- | --- | --- |
| **M1** | This inventory | No |
| **M2** | Operator: live Freedom Moov dashboard/GET (ToS, bank last4, caps). Confirm Lovable `MOOV_ENABLED` and key **names**. | No |
| **M3** | Moov production secret contract (names only) parallel to CheckAlt. Do not load values from an agent. | No |
| **M4** | Lovable money-path risk control (inventory `MOOV_ENABLED`; optional fail-close). Same class as CheckAlt. | No (or reduce existing risk) |
| **M5** | Persist-before-HTTP on `moov-disburse` (or first test uses transfer-create only). Server TOTP/dual-control for Moov. | No |
| **M6** | AWS production Moov module (not sandbox-bind). Public recipient token without Cognito. | No until flags |
| **M7** | Webhook dual-run (receipts only). | No |
| **M8** | Human-approved `$0.01` Freedom transfer on the persist-before-HTTP path. Flags still a separate GO. | Only that one test |

Sandbox certification **PASS** (PR #124) is **not** a production GO.

---

## Live evidence captured this phase

| Probe | Result |
| --- | --- |
| Staging `/health` | 200, `environment=staging`, `productionSupabaseChanged=false` |
| Staging `/db-health` | 200, `transactionReadOnly=on`, PostgreSQL 18.3 |
| Staging `/providers/status` | All production execution flags **false**; production Moov names **MISSING**; sandbox Moov names **PRESENT** |
| Staging `/sandbox/status` | `AWS_MOOV_ENABLED=false`; Moov sandbox `available=true`; `productionKeysPresent=false` |
| `https://checksops.com/prep/health` | 200, `environment=production-prep` |
| `https://checksops.com/prep/providers/status` | All Moov names **MISSING**; `PROVIDER_SECRETS_ARN` unset |
| Raw prep execute-api | 403 (Gate 3D) |
| Moov POST | **not called** |
| Flags changed | **false** |

Sanitized JSON: `aws/financial/results/moov_m1_live_inventory.json`.

---

## STOP

Do not change production. Do not move money. Do not enable Moov.
