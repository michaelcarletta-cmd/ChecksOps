---
name: Tenant Document E-Signature
description: Enable tenants to send documents for e-signature directly from the claim files library, mirroring the MortgageOps signature workflow.
type: feature
---

# Tenant Document E-Signature

Enable tenants to initiate e-signature requests for any claim document, using the same field-placement and recipient logic currently used by Mortgage Ops.

## Proposed Changes

### Database & Schema
- No schema changes required; the `signature_requests` and `signature_signers` tables already support general claim-level requests.
- Ensure RLS policies for `signature_requests` allow `authenticated` users (tenants) to insert and select for claims they own.

### Frontend Components

#### 1. Signature Field Placer (Shared)
- The field placement logic in `MortgageOpsRequestDetail.tsx` (using `FieldPlacementEditor`) should be extracted or mirrored for tenant use.

#### 2. Claim Files Enhancement (`src/components/claim-detail/ClaimFiles.tsx`)
- Add a "Send for Signature" action to the file row dropdown/actions for PDF files.
- Implement the signature request workflow:
  - Select recipient(s) from claim stakeholders (Homeowner, Contractor, etc.).
  - Open a dialog with `FieldPlacementEditor` to place signature/date fields.
  - Dispatch the request via the `send-signature-request` edge function.

#### 3. Mortgage Ops Parity
- Ensure `MortgageOpsRequestDetail.tsx` and `ClaimFiles.tsx` use the same underlying service/function for sending signature requests to maintain consistency.

## Technical Details
- **Edge Function**: `send-signature-request` already exists and handles the dispatching logic.
- **Field Placement**: Uses `FieldPlacementEditor` which takes a signed URL of the PDF and allows drag-and-drop placement of fields.
- **Permissions**: Verify that the `authenticated` role has `GRANT` on `signature_requests` and `signature_signers`.

## Verification Plan
1. Upload a PDF to a claim as a tenant.
2. Trigger "Send for Signature".
3. Place fields and send to a stakeholder.
4. Verify the stakeholder receives the request and the status updates in the claim.
