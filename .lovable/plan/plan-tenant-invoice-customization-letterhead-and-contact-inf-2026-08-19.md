# Plan: Tenant Invoice Customization (Letterhead and Contact Info)

Tenants can already configure branding (logo, company name, address, phone, email) in the **Settings > Company Branding** tab. This plan implements the capability for tenants to customize their invoices with this information and a letterhead.

## Proposed Changes

### Database Schema
- Update the `tenants` table to include `invoice_letterhead_url` (optional override for invoice-specific branding).
- Ensure `legal_business_name`, `business_address`, `business_phone`, and `logo_url` are consistently used as fallbacks.

### Backend (Edge Functions)
- **`moov-invoice` function**:
    - Update the `create` action to pull the tenant's current branding info (name, address, email, phone) from the `tenants` table.
    - Pass this information to Moov when creating the invoice so it appears on the hosted payment page.

### Frontend (Settings)
- **`CompanyBrandingSettings.tsx`**:
    - Add a toggle/section for "Invoice Customization".
    - Allow tenants to upload a specific "Invoice Letterhead" or reuse their company logo.
    - Add fields for "Invoice Footer Note" or "Default Payment Terms".

### Frontend (Invoices)
- **`InvoicesTab.tsx`**:
    - Add a "Branding Preview" in the "New Invoice" dialog so tenants can see how their letterhead and info will look.
    - Fetch and display the tenant's contact info in the invoice creation flow.

## Technical Details
- Use `supabase.storage` to host letterhead images in the existing `company-branding` bucket.
- Pass branding metadata to Moov via the `description` or specific branding fields if supported by the Moov Invoices API version `v2026.07.00`.
- If Moov's hosted page has limited customization, we will ensure the `description` field is populated with the tenant's contact info as a fallback.

## Verification Plan
1. **Manual Test**: Upload a letterhead in Settings and create a new invoice.
2. **Preview Test**: Verify the "New Invoice" dialog shows the correct branding.
3. **API Check**: Confirm the `moov-invoice` function sends the branding details to Moov.
