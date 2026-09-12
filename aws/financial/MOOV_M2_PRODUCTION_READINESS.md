# Moov production readiness — Phase M2

**LIVE ACCOUNT TRUTH + AWS PRODUCTION ADAPTER DESIGN**

**Status:** STOP FOR REVIEW. Design and inventory only. No production change. No money movement. No secret created. No flag enabled.

**Date:** 2026-09-09  
**Branch:** `cursor/moov-production-readiness-m2-a508`  
**M1 verdict (accepted):** NO-GO for production Moov **activation**.  
**M2 question:** GO/NO-GO for **beginning M3 implementation** (dark adapter only).

This phase does **not** enable `AWS_MOOV_ENABLED`, `AWS_PROVIDER_EXECUTION_ENABLED`, or `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`. It does **not** create production provider secrets, load Moov production credentials, create/modify Moov accounts, initiate ACH, create a transfer, move money, redirect webhooks, or disable Lovable production functions.

Companion docs:

- `aws/financial/MOOV_PRODUCTION_SECRET_CONTRACT.md`
- `aws/financial/MOOV_M2_PRODUCTION_ADAPTER_DESIGN.md`
- `aws/financial/results/moov_m2_live_probes.json`
- Secondary RDS: `aws/providers/TRANCHE_4_RESULTS.md`, `aws/db-copy/FIRST_COPY_STATUS.json`

---

## 1. Freedom live production account state

### 1.1 Live Moov GET

**Not performed.** Classification: **PROVIDER CREDENTIAL BLOCKER**.

| Reason | Detail |
|--------|--------|
| Operator instruction | Do not load Moov production credentials. |
| AWS production Lambda | `PROVIDER_SECRETS_ARN` unset; all production Moov names **MISSING** (`checksops.com/prep/providers/status`). |
| AWS staging | Production Moov names **MISSING**; sandbox names **PRESENT**. `productionKeysPresent: false`. |
| This VM | No AWS CLI, no instance credentials, no Secrets Manager. |
| Lovable | `*.supabase.co` NXDOMAIN from this agent. Cannot call Edge Functions as a read-only operator. |

A live `GET /accounts/{id}`, wallet, bank, capabilities, and requirements query was therefore **impossible** without violating the load-credentials rule or inventing credentials.

### 1.2 Restored RDS — secondary evidence only

Source: Tranche 4 (`aws/providers/TRANCHE_4_RESULTS.md`) and first-copy inventory (`aws/db-copy/FIRST_COPY_STATUS.json`). Restored rows are a copy, not a live Moov capability read.

| Field | Value |
|-------|--------|
| Tenant | Freedom `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a` |
| Production `payment_provider_accounts` row | **exists** (`60922058-7eca-4889-81dd-5720d7b9de96`) |
| `environment` | `production` |
| `provider_account_id` | **present** (value not printed) |
| T4 local `computeMoovReadiness` | **pending**; `liveProviderCalled=false` |
| `payment_transfers` / `payment_transfers_amount_cents` | **0** / **0** |
| Global restored counts | 3 `payment_provider_accounts`, 2 `payment_provider_methods`, 1 `payment_wallets`, 3 `external_payment_recipients`, 67 `stakeholder_accounts` |

**Do not treat restored rows as live KYC/wallet/bank/capability truth.**

### 1.3 Account type / KYC / KYB / ToS / wallet / bank / ACH

| Question | Live answer |
|----------|-------------|
| Production Moov account exists | **RDS yes / live unverified** |
| Account ID present | **RDS yes / live unverified** |
| Account type | **UNKNOWN** (live GET blocked) |
| Identity verification / KYC | **UNKNOWN** (RDS null) |
| Business / KYB | **UNKNOWN** |
| Terms of Service accepted | **UNKNOWN** (RDS null) |
| Wallet exists | **RDS yes (1 `payment_wallets` row globally) / live unverified** |
| Wallet status | **UNKNOWN** |
| Wallet available/pending balance | **UNKNOWN** (do not print even if known) |
| Bank account exists | **RDS likely (2 `payment_provider_methods` globally) / live unverified** |
| Bank status verified | **UNKNOWN** |
| ACH credit capability | **UNKNOWN** |
| ACH debit capability | **UNKNOWN** |
| `wallet.balance` capability | **UNKNOWN** |
| Same-day ACH capability | **UNKNOWN** |
| Remaining `requirements` / `action_required` | **UNKNOWN** |
| Production account currently usable as sender? | **NO (not proven).** Treat as **not usable** until a future authorized read-only GET. |

C1C production row exists (`817e1bf0-e1f7-4e9e-95a8-ce15bfa31708`). **Do not use C1C as first-test destination.**

---

## 2. Production credential availability

| Location | Production Moov names | Sandbox names |
|----------|------------------------|---------------|
| Production-prep Lambda | **MISSING** (all listed Moov names) | **MISSING** |
| Staging Lambda | **MISSING** (production family) | **PRESENT** (`MOOV_SANDBOX_*`) |
| `PROVIDER_SECRETS_ARN` (prod) | **unset** | n/a |
| This operator | **unavailable** | n/a |
| Lovable Edge Function secrets | **UNKNOWN** (NXDOMAIN). Historically the only production Moov runtime. |

**PROVIDER CREDENTIAL BLOCKER** remains for live account truth **and** for any future production POST.

---

## 3. Exact secret names required

See `MOOV_PRODUCTION_SECRET_CONTRACT.md`.

**Required (current production code):**

- `MOOV_PUBLIC_KEY`
- `MOOV_SECRET_KEY`
- `MOOV_PLATFORM_ACCOUNT_ID` (facilitator — **not** tenant)
- `MOOV_WEBHOOK_SECRET`
- `MOOV_ENVIRONMENT` = `production`
- `MOOV_ALLOWED_ORIGIN` = `https://checksops.com`

**Tenant Freedom account id:** RDS `payment_provider_accounts.provider_account_id` — **not** a secret named `MOOV_ACCOUNT_ID`.

**Inventory bug:** `provider-secrets.mjs` lists `MOOV_ACCOUNT_ID` and does **not** list `MOOV_PLATFORM_ACCOUNT_ID` or `MOOV_ALLOWED_ORIGIN`. M3 must fix the inventory; M2 does not create the secret.

**Refuse:** `MOOV_SANDBOX_*`, staging `AWS_MOOV_WEBHOOK_SECRET` as production HMAC.

---

## 4. AWS production adapter files / routes required

Isolated module (do **not** reuse `parity/moov-*.mjs`):

```
aws/functions/api/providers/production/moov-holds.mjs
aws/functions/api/providers/production/moov-secrets.mjs
aws/functions/api/providers/production/moov-authz.mjs
aws/functions/api/providers/production/moov-idempotency.mjs
aws/functions/api/providers/production/moov-config.mjs
aws/functions/api/providers/production/moov-client.mjs
aws/functions/api/providers/production/moov-read.mjs
aws/functions/api/providers/production/moov-transfer.mjs
aws/functions/api/providers/production/moov-reconcile.mjs
aws/functions/api/providers/production/moov-webhook-apply.mjs
aws/functions/api/providers/production/moov-dispatch.mjs
```

Wire `runProductionMoovHandler` in `providers.mjs` **before** `runParityHandler`, same pattern as CheckAlt.

**Holds (all required, fail closed before HTTP):**

- `AWS_PROVIDER_EXECUTION_ENABLED`
- `AWS_MOOV_ENABLED`
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`
- `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` **must be false**
- Production-only secret family
- `MOOV_ENVIRONMENT=production`

Flags false today → **no production HTTP**. That is correct.

---

## 5. TOTP / server-side authorization changes required

Port CheckAlt `checkalt-authz.mjs` to Moov. Do **not** rely on `guardFinancial()` alone.

Chain for `disbursement.send`:

authenticated Cognito user → application UUID → tenant membership → owner/admin/manager → **current server-side payment/disbursement** → **server-derived recipient** → **server-derived `amount_cents`** → operation `disbursement.send` → **fresh TOTP or approved dual control** bound to `{tenant_id, resource_id, amount_cents}` → execution holds → provider HTTP.

Browser **must not** authorize tenant, sender, recipient, destination bank, amount, Moov account, or payment method.

`canExecuteProduction` stays **false**. Use `canExecuteProductionMoov`. First test resource: `payment_transfers.id` (or split), **not** a check.

---

## 6. Transfer idempotency design

Persist intent **before** HTTP. Current `moov-disburse` (write `moov_transfer_id` after HTTP) is **not** sufficient.

1. Insert `payment_transfers` `queued` + UUID `idempotency_key` + `environment=production`
2. **COMMIT**
3. CAS `provider_http_attempted_at IS NULL` — one claimant
4. POST `/accounts/{MOOV_PLATFORM_ACCOUNT_ID}/transfers` with `X-Idempotency-Key`
5. Persist `provider_transfer_id`
6. All retries **poll / reconcile** — never a second uncontrolled POST

M3 schema (design only): `provider_http_attempted_at`, `failure_class`. Unique keys already exist on `payment_transfers`.

First live test **must** use this path, not Lovable `moov-disburse`.

---

## 7. Stakeholder / onboarding work for first test

| Bucket | Work |
|--------|------|
| **A — first controlled transfer** | Prefer an **already-existing Freedom-controlled verified** Moov recipient. **Do not onboard anyone.** None confirmed live (credential blocker). If none exists after authorized GET, first-test **send** is blocked. |
| **B — broad rollout** | Public token onboarding **without** Cognito (AWS `moov-recipient-session` is still wrapped). KYC/ToS/bank on AWS. Webhook apply. Capability cache. |
| **C — later** | Bulk import, invoices, sweeps, fees, same-day productization. |

Do **not** use C1C as destination.

---

## 8. Legacy Lovable money-path risk

| Function | AWS | Lovable (code) | Live `MOOV_ENABLED` |
|---------|-----|----------------|---------------------|
| `moov-transfer-create` | DISABLED (flags) | **REACHABLE** | **UNKNOWN** |
| `moov-disburse` | DISABLED | **REACHABLE** (internal skip) | **UNKNOWN** |
| `initiate-wallet-funding` | DISABLED | **REACHABLE** | **UNKNOWN** |
| `calculate-payment-funding` | DISABLED | **REACHABLE** | **UNKNOWN** |
| `process-funded-payment` | DISABLED | **REACHABLE** | **UNKNOWN** |
| `moov-webhook` | DISABLED | **REACHABLE** (`verify_jwt=false`) | **UNKNOWN** |
| fee / sweep | DISABLED | **REACHABLE** | **UNKNOWN** |
| recipient-create / onboarding | DISABLED | **REACHABLE** | **UNKNOWN** |

Production credentials today: **Lovable Edge Function secrets** (names `MOOV_*` above). AWS production: **none**.

**Defense-in-depth (design only — do not execute):**

1. Production SPA Cognito → no `supabase.functions.invoke` for money
2. Set Lovable `MOOV_ENABLED=false` (and keep `moov_allowlisted`)
3. After AWS has production keys: **rotate / remove** Lovable `MOOV_SECRET_KEY`
4. Redirect dashboard webhook last

Until 1–3, **AWS flags false do not stop Lovable money**.

---

## 9. Webhook / reconciliation migration plan

**Do not redirect the Moov dashboard webhook.**

| Phase | AWS | Lovable |
|--------|-----|---------|
| Now / M3 | Optional **receipts + signature verify + log**. `applied=false`. | Remains the apply path |
| Later | Dual-run: AWS apply + Lovable still receiving until cutover proven | Then disable Lovable apply |
| Always | Poll `GET /transfers/{id}` is fallback | n/a |

Idempotent apply: unique `provider_event_id`; transfer lookup by `provider_transfer_id`; tenant from **our** row; ignore unknown / out-of-order terminal states.

---

## 10. First live test (design only — do not execute)

Freedom sender → Freedom-controlled verified recipient → **1 USD cent** (`amount_cents=1`; staging `/sandbox/status` documents `sandboxMinCents: 1`; fallback **100** if Moov or the originating bank rejects 1) → fresh TOTP → **one** AWS production transfer POST → persist Moov transfer ID → poll → reconcile → verify receipt.

Do **not** run this until a **separate** human GO after M3+ and live GET.

---

## 11. Code phases still required before first live transfer

| Phase | Work | This phase |
|--------|------|---------|
| M3 | Dark production module + dispatch + inventory name fix + authz + idempotency SQL + tests. Flags **remain false**. No secret create. | **Not this phase** |
| M3b | Authorized **read-only** live GET (human loads keys in a break-glass session, or operator GET). Fill KYC/ToS/wallet/bank/capabilities. Confirm recipient. | Blocked |
| M4 | Create production secret in **production** JSON only (human). Still flags false. | Blocked |
| M5 | Human GO: enable holds for **one** transfer. Execute first test. | Blocked |
| M6 | SPA cutover + Lovable `MOOV_ENABLED=false` + rotate Lovable keys | Blocked |
| M7 | Webhook redirect + apply on AWS | Blocked |

---

## 12. Exact external / provider blockers

1. **PROVIDER CREDENTIAL BLOCKER** — cannot GET live Freedom Moov state.
2. Production AWS secret **does not exist** (`PROVIDER_SECRETS_ARN` unset; names MISSING).
3. Inventory name mismatch (`MOOV_ACCOUNT_ID` vs `MOOV_PLATFORM_ACCOUNT_ID`).
4. Live KYC / KYB / ToS / wallet / bank / ACH capabilities **unknown**.
5. Verified Freedom-controlled recipient **not confirmed**.
6. Lovable production money path still **REACHABLE** (independent of AWS flags).
7. AWS production Moov module **does not exist**.
8. Server-side Moov TOTP **does not exist**.
9. Durable pre-HTTP idempotency for Moov **does not exist**.
10. `moov-disburse` internal header skip remains a duplicate-money risk on Lovable.

---

## 13. GO / NO-GO for beginning M3 implementation

| Decision | Verdict |
|---------|---------|
| Begin **M3 dark implementation** (adapter files, authz, idempotency, webhook receipts, tests; **all flags false**; **no secret create**; **no money**) | **GO** |
| Enable any production flag | **NO-GO** |
| Create / load production secrets | **NO-GO** |
| First live transfer | **NO-GO** |
| Redirect webhook | **NO-GO** |
| Disable Lovable functions | **NO-GO** |
| Treat Freedom as proven sender | **NO-GO** |

**M3 GO conditions (must remain true):**

- Isolated `providers/production/moov-*` — no sandbox fallback
- Holds fail closed before HTTP
- Server TOTP / dual-control on the CheckAlt model
- Intent committed before POST
- Webhook validate/log only
- Do not create the secret in M3
- Do not onboard stakeholders in M3

---

## STOP FOR REVIEW

No production change. No money moved. No secret created. No flag flipped. No webhook redirected. No Lovable function disabled.
