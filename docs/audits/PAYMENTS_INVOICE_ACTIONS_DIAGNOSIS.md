# Payments & Financials → Invoices — Action diagnosis + source correction

**Workstream:** Invoice actions (isolated)  
**Date:** 2026-10-05  
**STOP:** Source only. No staging/production deploy. No SQL/RLS apply. No Moov/ACH/wallet movement.

Accepted recipient / overlay / Payment History Type paths were not modified.

## Action matrix

| Action | UI | Frontend | AWS before | Classification | After (source) |
|---|---|---|---|---|---|
| List | Invoices tab | `moov_invoices.select` | `/data/query` | **WORKING** | unchanged |
| Form / line items | New invoice dialog | local state | n/a | **WORKING** | unchanged |
| Save Draft | Dialog | `moov-invoice` `create` | parity POST Moov, no persist | **BROKEN** | local persist `draft` + `public_token` |
| Send (dialog) | Dialog | `create_and_send` | fell through to create POST | **BROKEN** | persist `unpaid`, not paid, no email |
| Send (draft row) | Menu | `send` | missing | **MISSING** | `draft` → `unpaid` |
| Resend | Menu hidden until delivery exists | backend `resend` remains idempotent | missing | **MISSING** | UI unavailable; backend never emails or duplicates |
| Cancel | Menu | `cancel` | missing | **MISSING** | local `canceled`; paid blocked |
| Delete | Menu | `delete` | missing | **MISSING** | draft/canceled only |
| Refresh / Sync | Header | `sync` | missing | **MISSING** | refresh `last_synced_at` only; never invent paid |
| Copy Payment Link | Menu | clipboard | client-only | **WORKING** when token exists | works after persist |
| Open Invoice Page | Menu | `window.open` | navigation **WORKING**; public fetch **BROKEN** (wrong table + Cognito wrap) | page **WORKING**; fetch **BROKEN** | `/public/invoice` token lookup on `moov_invoices` |
| Invoice Branding | Settings | navigate | Settings | **WORKING** | unchanged |
| Provider checkout / Pay now | Public page | `payment_link_url` | Moov hosted checkout | **INTENTIONALLY BLOCKED** | no fabricated checkout; no money movement |
| Customer email via Moov | Send/Resend toast | Moov PATCH `unpaid` | incomplete + unauthorized | **INTENTIONALLY BLOCKED** | `emailed: false` until separately authorized |

## Root causes

1. AWS `invoice.run` implemented list/create-only and called live sandbox Moov HTTP without writing `moov_invoices`.
2. Send/resend/cancel/delete/sync had no action switch (unknown actions fell through to POST create).
3. `publicInvoice` queried `payment_invoices` (wrong table) and required Cognito `withIdentityWrite`.
4. Staging `AWS_MOOV_ENABLED=false`. Live Moov invoice send is not authorized in this workstream.

## Correction (smallest)

Local-durable invoice documents. No Moov HTTP. No generic `/data/write` of `moov_invoices`. No Class A move.

## Proposed staging UAT (after a later guarded apply)

1. Payments → Invoices → New invoice → Save draft → row appears after refresh as Draft.
2. Row menu Send → status Unpaid; totals elsewhere unchanged.
3. Copy payment link + Open invoice page → branded `/invoice/{token}` loads.
4. Resend on unpaid → still one row, still Unpaid, not Paid.
5. Cancel unpaid → Canceled. Delete canceled → removed.
6. Delete unpaid is refused.
7. Paid is never set by Send/Resend/Refresh.
8. Recipient overlay and Payment History Type still persist as previously accepted.

## Source review closures (d01cbfeb1 follow-up)

### 1. Send must not claim email delivery
- Operator copy is **Issue invoice**, not Send/Resend.
- Success toasts: `Invoice issued. Copy or open the payment link to share it with the customer.`
- Public page date label is **Issued on**, not Sent on.
- Resend is removed from the Invoices UI until an authorized provider/email path exists.
- Backend `send` / `resend` still persist `emailed: false`. They never write `emailed: true`.

### 2. Public invoice token contract
- Token = `crypto.randomUUID()` (UUID v4, CSPRNG, 122 bits).
- Lookup accepts only `body.token`. `invoice_id`, `tenant_id`, claim/check/customer identifiers are not lookup keys.
- Token must be a complete UUID v4. Prefixes, suffixes, wildcards, sequential ints, and malformed values fail closed (400 missing / 404 unknown).
- SQL is `WHERE public_token = $1::uuid` (exact equality). Invoice id alone cannot retrieve the row.
- Response allowlist is the public invoice page fields plus tenant branding. No provider IDs, tenant internals, bank data, or accounting metadata.
- `/public/invoice` is POST read-only. Write actions (`send`, `mark_paid`, `transfer`, `ach`, `wallet`, …) and non-POST methods return 405. Status and paid fields cannot change through this endpoint.

### 3. Token lifecycle (existing product behavior)
- **Draft:** token is minted at create; public page loads with Draft status (same as `supabase/functions/public-invoice`).
- **Unpaid:** public page loads; operator shares the link after Issue.
- **Canceled:** public page loads with the existing canceled banner. Not a new workflow.
- **Deleted:** row is removed; token lookup returns 404.
- **Paid (historical):** public page loads as Paid. Issuance never writes paid.

### 4. State machine (unchanged)
Draft → Unpaid; Unpaid → Canceled; Draft/Canceled → Delete; Paid protected. Resend/reissue does not insert a second row. Sync never invents settlement.

### 5. Accepted payments work
`payment-accounting.mjs` recipient overlay / `acct:` / `ext:` / SQL 81 / Payment History Type were not modified.

**STOP.** Not authorized for staging or production. No SQL/RLS, Moov, ACH, wallet, transfer, or real email.
