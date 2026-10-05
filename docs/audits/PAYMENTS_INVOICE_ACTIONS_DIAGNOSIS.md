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
| Resend | Menu | `resend` | missing | **MISSING** | idempotent `unpaid` |
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

Do not deploy from this workstream.
