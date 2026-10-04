# ChecksOps Financial Accounting / Reporting Model Audit

**Status:** READ-ONLY architecture and data-model audit  
**Date:** 2026-10-04  
**Source baseline:** `main` at `7c64dae2d` (after PR #620)  
**Authorized Platform Finance implementation:** kept separate (PRs #537 / #546 and related receivables read model). This document does not expand that implementation.

## Safety

This audit does **not**:

- modify SQL or RLS
- migrate or backfill data
- change invoices
- create payments
- initiate ACH
- collect fees
- modify Moov
- modify Mortgage Agents
- deploy anything
- add Platform Finance tabs
- change billing calculation
- overlay Lambda or SPA

Findings and recommendations only.

---

## 1. Relationship to the authorized Platform Finance workstream

The currently authorized work is a **narrow read path**:

| Surface | Role | Source |
|---|---|---|
| Platform Banking | Read platform settlement bank / capabilities | `PlatformBankPanel.tsx`, `moov-platform-bank` |
| Wallet & P&L | Live Moov platform wallet + mixed P&L rollup | `PlatformTreasuryPanel.tsx`, `platform-treasury` |
| Tenant receivables ledger | Attribute incoming tenant-fee transfers from **local billing operations**, not bank name / last4 | `aws/functions/api/providers/parity/tenant-receivables.mjs` (PR #546; **not on this `main` checkout**) |
| Tenant Billing History | Per-tenant billed / pending / received / outstanding | `TenantBillingHistoryPanel.tsx` (PR #546; **not on this `main` checkout**) |

Authorized rules already in that workstream (do not reopen here):

- Attribution is `tenant_id` → `tenant_maintenance_payments` / `platform_fee_occurrences` → provider transfer id.
- Pending / originated ACH is never treated as received.
- Monthly billing calculation is unchanged.
- No SQL. No Moov writes. Funding execution is not overlaid.
- Platform-owner gate only (`is_platform_owner()` / `isChecksOpsPlatformOwner`).

This audit asks a larger question: **can the existing durable data model support accurate tenant financials, platform financials, payments-by-recipient, tax/1099 totals, and profit reporting?** The answer is: **partially, across several parallel stores, with missing classification and missing links.** Do not treat the authorized receivables read model as a general ledger.

On current `main`, Platform Finance UI is only **Banking** + **Wallet & P&L**. Receivables / Billing History exist on the authorized branches and (per PR #546) on the accepted production read path, but those files are not in this checkout.

---

## 2. Executive verdict

ChecksOps does **not** have a single authoritative accounting ledger.

Money is recorded in several parallel stores with different scopes:

1. **Execution ledger** — `payment_transfers` + `payment_event_log` + `payment_webhook_events` (Moov transfers that go through `moov-transfer-create` / groups / wallet funding).
2. **Tenant wallet subledger** — `payment_wallet_ledger` (immutable balance entries; not revenue).
3. **Platform fee accrual** — `platform_fee_line_items` / `platform_fee_occurrences` / `platform_fee_schedules`.
4. **Platform cash attempts** — `tenant_maintenance_payments` (Moov ACH pulls and manual records). Provider transfer id is often buried in `notes` (`moov:<uuid>`), not a structured FK.
5. **Tenant operational cash** — `check_intake_items`, `disbursement_batches`, `disbursement_splits` (insurance-check economics).
6. **Tenant-as-merchant invoices** — `moov_invoices` (tenant bills *its* customers; funds settle to the **tenant** wallet).
7. **Stripe / credit rail** — `tenant_credit_balances`, `tenant_credit_transactions`, `check_billing_events`.
8. **Tax overlay** — `recipient_tax_profiles` keyed by **string**, not FK.
9. **Narrative / claim** — `claim_payments`, `homeowner_ledger_events`.
10. **AWS certification** — `aws_financial_*` (not a production ledger).

**Profit must not be calculated from Moov wallet balance.** Current Wallet & P&L already separates wallet (Moov API) from P&L (DB aggregates), which is correct in intent. The P&L formula itself is still not an accounting profit:

```
revenue = platform_fee_line_items.amount_cents (status ≠ void)
        + payment_transfers.platform_fee_cents (non-failed)
profit  = revenue − payment_transfers.provider_fee_cents
volume  = Σ payment_transfers.amount_cents   ← includes wallet funding and tenant settlement
```

That formula:

- counts **accrued / billed fees** as revenue before cash is collected
- includes **all transfer volume**, including non-revenue money movement
- treats **tenant-rail provider fees** as platform cost
- does **not** include `tenant_maintenance_payments` cash pulls unless they also appear as line items
- does **not** reconcile to platform wallet settlement

**Authoritative layers that should exist (recommended, not built):**

| Layer | Authoritative for | Reuse |
|---|---|---|
| Execution / cash movement | Provider-tied money movement | `payment_transfers` + webhook/event log; extend so fee pulls also land here |
| Revenue / AR subledger | Invoice issued, earned, billed, collected, outstanding | Extend `platform_fee_line_items` + a canonical tenant-obligation row (see gaps). Authorized receivables read model is a start, not the ledger. |
| Wallet / bank truth | Settlement cash position | Moov wallet/bank APIs **reconciled to** durable rows; never the sole history |
| Payee / tax support | Annual payments by durable recipient | `stakeholder_accounts` + `external_payment_recipients` + tax profile **FK** |
| Journal / postings | Classification (revenue, cash, expense, transfer, refund, fee) | New thin posting table **referencing** existing IDs — do not copy amounts into a parallel system |

There is no chart of accounts, no journal entry type, and no `economic_kind` on transfers.

---

## 3. Data-flow diagrams (text)

### 3.1 Intended tenant-fee collection chain

```
Tenant pricing config
  tenants.monthly_rate_cents / per_check_rate_cents / referral_discount_cents
        │
        ▼
Usage / obligation (parallel, not unified)
  platform_fee_line_items (unbilled → billed / void)
  check_billing_events (Stripe meter)
  email invoice (send-mortgage-ops-invoice) — HTML only, no AR row
        │
        ▼
Authorization
  payment_provider_accounts.can_ach_debit
  payment_provider_methods (active Moov bank)
  tenant_billing_accounts.ach_authorized_at (legacy / parallel)
        │
        ▼
Charge attempt
  moov-tenant-fee-charge  → tenant_maintenance_payments
  moov-fee-rollup         → platform_fee_occurrences + mark line items billed
        │
        ▼
Moov transfer (provider)
  transfer id often stored in tenant_maintenance_payments.notes as "moov:<uuid>"
  platform_fee_occurrences.provider_transfer_id rarely backfilled
        │
        ▼
ChecksOps platform wallet (Moov settlement truth)
  live GET /accounts/{MOOV_PLATFORM_ACCOUNT_ID}/wallets
        │
        ▼
Internal ledger
  payment_wallet_ledger  ✗ not written for fee pulls
  payment_transfers      ✗ not written by moov-tenant-fee-charge
  payment_event_log      ✗ fee pulls typically invisible to webhook matcher
```

### 3.2 Chain completeness: tenant invoice → cash → Moov → platform wallet → ledger

| Step | Exists? | Record | Missing link |
|---|---|---|---|
| 1. Invoice / obligation issued to tenant | **Partial** | Fee line items, occurrences, maintenance payment rows, email HTML | No canonical `tenant_invoices` with invoice date / due date / status / open balance |
| 2. Authorized payment | **Yes** | `payment_provider_accounts` + methods; legacy `tenant_billing_accounts` | Dual authorization models |
| 3. Moov transaction | **Yes** | Provider transfer created | Local row often has id only in free-text `notes` |
| 4. Platform wallet settlement | **External** | Live Moov wallet API | Not tied to tenant payment row |
| 5. Internal ledger entry | **No for fee pulls** | `payment_wallet_ledger` / `payment_transfers` | Webhook looks up `payment_transfers.provider_transfer_id`; fee pulls miss that table |
| 6. Cash vs billed distinction | **Partial on authorized read model** | Received only when provider status is settled | Local `received_at` defaults at insert; occurrence status often stays `scheduled` |

**Broken links (do not “fix” in this audit):**

1. No first-class ChecksOps→tenant invoice entity.
2. Fee pulls bypass `payment_transfers`, so webhook / wallet ledger cannot attach.
3. Provider transfer id is unstructured (`notes`) on the primary cash table.
4. Platform wallet has **no durable ledger table**.
5. Authorized receivables read model can **display** billed/received/outstanding by joining local rows to optional Moov GET enrichment; it does not persist settlement or write a journal.

### 3.3 Tenant-as-merchant invoice path (different domain)

```
moov-invoice create
  → moov_invoices (invoice_date, due_date, status, total/paid)
  → customer pays Moov hosted / public link
  → sync sets paid_amount / paid_at
  → funds settle to TENANT Moov wallet
  → no payment_transfers row, no payment_wallet_ledger post for invoice payment
```

Do **not** use `moov_invoices` as ChecksOps accounts receivable. It is tenant→customer AR.

### 3.4 Outgoing payment paths (recipient reporting)

```
Insurance check
  check_intake_items → disbursement_batches → disbursement_splits
       │                      │
       │                      ├─ stakeholder_account_id  → stakeholder_accounts   (durable)
       │                      ├─ recipient_tenant_id     → tenants                (durable)
       │                      └─ recipient_name / type   (free text; external_check / wire / manual)

Moov direct send
  payment_transfers.destination_recipient_id → external_payment_recipients
  payment_transfers.destination_tenant_id    → tenants

Cash jobs
  cash_job_payments.stakeholder_account_id  OR  payee_name (free text)

Wallet debits
  payment_wallet_ledger  — no recipient FK

Draft plans (not money)
  claim_disbursements.recipient_name

Payroll
  disbursement_splits + payroll_runs via stakeholder_account_id

Tax overlay
  recipient_tax_profiles.recipient_key =
      acct:{stakeholder_id} | ext:{type}|{name.lower} | cash:{payee.lower}
```

Mortgage Agents are a **user role** (`user_roles.role = mortgage_agent`), not a payee type on `stakeholder_accounts` or `external_payment_recipients`. There is no durable “Mortgage Agent payee” record for outgoing payments.

### 3.5 What must not become revenue

```
Tenant bank ──funding──► tenant wallet          NOT revenue
Tenant wallet ──payout──► recipient             NOT platform revenue (tenant expense / fiduciary)
Check deposit ──clear──► tenant available funds NOT SaaS revenue
Tenant bank ──fee ACH──► platform wallet        platform CASH collected (if settled)
Usage event ──line item► platform_fee_line_items platform REVENUE EARNED (accrual)
Platform wallet ◄──► platform bank sweep        internal transfer, NOT revenue/expense
Facilitator wallet move between ChecksOps-owned accounts
                                            internal transfer, NOT revenue/expense
Moov provider fee on a tenant settlement     tenant-rail cost, classify before treating as platform opex
```

---

## 4. Existing source / table inventory

### 4.1 Tenant / company financials (ChecksOps billing the tenant)

| Table | Create / schema | Key columns | Writers | Readers | Fits required list? |
|---|---|---|---|---|---|
| `tenant_maintenance_payments` | `supabase/migrations/20260708180114_*.sql` + later status columns | `tenant_id`, `amount_cents`, `period_start/end`, `method`, `reference`, `notes`, `received_at`, `status`, `idempotence_key`, `submitted_at` | `moov-tenant-fee-charge`, `MaintenancePaymentsTracker`, admin pull | Authorized receivables, `TenantUsageDashboard` | Closest cash-received table. No invoice FK. Provider id in `notes`. `received_at` ≠ settlement. |
| `platform_fee_schedules` | `20260731174507_*.sql` | cadence, `amount_cents`, `amount_mode`, `provider_*_payment_method_id` | `moov-fee-schedule-upsert/cancel` | `feeSchedules.ts`, rollup | Config only |
| `platform_fee_occurrences` | same | `provider_transfer_id`, `run_at`, period, `amount_cents`, `status` | `moov-fee-rollup` | Authorized receivables, fee UI | Billing run, not a formal invoice. Transfer id / completion weakly wired. |
| `platform_fee_line_items` | same | `fee_code`, amounts, `occurred_at`, period, `check_id`, `claim_id`, `occurrence_id`, `status` (`unbilled/billed/void`) | `bill-mortgage-handling`, rollup | `platform-treasury` P&L | Accrual / usage. No `collected_at`, no payment FK. |
| `tenant_billing_accounts` | `20260708181806_*.sql` | bank metadata, `ach_authorized_at`, `stakeholder_account_id` | `save-tenant-billing-account`, admin/settings | Billing UI | Authorization / bank, not AR |
| `check_billing_config` / `check_billing_events` | `20260501204336_*.sql` | per-check price, Stripe meter ids, `status` | triggers, `report-check-usage-to-stripe` | usage dashboards | Metering, not invoices |
| `tenant_credit_balances` / `tenant_credit_transactions` | `20260423125422_*.sql` | Stripe customer/sub, credits, `purchase/deduction/refund/adjustment` | Stripe webhook, top-up, `deduct_tenant_credits` | `TenantCreditManager` | Prepaid OCR credits + Stripe state, not Moov AR |
| `tenants` pricing cols | various | `monthly_rate_cents`, `per_check_*`, `referral_discount_cents` | admin billing tab | fee charge amount calc | Config, not ledger |
| `moov_invoices` / `moov_invoice_customers` | `20260819015105_*.sql` | invoice/due dates, status, paid amounts, `moov_invoice_id` | `moov-invoice` | `InvoicesTab`, public invoice page | **Wrong direction** for platform AR |
| Email invoices | `send-mortgage-ops-invoice` | HTML + URL on mortgage request | Mortgage Desk | email | No AR row |

**Required tenant-financial capability matrix**

| Need | Supported today? | Notes |
|---|---|---|
| Invoices issued to each tenant | Partial | Email + fee rows; no invoice table |
| Invoice date / due date / status | Partial | Dates exist on `moov_invoices` (wrong party). Platform fees have period + run/status only |
| Payments received | Partial | `tenant_maintenance_payments` + Stripe credit txs. Authorized model treats only **settled** as received |
| Payment method | Partial | Free-text `method` (`moov_ach`, `stripe`, …); no FK to `payment_provider_methods` |
| Payment date | Partial | Mix of `received_at` (insert), `submitted_at`, provider `completedOn` |
| Transaction / provider reference | Weak | Unique index exists on `payment_transfers.provider_transfer_id`; fee pulls usually `notes` |
| Credits / refunds / adjustments | Partial | Credit-pack refunds/adjustments; line-item `void`; no general AR credit memo |
| Outstanding balance / AR | Partial | Authorized read model computes `billed − settled`. No aging table/view on `main` |
| Monthly ChecksOps fees | Partial | Three competing models: monthly ACH, usage schedule, Stripe maintenance sub |
| Payment history | Partial | Split across tables; authorized Billing History is the intended UI, scoped to fee operations |

### 4.2 ChecksOps platform financials

| Need | Current source | Accurate? |
|---|---|---|
| Gross revenue | `platform_fee_line_items` + `payment_transfers.platform_fee_cents` | Accrual mixed with transfer fees; not cash |
| Cash collected | Authorized receivables (`SETTLED` only) + live platform wallet | Wallet is position, not classified cash journal |
| Outstanding receivables | Authorized `balance_cents` | Only fee operations loaded (limit 500); not all obligations |
| Refunds / credits | Line-item `void`; transfer `returned`; credit-pack refunds | No platform refund ledger |
| Moov / provider costs | `payment_transfers.provider_fee_cents` | Includes costs on tenant settlement volume |
| Other recorded expenses | None as platform opex | Tenant `disbursement_splits` are tenant expenses |
| Payments made (platform) | No platform payables module | Outgoing is tenant-scoped |
| Net / profit | P&L cards: fees − provider_fee | **Not** wallet balance (good). Still not classified profit |
| Moov ↔ internal reconciliation | AWS `POST /financial/reconcile` is **simulated** (`aws_financial_operations`). Authorized receivables flags `LOCAL_ONLY`, `PROVIDER_ONLY`, `AMOUNT_MISMATCH`, `DUPLICATE` | No production durable recon table for live Moov vs ledger |

`AdminFinancialModel.tsx` / `src/lib/financial/pricingScenarios.ts` is a **pricing simulator**, not books.

### 4.3 Execution / wallet / event infrastructure

| Table | Schema | Role |
|---|---|---|
| `payment_provider_accounts` | `20260727224957_*.sql` | Tenant Moov account + ACH debit capability |
| `payment_provider_methods` | same | Bank rails; owner is tenant **or** external recipient |
| `payment_transfers` | same + later `leg_role`, group, rail cols | Primary Moov execution row. Unique `(provider, environment, provider_transfer_id)` |
| `payment_event_log` | same | Append-only status audit |
| `payment_webhook_events` | same | Idempotent webhook receipt |
| `payment_idempotency_keys` | same | Prevents duplicate provider submits |
| `payment_wallets` | `20260730191230_*.sql` | Tenant wallet balances |
| `payment_wallet_sub_ledgers` | same | Per-claim trust; `client_name` free text |
| `payment_wallet_ledger` | same | Immutable wallet entries: `direction`, `entry_type`, `provider_transfer_id`, `reference` unique per wallet. **No recipient. No accounting class.** |
| `payment_transfer_groups` | same | Multi-leg settlement |
| Sweeps | `moovSweeps.ts` | Moov-native; **not persisted** to wallet ledger |

Writers of `payment_wallet_ledger`: `moovWallet.ts` `postTransferLedger`, wallet funding, transfer-group parent, webhook / status poller. `moov-wallet-sync` **reads** ledger and logs Moov txns; it does not persist Moov-only movements.

### 4.4 Outgoing payments and recipients

| Table | Recipient link | Provider refs | Void / return | Category |
|---|---|---|---|---|
| `disbursement_splits` | `stakeholder_account_id` (nullable) + `recipient_name` / `recipient_type` + `recipient_tenant_id` | `moov_transfer_id`, Plaid / Actum ids, `external_check_number` | `status`, `returned_at`, `return_code` | `method` + account_type |
| `disbursement_batches` | none (splits hold payees) | `moov_transfer_group_id`, Actum debit ids | batch status / funding_status | rail |
| `payment_transfers` | `destination_recipient_id`, `destination_tenant_id` | `provider_transfer_id` | `status` (`returned` etc.) | `leg_role`, fees |
| `cash_job_payments` | optional stakeholder **or** `payee_name` | `reference_number` | none dedicated | `payment_method` |
| `claim_payments` | nullable `recipient_id` (no typed FK) + free-text `payee` | `reference` | none | `direction`, `payment_method` |
| `claim_disbursements` | free-text `recipient_name` | none | draft status | not executed |
| `external_payment_recipients` | durable payee | `provider_account_id`, bank fields | onboarding status | `recipient_type` default `individual` |
| `stakeholder_accounts` | durable bank payee | bank metadata | verification | `account_type`: contractor, vendor, subcontractor, sales_rep, … **not** Mortgage Agent |
| `homeowner_deductible_payments` | `recipient_id` → external recipient | `provider_transfer_id` | returned / canceled | inbound to contractor |
| `recipient_tax_profiles` | **`recipient_key` text**, not FK | none | none | none (`recipient_name`, TIN, address) |

UI / libs:

- `src/components/ledger/PaymentLedger.tsx` — `disbursement_splits`
- `src/components/ledger/RecipientReport.tsx` — stakeholder or `recipient_name`
- `src/components/ledger/TaxSummary.tsx` — settled splits + cash jobs; profiles via `tenant-tax-profiles`
- `src/lib/taxYtdSummary.ts` — year filter, name-key fallback, **legacy informational $600 flag only**
- `src/lib/payments/recipients.ts` — domain mapping
- W-9 lives in `payment_provider_files`, contractor verification, tenant document library, loss-draft docs — **not linked** to tax profiles

`payment_transfers` outbound and wallet-ledger debits are **not** included in Tax / Recipient reports.

### 4.5 Tenant Payments UI vs Platform Finance UI

Tenant `Payments.tsx` already has: Payment History, Invoices, Revenue & Profit, By Recipient, Tax & 1099, Payroll.

Those tabs are **tenant insurance-check economics**, not ChecksOps books:

- Invoices = `moov_invoices` (tenant→customer)
- Revenue & Profit = deposited checks − settled disbursements (`RevenueSummary.tsx`)
- By Recipient / Tax = disbursement splits + cash jobs

Platform Finance on `main`: Banking + Wallet & P&L only.

### 4.6 AWS / certification (do not use as production books)

| Artifact | Role |
|---|---|
| `aws/financial/sql/60_financial_preactivation.sql` | `aws_financial_operations` — comment: not a production ledger |
| `aws/financial/RECONCILIATION.md` | Report-only vs simulated snapshot |
| `aws/financial/FINANCIAL_EXECUTION_INVENTORY.md` | Money-path inventory; execution disabled unless separately authorized |
| `aws/db-copy/sql/reconciliation_financial.sql` | Copy-DB metrics |

---

## 5. Payments by Recipient — can every outgoing payment attach to a durable payee?

**No. Path-dependent.**

| Path | Durable payee? |
|---|---|
| Disbursement to `stakeholder_accounts` | Yes |
| Inter-tenant payout (`recipient_tenant_id` / `destination_tenant_id`) | Yes (tenant org) |
| Moov transfer to `external_payment_recipients` | Yes |
| External check / wire / manual split | **No** — `recipient_name` |
| Cash job without stakeholder | **No** — `payee_name` |
| Wallet ledger debit | **No recipient dimension** |
| Claim disbursement draft | Free text; not money |
| Mortgage Agent payout | **No payee type**; agents are a role, not a vendor record |

**Eventual filter dimensions**

| Filter | Ready? | Gap |
|---|---|---|
| Recipient | Partial | Name collision / rename splits identity |
| Recipient type | Partial | `account_type` / `recipient_type`; no Mortgage Agent; no unified enum |
| Date / year | Yes | `settled_at`, `created_at`, `payment_date`, `completed_at` |
| Payment category | Partial | No `payment_category`; proxied by type/method/`entry_type` |
| Payment method | Yes | `method`, rail, `payment_method` |
| Amount | Yes | Dollars on splits; cents on transfers |
| Transaction / reference ID | Yes when written | Moov/Plaid/Actum/check number; fee pulls weaker |
| Related claim / check / Mortgage Desk | Partial | Batch → `check_intake_item_id`; transfers have `claim_id`/`check_id`; Mortgage Desk request not a payment FK |
| Void / refund / adjustment | Partial | Status + return fields; TaxSummary uses `settled` only; Moov split terminal sync is incomplete |

Three parallel recipient concepts must be unified later (without creating a fourth): `stakeholder_accounts`, `external_payment_recipients`, free-text names.

---

## 6. Tax / 1099 foundation

The system must **not** decide who requires a 1099. It should preserve totals and supporting records.

| Need | Status |
|---|---|
| Legal / payee identity | Partial — TIN + name + address on string-keyed profile; rename/typo forks identity |
| Business / entity type | Partial — inferred from payment `account_type`; **not stored on tax profile** |
| Tax-information status | Partial — masked `tin_on_file` / last-4 via `tenant-tax-profiles` |
| W-9 status / document reference | **Not integrated** with tax profiles or payment rows |
| Annual gross payments | Partial — UI year totals from settled splits + cash jobs only |
| Payment categories | Partial — type/method, not on profile |
| Excluded / reversed / voided | Weak — settled-only; returns may not flip Moov splits |
| Reporting year | Derived from timestamps; no persisted `reporting_year` |

`src/lib/taxYtdSummary.ts` already labels the $600 flag as **not a filing determination**. Keep that boundary.

TIN remains plaintext at rest in `recipient_tax_profiles` (containment PRs exist; encryption is a separate authorized job). Do not expand tax UI in this workstream.

---

## 7. Revenue / profit integrity

### 7.1 Recommended authority (not implemented as one system)

| Concept | Should be | Current |
|---|---|---|
| Invoice issued | Obligation row with dates/status | Missing for platform→tenant |
| Revenue earned | Accrual on `platform_fee_line_items` (or journal posting referencing it) | Counted in P&L even if uncollected |
| Cash received | Settled provider-tied payment | Authorized model does this for fee ops; treasury P&L does not |
| Non-revenue movement | `economic_kind = funding \| settlement \| sweep \| internal_transfer` | `leg_role` exists but P&L does not filter it |
| Refunds | Reversal postings linked to original provider id | Status flags only |
| Expenses | Platform opex + classified provider fees | Provider fees on **all** transfers |
| Recipient payments | Tenant fiduciary / vendor spend | Tenant RevenueSummary mislabels check deposits as “revenue” |
| Provider fees | Cost of collection vs cost of tenant rails | Flattened |
| Internal ChecksOps transfers | Neither revenue nor expense | Wallet/sweep/facilitator moves look like transfers |

### 7.2 Wallet is not profit

- Tenant `payment_wallet_ledger` is a **cash-position subledger**.
- Platform wallet display is **live Moov API** (`platform-treasury` `walletPayload`). There is **no platform `payment_wallets` row**.
- `syncWallet` can overwrite `payment_wallets.available_cents` from Moov while the ledger trigger also mutates the same column. Sweeps and Moov-only adjustments make **ledger sum ≠ Moov balance**.
- Tenant `RevenueSummary` “profit” = deposited checks − disbursements. That is **claim cash flow**, not SaaS profit.

### 7.3 Silent duplication risks

| Risk | Why |
|---|---|
| Fee pull + occurrence + line item + wallet txn | Same Moov transfer can appear in notes, occurrence `provider_transfer_id`, live wallet list, and (if later copied) `payment_transfers` |
| Authorized receivables already de-dupes by provider id when assembling maintenance + occurrence rows | Good pattern; keep it. Totals skip duplicate keys. |
| Trust wallet double credit | `moov-transfer-group-create` posts `group-parent:{id}` **and** webhook may post `transfer:{parent_id}` — different `reference` values, both can apply |
| P&L double-count | Usage line items **and** `platform_fee_cents` on parent legs are both summed (`moovSchedules.ts` intends two rails; events can still overlap) |
| Reporting the same Moov txn from API and ledger | Wallet panel shows Moov transactions; ledger shows transfer-driven entries; no `provider_wallet_transaction_id` dedupe |
| Disbursement vs `payment_transfers` | `moov-disburse` stores `moov_transfer_id` on **splits**, not `payment_transfers`. Two execution ledgers |
| Stripe vs Moov vs credits | Same month’s “fees” can exist as Stripe meter, credit deduction, and Moov ACH |

**Rule:** Financial reports must key off durable ChecksOps rows + provider transfer id. Moov is settlement/bank truth for **reconciliation**, not the only historical record. Never add a Moov-list row into revenue because it also exists internally.

---

## 8. Should Platform Finance ultimately contain these sections?

**Yes — as a later product structure. Do not build these tabs in this workstream.**

| Section | Needed? | Now | Data to reuse |
|---|---|---|---|
| Overview | Yes | Partial P&L + wallet cards | Classified postings + settled cash + outstanding; **not** wallet-as-profit |
| Banking / Wallet | Yes | Implemented (authorized read) | Moov bank + wallet **plus** unmatched-txn exceptions |
| Revenue | Yes | Mixed P&L | `platform_fee_line_items` earned vs collected |
| Invoices & Receivables | Yes | Authorized ledger (branches / prod read path) | Same local-operation-first model; later persist invoice + cash status |
| Payments | Yes | Missing platform-wide | `payment_transfers` + fee pulls once they share execution rows |
| Payments by Recipient | Yes | Tenant-only, incomplete | Durable payee + all outbound rails |
| Reconciliation | Yes | Exception flags + AWS sim | Internal id ↔ Moov id; no auto-correct |
| Tax / 1099 Reports | Yes (totals only) | Tenant Tax tab | Annual payments; no filing conclusion |

Keep tenant Payments tabs for **tenant fiduciary / customer** books. Do not merge those numbers into platform profit.

---

## 9. Gaps (implementation later; not this PR)

### P0 — integrity (must resolve before “profit” or tax totals are trusted)

1. **No economic classification** on money movement (`invoice`, `revenue_earned`, `cash_received`, `internal_transfer`, `refund`, `expense`, `recipient_payment`, `provider_fee`, `wallet_funding`).
2. **Fee collection bypasses `payment_transfers`**, so webhook, event log, and wallet ledger cannot attach.
3. **Platform wallet has no durable ledger**; history is a live Moov list.
4. **P&L volume / provider cost include non-revenue transfers.**
5. **No canonical tenant invoice / open AR entity** with due date and adjustments.

### P1 — recipient / tax foundation

6. Free-text payees on external checks and cash jobs.
7. Tax profiles keyed by name string; no FK; no entity type; no W-9 document FK.
8. Mortgage Agents are a role, not a payee record.
9. Tax / recipient reports omit `payment_transfers` and wallet debits.
10. Reversals not netted consistently (especially Moov disbursement split status).

### P2 — completeness / UX later

11. Three monthly-fee models (Moov monthly, usage schedule, Stripe).
12. Dual bank-authorization tables.
13. Sweeps / Moov-only adjustments not in ledger.
14. No aging, no platform payables, no recorded platform opex besides provider fees.
15. Claim / homeowner ledgers are narrative, not books.

**Reuse first.** Do not add a second `general_ledger` that recopies amounts from `payment_transfers` and fee tables. If a journal is added later, it should **reference** existing row ids and store classification + posting keys only.

---

## 10. Recommended phased implementation (later authorized workstreams)

Each phase is a **separate** authorization. None of this is in scope for the current narrow Platform Finance implementation.

### Phase A — Classify existing execution rows (no new money movement)

- Add `economic_kind` (or equivalent) to `payment_transfers` and map `leg_role` (`wallet_funding`, `parent`, payout, facilitator).
- Filter platform P&L: revenue = classified platform fees only; exclude funding, settlement volume, and internal transfers from revenue/volume/cost.
- Document the two fee rails (`platform_fee_line_items` vs `platform_fee_cents`) and add a uniqueness rule so one business event cannot count twice.
- Keep authorized receivables read model unchanged.

### Phase B — Close the fee-pull chain (schema + writers; still no “new accounting system”)

- Persist `provider_transfer_id` as a real column on `tenant_maintenance_payments` (stop relying on `notes`).
- Insert a `payment_transfers` (or equivalent execution) row for platform fee collections so webhook / event log / ledger can attach.
- Backfill occurrence `provider_transfer_id` and terminal status from webhook, not from “billed at schedule create.”
- Add platform wallet ledger entries **or** postings keyed by the same provider id.
- Received cash = provider settled only (already true in authorized read model).

### Phase C — Canonical tenant obligation (invoices & AR)

- Introduce a thin obligation/invoice row **or** formally promote one existing table, linking line items, charge attempts, and settled transfers.
- Fields: invoice date, due date, status, billed, settled, adjustments, outstanding.
- Credits/refunds as adjustment rows pointing at the obligation and the reversing provider id.
- Then — and only then — build Invoices & Receivables as more than a read-model over two tables.

### Phase D — Durable payees + tax totals

- Require `stakeholder_account_id` or `external_payment_recipients.id` (or tenant id) on new outgoing payments; migrate free-text to payee records.
- Add Mortgage Agent / vendor / business / individual as **payee types** where product needs them (do not invent 1099 conclusions).
- FK `recipient_tax_profiles` to the payee id; store entity type if collected; W-9 as document reference.
- Annual report = settled − reversed, by payee, year, category. Informational thresholds stay informational.

### Phase E — Reconciliation UI

- Durable findings table (production), modeled on authorized exception flags + AWS recon types.
- Compare: internal execution row ↔ Moov transfer ↔ wallet transaction ↔ bank sweep.
- Report only until a correction workstream is authorized. `auto_corrected` stays false.

### Phase F — Platform Finance tabs

Build Overview, Revenue, Payments, Payments by Recipient, Reconciliation, Tax totals **after** A–E have durable classified rows. Do not ship tabs that re-query live Moov as the books.

---

## 11. What this document does not change

- Authorized Platform Finance read path (Banking, Wallet & P&L, receivables attribution, tenant billing history).
- Billing calculation, Moov resources, Mortgage Agents, invoices, payments, ACH, fees, SQL/RLS, deployments.
- Tenant Payments tabs (those remain tenant-scoped operational finance).

**SAFE TO IMPLEMENT FROM THIS AUDIT = NO.**  
This is evidence and a phased plan only.

---

## 12. Key file index

| Area | Path |
|---|---|
| Platform Finance UI (`main`) | `src/pages/admin/AdminTenants.tsx`, `src/components/admin/PlatformBankPanel.tsx`, `src/components/admin/PlatformTreasuryPanel.tsx` |
| Platform treasury API | `supabase/functions/platform-treasury/index.ts` |
| AWS treasury / bank (`main`) | `aws/functions/api/providers/parity/moov-onboard.mjs` (`platformTreasury`, `platformBank`) |
| Authorized receivables (not on this `main`) | `aws/functions/api/providers/parity/tenant-receivables.mjs`, `PlatformReceivablesLedger.tsx`, `TenantBillingHistoryPanel.tsx` (PR #546) |
| Fee charge | `supabase/functions/moov-tenant-fee-charge/index.ts` |
| Fee rollup / schedules | `supabase/functions/moov-fee-rollup/index.ts`, `supabase/functions/_shared/moovSchedules.ts` |
| Transfer + webhook | `supabase/functions/moov-transfer-create/index.ts`, `moov-webhook/index.ts` |
| Wallet ledger | `supabase/migrations/20260730191230_*.sql`, `supabase/functions/_shared/moovWallet.ts` |
| Fee schema | `supabase/migrations/20260731174507_*.sql` |
| Transfer / recipient schema | `supabase/migrations/20260727224957_*.sql` |
| Maintenance payments | `supabase/migrations/20260708180114_*.sql` |
| Tax profiles | `supabase/migrations/20260709195755_*.sql`, `src/lib/taxYtdSummary.ts` |
| Tenant Payments | `src/pages/Payments.tsx`, `RevenueSummary.tsx`, `RecipientReport.tsx`, `TaxSummary.tsx` |
| Tenant invoices | `supabase/migrations/20260819015105_*.sql`, `src/pages/payments/InvoicesTab.tsx` |
| Execution inventory | `aws/financial/FINANCIAL_EXECUTION_INVENTORY.md`, `aws/financial/RECONCILIATION.md` |
