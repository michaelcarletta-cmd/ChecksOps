# Tenant Payments & Financials Accuracy — Read-Only Diagnosis

**Workstream:** Tenant Payments & Financials Accuracy (isolated)  
**Authorization:** READ-ONLY DIAGNOSIS ONLY  
**Date:** 2026-10-04  
**Source baseline:** `main` at `7c64dae2d`  
**STOP:** findings only. No implementation, SQL, backfill, money movement, SPA/Lambda, or deploy.

This is **not** ChecksOps Platform Finance, Mortgage Agents, Branding, Homeowner, Signature Requests, Mortgage Desk, Claim Ledger, or WalletOps/Moov facilitator work. Those workstreams own their files. This diagnosis only reads the existing tenant Payments & Financials accuracy path.

Do **not** redesign tabs, layout, filters, cards, tables, labels, or navigation.  
Do **not** create a new accounting system or duplicate transactions for payer and recipient.  
Do **not** assume `origin/main` is the complete live staging composition. Any later fix must reconcile onto the then-current accepted staging composition through the official deployment guard.

---

## 1. What the existing UI already calculates

Tenant route: `src/pages/Payments.tsx` — tabs unchanged:

| Tab | Component | What it queries today | What the number means |
|---|---|---|---|
| Payment History | `PaymentLedger.tsx` | This tenant’s `disbursement_splits` where `status ≠ pending` | Outgoing payouts. Footer/cards count **settled only** |
| Invoices | `InvoicesTab.tsx` | `moov_invoices` (tenant → its customers) | Not the A→B insurance-check model |
| Revenue & Profit | `RevenueSummary.tsx` | Own `check_intake_items` (`deposited` **or** `funds_released`) minus own `disbursement_splits` (`settled`) | Claim-check cash retained. **All-time. No month/year filter.** |
| By Recipient | `RecipientReport.tsx` | Same outgoing splits (`status ≠ pending`); aggregates **settled** by `type\|name` | Payer-side paid-to-name totals |
| Tax & 1099 | `TaxSummary.tsx` | Settled outgoing splits + `cash_job_payments` + own deposited checks | Accountant export. $600 flag is informational only |
| Payroll | `PayrollTab.tsx` | Stakeholder payroll (off-claim) | Separate outgoing path |

Related **non-Payments** surfaces (do not redesign; reuse later):

- Check Command Center **Funds Released** = this tenant’s settled `disbursement_splits` (`CheckCommandCenter.tsx`).
- Check Command Center **Funds Received** = `get_tenant_funds_received(this tenant)` — settled splits **paid by another tenant** to this tenant.
- Per-check `FundsTab.tsx` can show incoming `claim_check_payments` + RPC splits.
- WalletOps lists this tenant’s `payment_transfers` as **payer** only (`tenant_id = self`).

---

## 2. Canonical $10,000 / $9,000 example

Required:

```
Tenant A deposits/settles $10,000 insurance check
  → Tenant A Funds Received = $10,000

Tenant A sends $9,000 to Tenant B (settled)
  → Tenant A Funds Released / paid to Tenant B = $9,000
  → Tenant A retained / existing "Profit" = $1,000
  → Tenant B sees the SAME $9,000 received from Tenant A
  → Filter: Tenant B — $X in 2026, with drill-down
```

Required relationship (one durable movement, two views):

```
payer_tenant_id = A
recipient_tenant_id = B
amount = 9000
date / status / provider_transfer_id
related check/claim/job
category/purpose
```

### 2.1 Existing “Profit” definition (preserve the label)

`RevenueSummary` cards:

```
Total Received (Revenue)  = Σ check_intake_items.amount
                            WHERE tenant_id = current
                              AND status IN ('deposited', 'funds_released')

Total Paid (Expenses)     = Σ disbursement_splits.amount
                            WHERE tenant_id = current
                              AND status = 'settled'

Net Profit                = Received − Paid
subtitle                  = "Retained earnings"
```

This is **not** GAAP / SaaS profit. It is **claim-check cash retained by this tenant**: deposited/released insurance checks minus this tenant’s settled outgoing disbursement splits.

For the example, Tenant A **would** show $10,000 / $9,000 / $1,000 **if and only if**:

1. The check row is `deposited` or `funds_released`.
2. The $9,000 is a `disbursement_splits` row owned by Tenant A with `status = 'settled'`.

It will **not** stay correct if the $9,000 is only a `payment_transfers` row, a `claim_check_payments` row, a Moov split still `submitted`, or a returned/voided split that never left `settled`.

---

## 3. What already works

| Requirement | Works? | Where |
|---|---|---|
| Tenant A Funds Received from **own deposited check** | **Mostly** | Revenue card includes `deposited` and `funds_released`. Tax income uses **`deposited` only** — those two totals can disagree. |
| Tenant A Funds Released for **settled disbursement_splits** | **Mostly** | Revenue “Total Paid”, History footer, Recipient/Tax settled filters. Command Center Funds Released uses the same table + `settled`. |
| Do not count `pending` in History query | **Yes** | `neq("status", "pending")`. Cards still require `settled` for money totals. |
| Do not count failed in Revenue paid | **Yes** | Revenue paid is `status = settled` only. |
| Recipient monthly/yearly filter (payer side) | **Partial** | History / Recipient / Tax have month/year controls. Revenue cards do not. Recipient **category tiles ignore the date filter**. |
| Tax: no automatic 1099 filing conclusion | **Yes** | Copy + `taxYtdSummary.ts` mark the $600 flag informational. Keep that. |
| Same-row incoming for Tenant B (no second insert) | **Infrastructure exists** | `disbursement_splits.recipient_tenant_id`, `get_tenant_funds_received`, `payment_transfers.destination_tenant_id`, `claim_check_payments.sender_tenant_id` / `recipient_tenant_id`. |
| Command Center Tenant B incoming | **Partial** | RPC can show the **same split id** Tenant A released, if identity matching succeeds. |

---

## 4. What does not work (accuracy)

### P0 — Tenant B cannot see the $9,000 on Payments & Financials

Payments tabs query **only** `tenant_id = current tenant` on `disbursement_splits` and **only** own `check_intake_items`.

They never:

- call `get_tenant_funds_received`
- query `disbursement_splits.recipient_tenant_id = current`
- query `payment_transfers.destination_tenant_id = current`
- query `claim_check_payments.recipient_tenant_id = current`

So Tenant B’s Revenue **Total Received** is only Tenant B’s own deposited checks. The $9,000 from A is invisible on Payments, even when Command Center Funds Received shows it.

**Narrow later fix (not this task):** read incoming settled rows from the **existing** payer-owned split/transfer (`get_tenant_funds_received` and/or `destination_tenant_id`). Display them on existing History / Revenue / Recipient surfaces. Do **not** insert a Tenant B copy.

### P0 — A→B identity is usually a free-text name, not Tenant B’s id

Durable columns exist:

- `disbursement_splits.recipient_tenant_id`
- `payment_transfers.destination_tenant_id`
- `external_payment_recipients.recipient_tenant_id`
- `claim_check_payments.recipient_tenant_id` (legacy send path now throws “use the Moov payout hub”)

The live A→B insurance path is **DisbursementConsole**: inserts `stakeholder_account_id` + payer `tenant_id` only. No `recipient_tenant_id`. Recipient display is `stakeholder_accounts.nickname/custname` or `recipient_name`.

Trigger `trg_set_split_recipient_tenant` (`20260820194902`):

1. If `stakeholder_account_id` is set, `resolve_recipient_tenant` returns **`stakeholder_accounts.tenant_id`**.
2. Those accounts are almost always **owned by the payer** (Tenant A’s vendor list).
3. Trigger then **nulls** `recipient_tenant_id` when it equals the payer `tenant_id`.

So stakeholder-linked A→B splits typically store **`recipient_tenant_id = NULL`**. Fallback is `normalize_org_name(recipient_name)` vs `tenants.name` (min length 5). A nickname like “Tenant B crew” will not match “Tenant B LLC”.

`RecipientReport` / `taxYtdSummary` key by `type|lowercase name` or `acct:{stakeholder_id}`, **not** tenant id. Rename/typo splits “Tenant B — $X in 2026”. Edit-by-name can rewrite many rows.

`PaymentLedger` CSV uses stakeholder name only (drops `recipient_name`).

### P0 — Moov disbursements often never become `settled`

`moov-disburse` / AWS `moov-money.mjs` set split `status = submitted` (or `failed`) and store `moov_transfer_id`.

`moov-webhook` updates `payment_transfers` and wallet funding. **It does not update `disbursement_splits`.**

Plaid webhook can settle Plaid splits. External/manual recording inserts or updates `status = 'settled'` immediately.

**Result:** a real completed Moov $9,000 to Tenant B can remain `submitted`. Then:

- Tenant A Revenue Paid / Recipient / Tax / Command Center Funds Released **omit it**
- Tenant B RPC **omits it** (`status = 'settled'` required)
- History still lists it as In Transit (not counted in settled footer)

This is status-handling on the **existing row**, not a new transaction. Changing webhook/status writers is money-record mutation and needs a **later** authorized fix. Do not backfill in this diagnosis.

### P1 — Parallel money rows, no Payments union, duplication risk

| Path | Payer row | Recipient tenant id | In Payments UI? |
|---|---|---|---|
| Disbursement split (Moov/Plaid/external) | `disbursement_splits` | Often null | Payer outgoing only |
| Moov send (`moov-transfer-create`) | `payment_transfers` + `destination_tenant_id` | Yes when business recipient | **No** (WalletOps payer list only; `listPayments` filters `tenant_id = payer`) |
| Wallet funding | `payment_transfers` `leg_role = wallet_funding` | `destination_tenant_id = self` | Not in Payments (good) |
| Legacy `claim_check_payments` | sender + recipient tenant ids | Yes | FundsTab only; send is disabled |
| Tenant→customer invoice | `moov_invoices` | N/A | Invoices tab (different domain) |

If the same Moov transfer is later also written as `payment_transfers`, summing splits **and** transfers without `provider_transfer_id` / `moov_transfer_id` dedupe would **double** the $9,000. Do not manufacture a second row for Tenant B.

Wallet funding `destination_tenant_id = self` must never become Tenant B (or Tenant A) “funds received.”

### P1 — Settlement / date / reversal rules are inconsistent

Required: count only completed/settled; exclude pending, failed, voided; reflect refunds/returns; no internal wallet income; no duplicate provider transfer.

| Surface | Date used | Status | Reversals |
|---|---|---|---|
| Revenue Received | none (all-time) | `deposited` **or** `funds_released` | Returned checks not excluded unless status changed |
| Revenue Paid | none (all-time) | `settled` only | Returned/failed excluded if status flipped; stuck `settled` still counts |
| History filter | `created_at` | lists submitted/returned/failed; totals settled | Return shown, not netted in settled total |
| Recipient totals | `created_at` window; amount uses `settled_at ?? created_at` | settled | same |
| Recipient tiles | **ignores date filter** | settled | tiles can disagree with table |
| Tax paid | `created_at` in calendar year | settled | settled-only |
| Tax income | `deposited_at` + status `deposited` only | misses `funds_released` | — |
| FundsTab outgoing | — | excludes failed/cancelled/returned but **includes submitted** | in-transit counted as disbursed on the check |
| `get_tenant_funds_received` | — | settled only | good |

A split created in December and settled in January lands in December History/Tax and January “last paid” date.

### P1 — Tenant A recipient filter cannot reliably answer “Tenant B — $X in 2026”

Because identity is name/stakeholder, not `recipient_tenant_id`, and because Moov may never settle, the 2026 total can be empty, split across names, or include in-transit if a future query loosens status.

There is no drill-down from a recipient row to the underlying payment ids in RecipientReport (aggregate only). History can search by name.

### P1 — Tenant B “who paid” / monthly / yearly

Exists on Command Center Funds Received (`sender_name` from payer `tenants.name`) for matched settled splits. **Not wired into Payments tabs.** Incoming `payment_transfers` are not in that RPC.

---

## 5. Data-flow (existing, text)

```
Insurance check (Tenant A)
  check_intake_items.status = deposited | funds_released
        │
        ├─ Payments Revenue "Total Received"     (A only, all-time)
        ├─ Tax income                            (A, deposited only, by year)
        └─ NOT Tenant B

Tenant A pays Tenant B
  typical: DisbursementConsole
    disbursement_splits
      tenant_id = A
      stakeholder_account_id = A's vendor row
      recipient_tenant_id ≈ NULL
      moov-disburse → status=submitted + moov_transfer_id
      webhook → payment_transfers maybe; splits NOT updated
        │
        ├─ A Payments History / Recipient / Revenue Paid   only if status=settled
        ├─ A Command Center Funds Released                 only if settled
        ├─ B get_tenant_funds_received                     only if settled AND
        │     recipient_tenant_id=B OR stakeholder.tenant_id=B OR name match
        └─ B Payments tabs                                 NEVER

  alternate: moov-transfer-create
    payment_transfers
      tenant_id = A
      destination_tenant_id = B
      provider_transfer_id
        │
        ├─ WalletOps (A as payer)
        └─ Payments tabs (A and B)                         NEVER

  do not: insert a second $9,000 for B
```

---

## 6. Existing records to reuse (do not add a parallel ledger)

Reuse, in this order:

1. **`disbursement_splits`** — primary outgoing fact for insurance-check payouts. Same `id` for A released and B received.
2. **`disbursement_splits.recipient_tenant_id`** — already there; populate/read, do not duplicate the split.
3. **`get_tenant_funds_received`** — already returns the payer split to the recipient tenant. Payments should consume it; do not copy rows.
4. **`payment_transfers`** — `tenant_id` (payer), `destination_tenant_id` (recipient), `provider_transfer_id`, `claim_id`, `check_id`, `status`, `completed_at`. Include in Payments only when the movement is not already a split with the same provider id.
5. **`stakeholder_accounts.id`** — durable payee when not another tenant; still not Tenant B’s company id unless linked.
6. **`claim_check_payments`** — already has sender/recipient tenant ids; legacy write is disabled. Read existing settled rows; do not revive Actum.

Do not create `tenant_financial_events` or a second “incoming payment” table.

---

## 7. Narrowest later corrections (not authorized now)

When a **separate** implementation workstream is authorized, keep the existing tabs/labels and change queries/classification only.

1. **Incoming on Payments (Tenant B)**  
   Union settled `get_tenant_funds_received` (and settled `payment_transfers` where `destination_tenant_id = B`, excluding `wallet_funding` / self-destination) into History, Revenue Received, and recipient/payer views. Same id as the payer row.

2. **Recipient key**  
   Prefer `recipient_tenant_id` / `destination_tenant_id` → `tenants.name`. Then stakeholder id. Then name. Filter “Tenant B — 2026” by tenant id.

3. **Stop treating payer-owned stakeholder as recipient tenant**  
   `resolve_recipient_tenant` must not map `stakeholder_accounts.tenant_id` when that id is the payer. Only set `recipient_tenant_id` when the stakeholder (or explicit dest) belongs to another tenant, or a unique org-name match. **No historical rewrite** unless a later backfill is explicitly authorized.

4. **Moov split settlement (separate money-record authorization)**  
   When provider status is completed/settled, set the **existing** split to `settled` + `settled_at`. On returned/failed/reversed, flip status and exclude from settled totals. Do not create a new split.

5. **Dedupe**  
   One provider id (`moov_transfer_id` / `provider_transfer_id`) → one counted movement.

6. **Dates**  
   Settled totals and year/month filters should use `settled_at` (fallback `completed_at`), not `created_at`. Keep `created_at` for “initiated” display if the existing column stays.

7. **Reconcile Revenue vs Tax vs tiles**  
   Same status set for “received” (`deposited` vs `funds_released`). Recipient tiles must use the same date filter as the table. Revenue cards: either keep all-time (document it) or honor the existing History period control **without adding a new tab**.

8. **FundsTab in-transit**  
   Per-check “disbursed” includes `submitted`. Payments Revenue does not. If those numbers must match, later align FundsTab to settled-only — layout unchanged.

9. **Wallet / internal**  
   Exclude `leg_role = wallet_funding`, facilitator legs, and self-destination transfers from Funds Received / Profit.

10. **Tax**  
    Keep “ChecksOps does not file.” Totals must match settled recipient payments after the above. No 1099 determination.

**Do not** change billing, Moov facilitator, Mortgage Agents, or Platform Finance P&L.

---

## 8. Isolation and anti-overwrite

Owned for a **later** accuracy fix (query/classification only):

- `src/components/ledger/PaymentLedger.tsx`
- `src/components/ledger/RecipientReport.tsx`
- `src/components/ledger/RevenueSummary.tsx`
- `src/components/ledger/TaxSummary.tsx`
- `src/lib/taxYtdSummary.ts` (aggregation keys/dates only)
- optionally consume `src/lib/fundsReceived.ts` / `get_tenant_funds_received` **read path**

Not owned: `AdminTenants` Platform Finance, `platform-treasury`, `tenant-receivables`, Mortgage Agent hire/queue, branding, homeowner ledger, signature requests, WalletOps money writers, `moov-money.mjs` execution.

Before any eventual deploy (not this task):

1. Fresh-read `origin/main`
2. Fresh-fingerprint live staging SPA/Lambda
3. Exact file list
4. Overlap check vs active/protected workstreams
5. Cross-feature regression contracts
6. Official deployment guard, lease, signed receipt, TOCTOU/CAS
7. If staging drifted after preflight: **STOP**

Never `git reset --hard`, broad S3 sync/delete, old SPA/Lambda ZIP, or whole-package replace. Never merge merely to make this diagnosis “available.”

---

## 9. Verdict

The existing Payments & Financials **layout is the right surface**. The **queries are payer-outgoing and own-check only**.

Against the required model:

- Tenant A $10,000 received: **works** when the check is `deposited`/`funds_released` (Tax may still omit `funds_released`).
- Tenant A $9,000 released to Tenant B: **works only** for a **settled** `disbursement_splits` row, and Tenant B is usually a **name**, not a tenant id.
- Tenant A $1,000 existing Profit: **works** under the retained-cash definition when both legs above work.
- Tenant B $9,000 from Tenant A on Payments: **does not work**. Same-row RPC exists for Command Center only.
- Monthly/yearly / “Tenant B in 2026”: **unreliable** (name keys, `created_at`, tiles ignore dates, Moov may stay `submitted`).
- Pending/failed: **mostly excluded** from money cards; Moov completed-but-`submitted` is wrongly excluded; FundsTab outgoing wrongly includes in-transit.
- Duplicates: **risk** if splits and `payment_transfers` are both summed later without provider-id dedupe.
- Internal wallet movement: **not** in Payments today (good); must stay excluded.

**SAFE TO IMPLEMENT FROM THIS DIAGNOSIS = NO.**  
**SAFE TO DEPLOY = NO.**

Implementation, if later authorized, is query/classification/settlement-status on existing rows only — no new tabs, no new ledger, no duplicate $9,000, no historical rewrite to force totals, no staging overwrite.
