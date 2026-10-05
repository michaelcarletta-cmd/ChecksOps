# Proposed: provider → disbursement_splits settlement synchronization

**Status:** PROPOSED ONLY. Not authorized to implement in this workstream.  
**Do not:** mark existing splits settled, backfill, modify webhook financial state, alter money movement, or deploy.

This is separate from Tenant Payments & Financials accuracy (read/query classification only).

## Problem

`moov-disburse` / the AWS Moov money path writes `disbursement_splits.status = submitted` and stores `moov_transfer_id` when a real provider transfer is created.

`moov-webhook` already reconciles `payment_transfers` (and wallet funding) by `provider_transfer_id`. It does **not** update the matching `disbursement_splits` row.

A completed Moov A→B payout can therefore remain `submitted` on the split. Payments Revenue Paid, Recipient, Tax, Command Center Funds Released, and `get_tenant_funds_received` all require `status = 'settled'`, so the real movement is omitted from settled totals.

This is status-handling on the **existing** split. It is not a new transaction and must not insert a Tenant B copy.

## Proposed write (later authorization only)

When a provider webhook (or equivalent transfer-status poll) reports a terminal state for a transfer id:

1. **Match the existing split** (do not insert):
   - `disbursement_splits.moov_transfer_id = provider_transfer_id`
   - else join `payment_transfers.provider_transfer_id` to a split that already stores the same id
   - else stop. Do not invent a split from a transfer.
2. **Idempotency:**
   - If the split is already in the same terminal status (`settled` / `failed` / `returned`) and timestamps are present, no-op.
   - Safe to replay the same webhook.
   - Do not change `amount`, `tenant_id`, `recipient_tenant_id`, or create a second row.
3. **Completed / succeeded:**
   - `status = 'settled'`
   - `settled_at = provider completed time` (fallback: event time)
4. **Failed / canceled / declined:**
   - `status = 'failed'`
   - store provider failure text on existing failure columns only
5. **Returned / reversed / refunded:**
   - `status = 'returned'`
   - `returned_at` + return code/desc when the provider supplies them
6. **Incomplete / pending / processing / submitted:**
   - leave the split `submitted` (or existing non-terminal status)
   - do not count as settled
7. **No backfill** in the first authorized apply unless a later workstream explicitly authorizes historical rewrite.
8. **No money movement.** No Moov create/cancel. Status sync only.

## Matching rules

Prefer durable provider identity:

```
moov_transfer_id = webhook.transferId
OR plaid_transfer_id = webhook.transferId
OR payment_transfers.provider_transfer_id = webhook.transferId
   AND that transfer is already linked to the split
```

Do not match on amount + name alone. Do not treat `stakeholder_accounts.tenant_id` (payer-owned vendor row) as the recipient tenant.

## Tests required before any later implement

See `tests/moov-split-settlement-sync.proposed.test.ts` for the intended contract:

- completed webhook settles the existing split once
- replay is a no-op
- failed / returned map to the existing row
- no row insert
- unmatched provider id is a no-op
- pending/submitted does not settle

## Isolation

Do not implement inside this Payments accuracy workstream.  
Do not touch WalletOps money writers, Platform Finance, or live webhook until a dedicated authorization names those files.
