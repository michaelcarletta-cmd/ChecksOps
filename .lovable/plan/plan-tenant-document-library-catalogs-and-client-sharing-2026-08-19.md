# Plan - Tenant Document Library Catalogs and Client Sharing

The user wants to allow tenants to upload roofing/siding catalogs (and other work-related docs) to their Document Library and then share them with clients via the existing client tracking link (Homeowner Ledger).

## Proposed Changes

### Database & Schema
- No schema changes needed. We will use the existing `tenant_documents` table and `tenant-documents` storage bucket.
- The `doc_type` for catalogs will follow the pattern `library:catalog:<slug>`.

### Frontend - Document Library
- Update `TenantDocumentLibrary.tsx` to include a new "Catalogs" category.
- Add "Catalogs" to the `CATEGORIES` array in `TenantDocumentLibrary.tsx` with appropriate metadata (icon, description).

### Frontend - Homeowner Ledger / Client Tracking
- Update `HomeownerLedger.tsx` to display shared catalogs.
- We need a mechanism to mark specific library documents as "Shared with Homeowners".
- Add a new `shared_with_homeowners` boolean column to `tenant_documents` via a migration.
- Update `TenantDocumentLibrary.tsx` to include a toggle for `shared_with_homeowners` similar to `auto_share_mortgage_ops`.
- Update the `homeowner-ledger-view` edge function (logic check) to include these shared catalogs in the summary data.
- Update `HomeownerLedger.tsx` to render a "Resource Center" or "Catalogs" section where homeowners can view/download these files.

## Technical Details

### 1. Database Migration
```sql
ALTER TABLE public.tenant_documents 
ADD COLUMN IF NOT EXISTS shared_with_homeowners BOOLEAN DEFAULT false;

-- Add RLS updates if needed, though existing policies likely cover it.
```

### 2. Component Updates
- **`src/components/settings/TenantDocumentLibrary.tsx`**:
    - Add `catalog` to `LibraryCategory` and `CATEGORIES`.
    - Add `shared_with_homeowners` to `LibraryRow` interface.
    - Add a toggle in `LibraryItem` for "Share with Clients".
- **`src/pages/HomeownerLedger.tsx`**:
    - Update `Summary` type to include `catalogs`.
    - Add a `CatalogsPanel` component to render the shared documents.

### 3. Edge Function Update
- **`supabase/functions/homeowner-ledger-view/index.ts`**:
    - Modify the query to fetch `tenant_documents` where `shared_with_homeowners` is true for the tenant associated with the claim.

## Verification Plan

1. **Upload Test**: Go to Document Library, upload a PDF to the new "Catalogs" tab.
2. **Sharing Test**: Toggle "Share with Clients" on the uploaded catalog.
3. **Client View Test**: Open a Homeowner Ledger (tracking link) for a claim under that tenant and verify the catalog is visible and downloadable.
4. **Visibility Test**: Uncheck "Share with Clients" and verify it disappears from the ledger.
