# Plan - KYC/KYB Document Upload Verification

The system currently supports direct-to-provider document uploads for KYC/KYB compliance. The browser posts files to a secure backend function (`moov-account-file-upload`), which validates the request, proves ownership, and forwards the file to the payment provider without ever storing the raw bytes in our infrastructure.

## Proposed Steps

1. **Verify Backend Logic**
   - Confirm `moov-account-file-upload` correctly handles `multipart/form-data`.
   - Ensure it maps `tenant_id` to the correct provider account.
   - Verify it records metadata in `payment_provider_files` for tracking.

2. **Verify Frontend Integration**
   - Confirm `VerificationDocumentsPanel.tsx` in the Payments settings allows selecting a document type (e.g., Business Verification, Representative Verification).
   - Ensure the upload UI correctly invokes the `uploadVerificationFile` helper.
   - Verify that the status of submitted documents (Pending, Approved, Rejected) is visible to the user.

3. **Technical Confirmation**
   - The "load immediately" requirement is satisfied by the streaming nature of the backend function: bytes are forwarded to the provider's API during the request.
   - Idempotency keys are used to prevent duplicate uploads of the same file.

## Technical Details

- **Backend Function**: `supabase/functions/moov-account-file-upload/index.ts`
- **Frontend Component**: `src/components/payments/VerificationDocumentsPanel.tsx`
- **Database Tracking**: Metadata is stored in `public.payment_provider_files`.
- **Security**: Files are never written to disk or database; they are streamed directly to the provider over HTTPS.
