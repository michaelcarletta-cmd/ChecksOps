# Payments & Financials Editability — Diagnosis + Implementation Plan

**Workstream:** Tenant Payments & Financials editability (isolated)  
**Authorization:** DIAGNOSIS + IMPLEMENTATION PLAN ONLY  
**Date:** 2026-10-05  
**STOP:** No implementation. No AWS writes. No deployment. No SQL/RLS apply. No production. No staging data mutation. No Moov changes. No money movement.

This audit covers every Edit / Save / Add / Delete / classification / notes control currently exposed on the tenant **Payments & Financials** page (`src/pages/Payments.tsx`). It is **not** Platform Finance, WalletOps, Check Command Center Funds, Stakeholders, or Settings branding.

Preserve the accepted **31/31 Payments accuracy** model (`recipientAggregateKey`, `isSelfDestination`, Received = own deposited/funds_released + incoming settled, Paid = outgoing settled external, Profit = Received − Paid). A display-name or type edit must not rewrite `recipient_tenant_id` / `destination_tenant_id`.

---

## 0. Fresh-read live identity (this turn)

Read-only. No Lambda overlay, SPA upload, SQL, or data mutation.

| Target | Fresh-read 2026-10-05T00:27Z | Compose apply record | Drift |
|---|---|---|---|
| Staging SPA entry | `/assets/index-DxJGUt9C.js` | `/assets/index-DxJGUt9C.js` | none |
| Staging `index.html` SHA-256 | `29a7fa5a6948ebf2e20136cfead50ae4c978d2ded986f2e98487b702446a1606` | same | none |
| Staging `index.html` last-modified | `2026-10-05T00:08:03+00:00` | same | none |
| Staging `index.html` ETag | `186a3d96ac532329cc0d46fb7c693460` | same | none |
| Staging Lambda | `checksops-staging-api` | same | none |
| Staging Lambda CodeSha256 | `/0Wyipd63VyUCg97uzp4ppFHAnC9RLHeqBNOJCZZth8=` | same | **unchanged** |
| Staging Lambda RevisionId | `a7ace3ea-006c-423e-a26d-87857c1e696a` | same | **unchanged** |
| Staging Lambda last modified | `2026-10-04T20:34:40.000+0000` | same | none |

Staging Lambda env flags (read-only `GetFunctionConfiguration`):

| Flag | Live staging value | Meaning for this audit |
|---|---|---|
| `AWS_WRITES_ENABLED` | `true` | Generic `/data/write` is **on**. Recipient Save still never reaches it. |
| `AWS_CHECK_WORKFLOW_WRITES_ENABLED` | `true` | Unrelated check-workflow writes. |
| `AWS_APPLICATION_WORKFLOW_WRITES_ENABLED` | `true` | Unrelated app-workflow writes. |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | `true` | `moov-invoice` / `moov-disburse` **can** enter sandbox parity handlers. |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `false` | Production provider master off. |
| `AWS_MOOV_ENABLED` | `false` | Production Moov flag off. Sandbox parity still gated by the sandbox flag. |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | `true` | Webhooks do not apply payment mutations. |
| `CHECKSOPS_ENV` | `staging` | Confirm target. |

Production (observed only; **do not touch**):

| Target | Fresh-read | Prior compose proof |
|---|---|---|
| Production SPA | `/assets/index-Bbftik1r.js` | `/assets/index-BgOCQCWm.js` |
| Production Lambda `checksops-production-prep-api` | `RUOC6wUAE9eCkhbhF8h8FAfUyegj9KCrvZt5vCojOlw=` rev `48b8b0da-7448-435b-b9ea-d068a4497f1e` (modified `2026-10-05T00:15:53`) | `CWB8lxnHoqANyVcaNpKL7h4MtDSPMlHZ6wliFuGE6yA=` |

Another workstream changed production after the Payments SPA compose. This diagnosis does not reclaim or overlay production.

Release locks (`ops/release-locks/locked-components.json`):

- Signature-request staging lock still pins Lambda `aZ0K2droM3XKT0eQRUYdHEKwW0ehTlAy8VY/qm7YCgE=` / SPA `/assets/index-DDibq3aS.js`. That lock is **stale vs current live** (`/0Wyipd63…` + `index-DxJGUt9C.js`). It is a baseline freeze, not current live identity.
- Production SPA lock remains `PRODUCTION_LOCKED` to an earlier `index-HXTuSrE0.js` baseline. Live production has moved again. This workstream must not treat that lock as authorization.

Artifacts: `/opt/cursor/artifacts/payments-editability-audit/staging-lambda-summary.json`, `production-lambda-summary.json`.

---

## 1. Known UAT failure — exact write path

**UI:** Payments → By Recipient → pencil on a recipient (UAT: Jean Lindner) → Edit recipient → **Save changes**.

**Frontend:** `RecipientReport.saveEdit` in `src/components/ledger/RecipientReport.tsx`.

```ts
await supabase.from("disbursement_splits")
  .update({ recipient_name: newName, recipient_type: editType })
  .eq("tenant_id", tenant.id)
  .eq("recipient_name", editTarget.name)
  .eq("recipient_type", editTarget.type);
```

**Request actually issued:** none to Lambda. The AWS client short-circuits.

**Exact blocked write:**

1. `src/integrations/aws/client.ts` `AWS_WRITE_TABLES` (lines 38–70) does **not** include `disbursement_splits`.
2. Any non-select on a non-allowlisted table returns immediately:

```ts
error: postgrestError("writes_disabled", "42501", {
  hint: "This table is not in the AWS write allowlist",
})
```

Toast: `Couldn't update recipient` / `writes_disabled`.

**Secondary blocks (never reached today):**

3. Even if the client allowlisted the table, `aws/functions/api/write.mjs` + `write-allowlist.mjs` deny `disbursement_splits` as `FINANCIAL_OR_PROVIDER_TABLES` (`reason: financial_or_provider`).
4. `/data/query` refuses non-select with `writes_disabled` (`default_transaction_read_only`).
5. Display name/type prefer `stakeholder_accounts.nickname` / `account_type` over split fields. Save filters by **displayed** name/type, not `aggregateKey`. A Jean Lindner stakeholder row would not match `disbursement_splits.recipient_name` even if the write were allowed, and a split-only update would not survive refresh.

**This is not a missing RLS policy.** Source already has `aws_write_disbursement_splits` (`aws/rls/sql/24_complete_write_policies.sql`) using `aws_can_write_tenant(tenant_id)`. The gap is the **missing dedicated AWS accounting-metadata write contract**. Do **not** add `disbursement_splits` to the generic client/server allowlist.

---

## 2. Complete editability / action inventory

Column key: **persist** = survives refresh/logout/login; **WD** = blocked by client or server `writes_disabled`; **AWS miss** = no correct AWS implementation for the intended persist; **SQL/RLS miss** = source policy/function actually missing for the intended persist; **safe** = safe to make editable under the money-movement + durable-tenant-identity boundary.

Status codes: **WORKS** (local or already persisted) · **BROKEN** · **PROVIDER/MONEY** (intentionally not a metadata edit) · **INTENTIONALLY DISABLED** · **READ-ONLY**.

### 2.1 Payment History — `PaymentLedger.tsx`

| # | Control | Frontend | Request / RPC | AWS implementation | Tables / columns | Staging result | Persist | WD | AWS miss | SQL/RLS miss | Safe? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| H1 | Search | `PaymentLedger` Input | none | n/a | none | filters in memory | n/a | no | no | no | yes (local) |
| H2 | Date range | Select `this_month/last_month/this_year/all` | none | n/a | none | local | n/a | no | no | no | yes (local) |
| H3 | Type filter | Select | none | n/a | none | local | n/a | no | no | no | yes (local) |
| H4 | Status filter | Select | none | n/a | none | local | n/a | no | no | no | yes (local) |
| H5 | Export CSV | `exportCSV` | none | Blob download | none | downloads current filtered rows | n/a | no | no | no | yes (local) |
| H6 | Per-row **Type** Select | `updateType(id, newType)` | `disbursement_splits.update({ recipient_type }).eq(id)` | none — client `writes_disabled`; server would `financial_or_provider` | intended: `disbursement_splits.recipient_type` only | toast `Could not update type` / `writes_disabled` | no | **yes** | dedicated handler missing | source write policy exists; do not use generic write | **yes as accounting type only**, outgoing `source=disbursement_split` **without** stakeholder, never amount/transfer/status/tenant ids |
| H7 | Type badge (incoming / stakeholder / non-split) | read-only Badge | none | n/a | display from `stakeholder_accounts.account_type` else `recipient_type` | shows; not editable | n/a | no | n/a | no | do not expose a silent type edit on incoming or tenant-to-tenant rows |
| H8 | Amount / status / date / Moov/Actum ids | table cells | none | n/a | `amount`, `status`, `moov_transfer_id`, `settled_at` | read-only | n/a | no | n/a | no | **no** — provider truth |

H6 is the same blocked table as Recipient Save, scoped to one split id. UI only renders the Select when `!acct && direction !== "incoming" && source === "disbursement_split"`.

### 2.2 Invoices — `InvoicesTab.tsx` + `useMoovInvoices.ts`

| # | Control | Frontend | Request / RPC | AWS implementation | Tables / columns | Staging result | Persist | WD | AWS miss | SQL/RLS miss | Safe? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| I1 | List invoices | `useMoovInvoices.invoices` | `moov_invoices.select * eq tenant_id` | `/data/query` select | `moov_invoices` (all columns read) | query allowed; rows only exist if previously persisted | read-only | no | list-via-Moov unused by UI | select policy in source | read-only |
| I2 | New invoice form fields | local state | none until submit | n/a | none | form-only | no | no | n/a | no | form-only |
| I3 | Add / remove line item | local array | none until submit | n/a | none | form-only | no | no | n/a | no | form-only |
| I4 | **Save draft** | `createInvoice` `send=false` | `functions.invoke("moov-invoice")` `action: create` | Parity `invoice.run` (sandbox): POST Moov `/invoices` only. No `create_and_send` / persist `moov_invoices` / send / cancel / delete / sync | intended: `moov_invoices`, `moov_invoice_customers`; also Moov invoice | sandbox Moov create possible; **local list will not show the row after refresh** | **no (local)** | no (provider, not WD) | **yes — incomplete vs Supabase `moov-invoice`** | write policy in source; unused | **not a metadata edit**. Creates a provider invoice / payment-collection object. Separate provider authorization. Do not implement as accounting write. |
| I5 | **Send invoice** (dialog) | `create` + `send=true` | `action: create_and_send` | parity does not implement `create_and_send` (falls through to POST create) | Moov invoice + email + `moov_invoices` | broken / incomplete; may create Moov invoice without send/persist | no | no | **yes** | same | **no as this workstream** — money-collection |
| I6 | Send (draft row) | `sendInvoice` | `action: send` | not implemented in parity | Moov + `moov_invoices.status/sent_at` | fail / unexpected create | no | no | **yes** | same | **no as this workstream** |
| I7 | Resend | `resendInvoice` | `action: resend` | not implemented | email only | fail | no | no | **yes** | n/a | **no as this workstream** |
| I8 | Copy payment link | clipboard | none | n/a | none | works if URL present | n/a | no | no | no | yes (local) |
| I9 | Open invoice page | `window.open` | none | n/a | none | navigation | n/a | no | no | no | yes (local) |
| I10 | Cancel invoice | `cancelInvoice` | `action: cancel` | not implemented | Moov cancel + `moov_invoices.status` | fail | no | no | **yes** | same | **no as this workstream** — provider status |
| I11 | **Delete invoice** | `deleteInvoice` | `action: delete` | not implemented | should be local row + Moov draft delete, **not** provider transfer history | fail | no | no | **yes** | same | delete **draft/canceled local row only** after provider workstream; never delete settled payment history |
| I12 | Refresh | `syncInvoices` | `action: sync` | not implemented | `moov_invoices` status/paid_amount from Moov | fail | no | no | **yes** | same | provider sync; not metadata |
| I13 | Invoice Branding | navigate to Settings | none here | Settings `tenants` allowlist (`invoice_letterhead_url`, `invoice_footer_note`, `invoice_default_terms`) | `tenants` branding columns | out of this page | Settings path | no | no (Settings) | no | branding only; not Platform Finance |

Because `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=true`, invoice invokes **do not** return the dry `provider_disabled` stub. They enter the incomplete parity handler, which can call **live Moov sandbox HTTP**. That is worse than a clean disable: create may move provider state without a durable tenant row. Do not exercise I4–I12 in this workstream.

### 2.3 Revenue & Profit — `RevenueSummary.tsx`

| # | Control | Frontend | Request / RPC | AWS implementation | Tables / columns | Staging result | Persist | WD | AWS miss | SQL/RLS miss | Safe? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| R1 | Entire tab | `RevenueSummary` | `check_intake_items` select + `fetchTenantPaymentLedgerRows` | `/data/query` + `get_tenant_funds_received` RPC | checks (`deposited`/`funds_released`); ledger rows | **read-only; 31/31 accuracy** | n/a | no | no | no | keep read-only. No Save/Add/Delete. |

No editable field is exposed. Do not add writes here.

### 2.4 By Recipient — `RecipientReport.tsx`

| # | Control | Frontend | Request / RPC | AWS implementation | Tables / columns | Staging result | Persist | WD | AWS miss | SQL/RLS miss | Safe? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| B1 | Category tiles | local `typeFilter` | none | n/a | none | filter | n/a | no | no | no | yes (local) |
| B2 | Search | local | none | n/a | none | filter | n/a | no | no | no | yes (local) |
| B3 | Date range | local | none | n/a | none | filter | n/a | no | no | no | yes (local) |
| B4 | Type filter | local | none | n/a | none | filter | n/a | no | no | no | yes (local) |
| B5 | Export CSV | Blob | none | n/a | none | download | n/a | no | no | no | yes (local) |
| B6 | Edit pencil | `openEdit(name, type, count)` | none | n/a | uses **displayed** name/type, not `aggregateKey` | opens dialog | n/a | no | n/a | no | dialog OK; save must key by `aggregateKey` |
| B7 | Recipient name | Input `editName` | none until save | n/a | intended display name | form | no | no | n/a | no | **yes as display name**. Must not rewrite tenant ids or bank legal name as a side effect of a nickname edit. |
| B8 | Type / category | Select `editType` | none until save | n/a | intended accounting type | form | no | no | n/a | no | **yes as accounting classification** |
| B9 | **Save changes** | `saveEdit` | `disbursement_splits.update({ recipient_name, recipient_type })` filtered by displayed name+type | **missing dedicated Class A**. Generic write denied. | intended metadata only; current code would also miss stakeholder-display rows and can collide same-name rows | **`writes_disabled`** | **no** | **yes (client)** | **yes** | source `aws_write_disbursement_splits` exists; **not** the missing piece | **yes with new contract** (see §5). Not safe via generic table write. |
| B10 | Cancel | close dialog | none | n/a | none | works | n/a | no | no | no | yes |

**No Delete/Remove** exists on this tab.

### 2.5 Tax & 1099 — `TaxSummary.tsx` (role-gated)

| # | Control | Frontend | Request / RPC | AWS implementation | Tables / columns | Staging result | Persist | WD | AWS miss | SQL/RLS miss | Safe? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| T1 | Year / month / search / type filters | local | none | n/a | none | filter | n/a | no | no | no | yes |
| T2 | Export payment summary | `buildPaymentReportingCsv` | none | n/a | none | download; no TIN | n/a | no | no | no | yes |
| T3 | Secure tax-form generation | Button `disabled` | none | none | none | labeled coming soon | n/a | no | intentionally absent | n/a | keep disabled (IRS filing out of scope) |
| T4 | List tax profiles | `tenant-tax-profiles` `action: list` | `functions.invoke` | Class A `tax-profiles.mjs` `handleList` via `withIdentity` | `recipient_tax_profiles` masked columns | **not blocked by `writes_disabled`**. Succeeds if identity + table exist. Editor disables if list errors. | read | no | no | source select + `aws_can_access_tax_profiles` (containment SQL is marked unapplied — live apply **not confirmed** this turn) | yes (read) |
| T5 | Tax info edit + **Save** | `saveProfile` | `tenant-tax-profiles` `action: upsert` + optional `tin` | Class A `handleUpsert` via `withIdentityWrite`. Not `/data/write`. Generic write of this table is `tax_secret_denied`. | `recipient_tax_profiles`: `recipient_name`, `tin` (replace-only), `address_*`, `account_number`, `notes`. Conflict `(tenant_id, recipient_key)`. | **likely the only Payments write that can persist today** if list succeeded. Not proven by a live upsert this turn (no data mutation). | expected yes | **no** | no | app-level access in handler; RLS helper apply unconfirmed | **yes** for authorized finance roles. Never return full TIN. |
| T6 | Notes (tax profile) | `form.notes` | same upsert | same | `recipient_tax_profiles.notes` | same as T5 | expected yes | no | no | same | yes |
| T7 | Retry list | `refetchTaxProfiles` | list again | same as T4 | same | works as retry | n/a | no | no | no | yes |

Tax Save is **not** the Jean Lindner `writes_disabled` path.

### 2.6 Payroll — `PayrollTab.tsx` + `RunPayrollDialog.tsx` + `PayrollHistoryTable.tsx` (admin)

| # | Control | Frontend | Request / RPC | AWS implementation | Tables / columns | Staging result | Persist | WD | AWS miss | SQL/RLS miss | Safe? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P1 | History table | `PayrollHistoryTable` | `payroll_runs.select` | `/data/query` | `payroll_runs` + embeds | read-only | n/a | no | no | select in source | read-only |
| P2 | Memo display | table cell | none | n/a | `payroll_runs.memo` | display only | n/a | no | no | no | do not add in-place memo edit on a submitted run |
| P3 | New Payroll form | payee / amount / speed / memo | none until confirm | n/a | none | form | no | no | n/a | no | form-only |
| P4 | **Yes, send** | `runMutation` | insert `disbursement_batches`, `disbursement_splits`, `payroll_runs`; then `moov-disburse`; then update `payroll_runs.status` | inserts hit client `writes_disabled` (none of those tables are in `AWS_WRITE_TABLES`; all three are `FINANCIAL_OR_PROVIDER`). `moov-disburse` is sandbox parity **money movement**. | batch/split/run + Moov transfer | **fails at first insert** with `writes_disabled` before Moov | no | **yes** | money path exists in parity; must stay out of this workstream | write policies exist; irrelevant | **no** — initiates ACH / Moov transfer / wallet debit |

### 2.7 Controls that do **not** exist (and must not be added as silent deletes)

There is **no** Delete/Remove on Payment History, Revenue, By Recipient, Tax rows, or Payroll history.

Invoice Delete (I11) is the only destructive control in this section. Semantics: remove a **draft/canceled invoice document**, never a settled provider transfer or `disbursement_splits` history.

Adjacent (out of section, feeds the ledger): Check Command Center `FundsTab` inserts `disbursement_batches` / `disbursement_splits` for external checks — same `writes_disabled` + financial-table deny. Do not patch it as a Jean Lindner workaround.

---

## 3. What works today vs what is broken

### Works (local or read-only)

- All filters, search, date/type/status/month tiles, CSV exports, copy-link, navigation, Revenue math, Payment History/Recipient/Tax **reads** through the accuracy query where wired.
- Tax profile **list/upsert contract exists** in live Lambda source lineage (Class A, not generic write). Live upsert not exercised this turn.

### Broken / disabled (accounting metadata that the UI offers)

| Control | Root cause |
|---|---|
| **B9 Recipient Save** | Client `AWS_WRITE_TABLES` miss → `writes_disabled`. Server would deny `financial_or_provider`. Save keys displayed name/type, not `aggregateKey`. Stakeholder-linked display would not persist even after a successful split update. |
| **H6 Payment History type Select** | Same client `writes_disabled` on `disbursement_splits.update({ recipient_type })`. |

### Broken but **must not** be “fixed” as accounting metadata

| Control | Root cause | Correct treatment |
|---|---|---|
| I4–I12 invoice create/send/cancel/delete/sync | Incomplete AWS `moov-invoice` parity; sandbox flag **on**; no `moov_invoices` persist | Separate provider workstream. Do not generic-write `moov_invoices`. Do not call Moov from this plan. |
| P4 payroll send | Client `writes_disabled` on financial inserts + `moov-disburse` money path | Keep blocked. Money-movement boundary. |
| T3 tax-form generation | Intentionally disabled | Keep disabled. |

### Display / persist mismatch (even after a future write)

Recipient Report and Payment History **render** `stakeholder_accounts.nickname/custname/account_type` over split `recipient_name/recipient_type`. Accuracy **groups** by `recipientAggregateKey`: `tenant:` then `acct:` then `ext:type|name`. Current Save ignores that key. Jean Lindner is the expected stakeholder/`acct:` case.

---

## 4. Root-cause stack (all broken paths)

```
UI save
  → supabase.from("disbursement_splits").update(...)
    → AWS client execute() non-select
      → AWS_WRITE_TABLES.has("disbursement_splits") === false
        → 403 writes_disabled   ← UAT stop (B9, H6, P4 inserts)
          [never reaches Lambda]
            → /data/write WRITE_ALLOWLIST miss
              → FINANCIAL_OR_PROVIDER_TABLES → financial_or_provider
            → /data/query non-select → writes_disabled
```

Invoice/payroll functions:

```
functions.invoke("moov-invoice"|"moov-disburse")
  → POST /functions/v1/...
    → Class A miss
      → handleProviderRequest
        → AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=true
          → parity handler
            moov-invoice: create/list only; no persist; no send/cancel/delete/sync
            moov-disburse: money movement (out of scope)
```

Tax:

```
functions.invoke("tenant-tax-profiles")
  → Class A handleTaxProfiles
    → list: withIdentity
    → upsert: withIdentityWrite
      → NOT gated by AWS_WRITE_TABLES
```

---

## 5. Proposed AWS write contracts

**Do not** add `disbursement_splits`, `disbursement_batches`, `payroll_runs`, `moov_invoices`, `recipient_tax_profiles`, or `stakeholder_accounts` to `AWS_WRITE_TABLES` / `WRITE_ALLOWLIST`.

Add one Class A function, same pattern as `tenant-tax-profiles`:

### `tenant-payment-accounting`

Routed in `app-services.mjs` **before** `handleProviderRequest`. Uses `withIdentityWrite`. Never calls Moov.

#### Action `update_recipient_display`

Request:

```json
{
  "action": "update_recipient_display",
  "tenant_id": "<payer tenant uuid>",
  "aggregate_key": "tenant:<uuid>|acct:<uuid>|ext:<type>|<name>",
  "display_name": "Jean Lindner",
  "display_type": "subcontractor"
}
```

Server rules:

1. Caller must be a writer on `tenant_id` (`aws_can_write_tenant` / membership owner-admin). Cross-tenant denied.
2. Parse `aggregate_key`. Reject unknown shapes.
3. **Refuse** any payload field that is `recipient_tenant_id`, `destination_tenant_id`, `amount`, `moov_transfer_id`, `plaid_transfer_id`, `status`, `settled_at`, `stakeholder_account_id`, bank account / routing, or Platform Finance fields.
4. Branch:
   - **`tenant:`** — upsert **overlay only** (`tenant_payment_recipient_overrides`). Never `UPDATE` the other tenant, never rewrite split `recipient_tenant_id` / transfer `destination_tenant_id`. Reassignment of a payment to a different company is a **different action** (not in v1).
   - **`acct:`** — `UPDATE stakeholder_accounts SET nickname = display_name, account_type = display_type, updated_at = now() WHERE id = :id AND tenant_id = :payer`. Column lock: nickname + account_type only. Never `custname`, `chk_acct`, `consumer_unique`, `is_primary`, verification, Moov bank ids.
   - **`ext:`** — resolve current outgoing split ids for that key (`tenant_id = payer`, `recipient_tenant_id IS NULL`, `stakeholder_account_id IS NULL`, name/type match the key). `UPDATE disbursement_splits SET recipient_name, recipient_type WHERE id = ANY($ids)`. Column lock: those two columns only.
5. Write `audit_logs` via existing `log_audit` bridge (`action=payment_recipient_display_update`, old/new name+type+key, split/stakeholder ids).
6. Return `{ ok, aggregate_key, kind, updated_count }`. Clear 4xx on validation / forbidden.

#### Action `update_split_type`

Request:

```json
{
  "action": "update_split_type",
  "tenant_id": "<payer tenant uuid>",
  "split_id": "<uuid>",
  "display_type": "vendor"
}
```

Server: load split; require `tenant_id` match; refuse if `recipient_tenant_id` set or `stakeholder_account_id` set or incoming/self-destination; update `recipient_type` only; audit.

#### Action `reassign_recipient_identity` — **not in v1**

Explicit future operation if product needs to move a payment from one durable recipient to another. Requires separate validation, confirmation, and audit. Must never be implied by a name typo-fix.

### Frontend wiring (implementation phase only)

- `RecipientReport.saveEdit`: send `aggregateKey` (already computed, not passed to the dialog today) + new name/type to `tenant-payment-accounting`. Stop calling `.from("disbursement_splits").update`.
- `PaymentLedger.updateType`: `update_split_type`. Same.
- Invalidate `payment-ledger`, `recipient-report`, `tax-summary`, `revenue-summary-outgoing` so History / Recipients / Tax / Revenue stay consistent. Accuracy **totals do not change** (amount/status/direction untouched). Type tiles/filters regroup.
- Apply overlays when reading `tenant:` rows (name/type only).
- Keep Tax `tenant-tax-profiles` as-is. `recipient_key` should remain the accuracy key (`acct:`, `ext:`, `tenant:`) so a rename does not orphan TIN rows. If `ext:` type/name changes, server should migrate `recipient_tax_profiles.recipient_key` in the same transaction or keep the old key and store `recipient_name` as display. Prefer **stable key**: for `ext:` after rename, update the profile key in the same write, or key tax profiles by split-set hash. Recommended: tax profiles stay keyed by `acct:` / `tenant:` / a stable `ext` surrogate; do not use mutable `ext:type|name` as the durable tax key going forward (follow-up, do not break existing keys).

### Money-movement refusal list (handler must unit-test)

Never: change amount; change provider transfer IDs; change real sender/receiver of an executed transfer; change settled/failed provider status; initiate ACH; move wallet funds; create a Moov transfer; modify a bank account; change Platform Finance; alter Moov configuration; insert duplicate financial rows.

---

## 6. Proposed SQL / RLS

**Not required to unblock Recipient Save** if the Class A handler uses the write connection and enforces tenant + column locks in application code (same as tax-profiles). Source already has:

- `aws_write_disbursement_splits` — `aws_can_write_tenant(tenant_id)` (too broad for generic client writes; acceptable behind a column-locked handler).
- `aws_write_stakeholder_accounts` — same tenant writer check.
- `aws_select_*` for splits, stakeholders, tax profiles, invoices.
- `aws_write_recipient_tax_profiles` — `aws_can_access_tax_profiles(tenant_id)`.

**Possibly required if v1 uses overlays:**

```sql
CREATE TABLE public.tenant_payment_recipient_overrides (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  aggregate_key text NOT NULL,
  display_name text NOT NULL,
  display_type text NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, aggregate_key)
);
-- RLS: select/write via aws_can_access_tenant / aws_can_write_tenant
-- GRANT to checksops + authenticated
```

Apply only in a later reviewed `sql-apply` workstream. Live apply of `aws_can_access_tax_profiles` is **unconfirmed** (`aws/tax/sql/unapplied-do-not-run/`). Tax handler currently evaluates access in JS (`evaluateTaxAccess`) and then INSERTs; if RLS is enabled and the SQL helper is missing, T5 would fail with `rls_denied` / missing function — **not** `writes_disabled`. Confirm read-only in the implementation workstream before assuming T5 works.

**Do not** grant generic `INSERT/UPDATE/DELETE` on financial tables to the SPA.

---

## 7. Audit / history strategy

Use the existing `log_audit` safe-write RPC (`workflow-rpc.mjs` `executeLogAudit` → `audit_logs`).

| Event | `action` | `record_type` | payload |
|---|---|---|---|
| Recipient display save | `payment_recipient_display_update` | `payment_recipient` | aggregate_key, kind, old/new name+type, updated_count, split/stakeholder ids |
| Per-split type | `payment_split_type_update` | `disbursement_split` | split_id, old/new type |
| Tax upsert | already implicit via `recipient_tax_profiles.updated_at`; add `tax_profile_upsert` (no TIN in `new_values`) | `recipient_tax_profile` | recipient_key, tin_replaced boolean only |
| Invoice/payroll | provider/money audit stays with those workstreams | — | — |

Do not put TIN, bank account numbers, or provider secrets in audit JSON. `user_id` is server-derived.

Delete/void: no accounting-row delete in v1. If a later product wants to hide an external-check **mis-entry**, use `excluded_from_reporting` / void flag — never `DELETE` a row with `moov_transfer_id` / settled provider status.

---

## 8. Files / tables / functions affected (implementation phase)

**Frontend (source-only later):**

- `src/components/ledger/RecipientReport.tsx` — pass `aggregateKey`; invoke Class A; stop generic split update.
- `src/components/ledger/PaymentLedger.tsx` — `update_split_type`.
- `src/integrations/aws/client.ts` — **do not** add financial tables to `AWS_WRITE_TABLES`.
- Optional: `src/lib/payments/tenantPaymentAccuracy.ts` apply overlay name/type for `tenant:` keys (math unchanged).
- `src/components/ledger/TaxSummary.tsx` — consume overlay / renamed keys so reporting matches. Do not change Received/Paid/Profit.

**AWS Lambda (later overlay; not this turn):**

- new `aws/functions/api/payment-accounting.mjs`
- `aws/functions/api/app-services.mjs` — register `tenant-payment-accounting`
- tests: `aws/tests/payment-accounting-metadata.test.mjs`

**SQL (later apply only if overlay table chosen):**

- new `aws/rls/sql/??_tenant_payment_recipient_overrides.sql`

**Tables:**

| Table | v1 write? | Columns |
|---|---|---|
| `tenant_payment_recipient_overrides` | yes if overlay | display_name, display_type |
| `stakeholder_accounts` | yes for `acct:` | `nickname`, `account_type` only |
| `disbursement_splits` | yes for `ext:` / `update_split_type` | `recipient_name`, `recipient_type` only |
| `audit_logs` | yes | via `log_audit` |
| `recipient_tax_profiles` | already via Class A | unchanged |
| `payment_transfers.destination_tenant_id` | **never** | — |
| `disbursement_splits.recipient_tenant_id` / amount / moov_* / status | **never** | — |
| `moov_invoices` / `payroll_runs` / `disbursement_batches` | **not this workstream** | — |

**Must not change:** `tenantPaymentAccuracy` settlement rules, `get_tenant_funds_received`, Moov writers, Platform Finance, production.

---

## 9. Test plan (proves edit/save without touching Moov)

No staging data mutation in **this** diagnosis turn. Implementation-phase tests:

### Automated (required before any later deploy)

1. Keep **31/31** `tests/tenant-payment-accuracy.test.ts` + proposed settlement + ephemeral invariants green. Name/type overlay fixtures must not change Received/Paid/Profit.
2. New handler tests:
   - `acct:` updates nickname/type only; asserts SQL/bind has no `recipient_tenant_id`, amount, `moov_transfer_id`.
   - `tenant:` writes overlay only; split/transfer tenant ids unchanged.
   - `ext:` updates only unlocked split ids; refuses rows with `recipient_tenant_id` or `stakeholder_account_id`.
   - `update_split_type` refuses incoming / stakeholder / tenant-dest rows.
   - Cross-tenant `tenant_id` spoof → 403.
   - Generic `/data/write` `disbursement_splits` still `financial_or_provider`.
   - Client still `writes_disabled` for raw `.from("disbursement_splits").update`.
   - Audit row written without TIN/bank numbers.
   - Duplicate save does not insert a second financial split (update/upsert overlay).
3. Tax containment tests remain green (`aws/tests/tax-profiles-containment.test.mjs`).
4. Provider catalog: `tenant-payment-accounting` is Class A, not a Moov function.

### Manual UAT (later apply workstream; no Moov)

1. Staging SPA + Lambda that include the handler (guarded overlay + SPA). Confirm live fingerprints first.
2. Pick an `ext:` outgoing settled row **without** stakeholder. Change type in Payment History. Expect success toast, row updates, refresh + logout/login still shows new type. Amount/status/transfer id unchanged. Revenue Profit unchanged.
3. Pick a stakeholder recipient (Jean Lindner class). Edit name + type in By Recipient. Expect Save success; History / Recipients / Tax regroup; bank last-4 unchanged; `recipient_tenant_id` unchanged (SQL verify read-only).
4. Pick a tenant-to-tenant paid row (`aggregate_key` starts `tenant:`). Change display name. Expect overlay only. Destination tenant id unchanged. Paid/Received on both tenants unchanged.
5. Attempt raw browser `from("disbursement_splits").update({ amount: 1 })` still `writes_disabled` / denied.
6. Tax Save still works (or fails closed if list failed). TIN never echoed.
7. Invoice Save draft / Payroll send still **must not** be treated as acceptance for this workstream. If clicked, they remain provider/money paths.
8. Confirm no new `disbursement_splits` row count, no new `payment_transfers`, no Moov transfer created (provider dashboard / `moov_transfer_id` unchanged).

---

## 10. Implementation sequence (later authorization)

1. Source: Class A handler + tests + frontend retarget. **No deploy.**
2. Optional SQL overlay table via official `sql-apply` only after review.
3. Guarded staging **Lambda overlay** of `payment-accounting.mjs` + `app-services.mjs` only (not a thin SAM replace). Receipt + lease. STOP if `DEPLOYMENT_COLLISION`.
4. Guarded staging **SPA** of ledger files only, composed onto then-current live SPA (today `index-DxJGUt9C.js`).
5. UAT §9. No production. No Moov. No payroll enablement.

**Do not** ship a Jean-Lindner-only client hack (e.g. allowlisting `disbursement_splits` or updating by displayed name).

---

## 11. STOP (diagnosis turn)

Diagnosis and plan only. Current live staging SPA `/assets/index-DxJGUt9C.js` and Lambda `/0Wyipd63VyUCg97uzp4ppFHAnC9RLHeqBNOJCZZth8=` were **not** modified this turn. Production was not modified. No SQL applied. No Moov. No money movement.

---

## 12. Source implementation status (no deploy)

Authorized Class A contract is in source + tests only. Live staging SPA/Lambda are unchanged until a later guarded apply.

| Control | Status |
|---|---|
| H1–H5 Payment History filters/CSV | WORKING |
| H6 Payment History type Select | **IMPLEMENTED-NOT-DEPLOYED** (`update_split_type` by split UUID; hidden for stakeholder / incoming / tenant destination) |
| H7 Incoming/stakeholder type badge | BLOCKED-BY-DESIGN |
| H8 Amount/status/provider IDs | BLOCKED-BY-DESIGN |
| I1 Invoice list | WORKING (read) |
| I2–I3 Invoice form / line items | WORKING (local form) |
| I4 Invoice Save draft | STILL-MISSING (provider/incomplete; not this work) |
| I5–I6 Invoice Send | STILL-MISSING |
| I7 Invoice Resend | STILL-MISSING |
| I8 Copy payment link | WORKING |
| I9 Open invoice page | WORKING |
| I10 Invoice Cancel | STILL-MISSING |
| I11 Invoice Delete | STILL-MISSING |
| I12 Invoice Sync | STILL-MISSING |
| I13 Invoice Branding navigation | WORKING (Settings) |
| R1 Revenue & Profit | WORKING (read-only) |
| B1–B5 Recipient filters/CSV | WORKING |
| B6–B8 Edit dialog fields | WORKING (form) |
| B9 Recipient Save | **IMPLEMENTED-NOT-DEPLOYED** (`update_recipient_display` via `aggregateKey`) |
| B10 Cancel | WORKING |
| T1–T2 Tax filters/export | WORKING |
| T3 Tax-form generation | BLOCKED-BY-DESIGN |
| T4–T6 Tax profile list/save/notes | WORKING if list succeeds (existing Class A; not changed) |
| T7 Tax retry | WORKING |
| P1–P2 Payroll history/memo display | WORKING (read-only) |
| P3 Payroll form | WORKING (local form) |
| P4 Payroll send | BLOCKED-BY-DESIGN / STILL-MISSING (money path; not this work) |

`tenant:` display overlay SQL is prepared and **not applied**: `aws/payments/sql/unapplied-do-not-run/NOT_APPLIED_81_tenant_payment_recipient_overrides.sql`. Until applied, `tenant:` Save returns `overlay_table_not_applied` and does not rewrite tenant identity.
