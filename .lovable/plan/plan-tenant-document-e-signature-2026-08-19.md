# Plan - Tenant Document E-Signature

Enabling tenants to send documents for electronic signature directly from the claim files library.

## Proposed Changes

### Database & Permissions
- Verify `authenticated` users can insert into `signature_requests` and `signature_signers` (verified: RLS policies exist, but may need explicit GRANT if permission errors occur).

### Claim Detail UI (`src/components/claim-detail/`)
- **`ClaimFiles.tsx`**: Add a "Send for Signature" button to PDF files in the document list.
- **Integration**: Clicking this button will store the file metadata in `localStorage` and switch to the "Templates & Signatures" tab.
- **Tab Visibility**: Remove `isStaffOrAdmin` restriction from the "Templates & Signatures" tab so all tenants can access e-signatures for their claims.

### Signature Flow (`src/components/claim-detail/SignatureRequests.tsx`)
- Add an `useEffect` hook to check for pre-selected files in `localStorage`.
- If found, set the source type to "Existing Claim File", select the file, and open the request dialog automatically.

## Technical Details
- **Permissions**: Granting `INSERT` on `signature_requests` to the `authenticated` role.
- **Workflow**: `ClaimFiles` -> `localStorage` -> `Tab Change` -> `SignatureRequests` auto-trigger.

## User Review Required
- Does the "Templates & Signatures" tab contain any other internal staff-only info that tenants should not see? (Review of `ClaimTemplates` and `SignatureRequests` suggests it is safe for tenant use).
