# Funding Tab: Repeat Payments + Per-Check Stakeholders

## Problem
1. After one batch is sent, the Funding tab locks — you can't send another payment from the same check.
2. The Funding tab doesn't show the original check amount minus the Actum payments already made.
3. The disbursement console lists every stakeholder in the tenant. You can't add/remove stakeholders per claim check.
4. When a check is shared with a partner tenant, that partner is not auto-added as a disbursement target even when their banking info is on file.

## What we'll build

### 1. New table `check_stakeholders`
Per-check whitelist of accounts that can receive disbursements for that specific check.

Columns: `check_intake_item_id`, `stakeholder_account_id`, `tenant_id` (owner of the check), `added_via` (`manual` / `partner_share`), `partner_tenant_id` (nullable, when added via share), timestamps.

Unique constraint on (`check_intake_item_id`, `stakeholder_account_id`).
RLS: tenant_users of the check's tenant can read/write. Service role full.

### 2. Auto-add partner stakeholders
Postgres trigger on `claim_check_payments` insert: when sender sends to a partner, upsert a `check_stakeholders` row for the sender's check, pointing at `recipient_stakeholder_account_id`, `added_via = 'partner_share'`.

### 3. Disbursement console (repeat sends + running balance)
- Compute `alreadyDisbursed` = sum of `disbursement_splits.amount` for this check whose status is not `failed`/`cancelled` (plus pending batches in flight).
- `remainingAvailable` = `checkAmount − reserveHeld − alreadyDisbursed`. Show that as "Available to disburse".
- Remove the early-return that hides the form when a non-pending batch exists. Always show the input form; show past batches in a compact "Previous disbursements" list above.
- Allocation accounts come from `check_stakeholders` joined to `stakeholder_accounts` (only active). If the list is empty, show the "Add stakeholder" CTA.
- Disable Send when `totalAllocated > remainingAvailable` (already the over-allocation check, just based on the new remaining).

### 4. Per-check stakeholder management UI
New small component `CheckStakeholdersManager` rendered above the allocation grid:
- Lists current check stakeholders with a remove (X) button.
- "Add stakeholder" popover lets you pick from the tenant's `stakeholder_accounts` not already on the check.
- Partner-share rows render with a "Partner" badge and a tooltip showing the partner tenant name; still removable.

### 5. Funds tab balance display
`FundsTab.tsx` already shows incoming payments. Add a "Disbursements" summary card showing:
- Original check amount
- Total disbursed via Actum (sum of `disbursement_splits.amount` for non-failed statuses)
- Remaining balance
Render a compact list of each prior split (recipient nickname, amount, status badge, timestamp).

## Technical details

**Migration** creates `check_stakeholders` (+ grants + RLS + trigger) and a trigger function `auto_add_partner_stakeholder()` on `claim_check_payments`.

**Frontend changes**
- `src/components/disbursement/DisbursementConsole.tsx` — remove the early `existingBatch` return; add `pastSplits` query; replace `accounts` query with one filtered through `check_stakeholders`; show stakeholder manager; recompute `availableAmount`.
- `src/components/disbursement/CheckStakeholdersManager.tsx` (new) — add/remove UI.
- `src/components/payments/FundsTab.tsx` — add disbursement history + remaining balance card.

**Edge functions** — no changes; `actum-disburse` already processes a batch's splits.

**Out of scope** (not touched): Actum credentials, fee logic in `SendPaymentPanel`, reserve mechanics.
