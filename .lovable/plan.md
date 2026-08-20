# Plan: White-Label Moov Invoice Links

## Goal
Replace Moov-branded invoice payment links with branded, tenant-hosted invoice pages so customers see the restoration contractor's identity instead of Moov on both the URL and the invoice page.

## Scope & Limitation
- The invoice landing page and link will be fully branded (tenant logo, colors, letterhead, footer, line items).
- The **final card/bank checkout step** will still be handled by Moov's secure hosted page unless we later add embedded tokenization. This plan hides Moov from the link preview, email, and invoice detail page; the actual payment form remains Moov-hosted for PCI/security compliance.

## Proposed Changes

### 1. Database Migration
- Add `public_token uuid unique` to `moov_invoices`.
- Add `GRANT` for authenticated/service_role.
- Backfill existing invoices with generated tokens.

### 2. Edge Function: `public-invoice`
- Public endpoint (no JWT required) that accepts `token`.
- Looks up `moov_invoices` by `public_token`.
- Joins `tenants` to return:
  - Invoice: number, dates, line items, total, paid, status, Moov `payment_link_url`.
  - Tenant: name, logo_url, primary/secondary colors, invoice letterhead URL, invoice footer note.
- Returns 404 for unknown/revoked tokens.

### 3. Frontend: `PublicInvoicePage.tsx`
- Public route, no login required.
- Fetches invoice via `public-invoice` edge function.
- Renders:
  - Tenant logo / letterhead.
  - Branded invoice header with invoice number, dates, status.
  - Line-item table, totals, paid amount, balance due.
  - Footer note / terms.
  - "Pay now" CTA that opens the Moov payment link.
  - Paid/canceled/expired states.
- Uses tenant primary/secondary colors for theming.
- Mobile-first, no horizontal scroll.

### 4. Routing
- Add `/invoice/:token` to `isPublicTokenRoute` in `App.tsx`.
- Add `<Route path="/invoice/:token" element={<PublicInvoicePage />} />` to `CheckOpsRoutes`.
- Ensure custom-domain tenants can also serve `/invoice/:token` (add route in `CustomDomainWhiteLabelApp` or rely on `isPublicTokenRoute` fallback).

### 5. Update `moov-invoice` Edge Function
- On create/send, generate a `public_token` (crypto-random UUID) and store it in `moov_invoices`.
- Return the token in the response so the UI can build the branded link.

### 6. Update `InvoicesTab.tsx`
- Replace "Copy Moov payment link" with "Copy branded payment link".
- Build link using `window.location.origin + "/invoice/" + public_token`.
- Fall back to Moov link if no public token exists.
- Show a small "Open branded invoice" preview option.

### 7. Email Sending (if applicable)
- Where the app sends invoice emails, use the branded link instead of `payment_link_url`.

## Verification
- Create a test invoice.
- Confirm the copied link points to `https://<domain>/invoice/<token>`.
- Open the link in an incognito window and confirm tenant branding renders.
- Click "Pay now" and confirm it reaches Moov checkout.
- Confirm paid/canceled invoices show the correct status on the branded page.

## Files to Modify
- `supabase/migrations/..._moov_invoice_public_token.sql`
- `supabase/functions/public-invoice/index.ts` (new)
- `supabase/functions/moov-invoice/index.ts`
- `src/pages/PublicInvoicePage.tsx` (new)
- `src/App.tsx`
- `src/components/white-label/CustomDomainWhiteLabelApp.tsx`
- `src/pages/payments/InvoicesTab.tsx`
