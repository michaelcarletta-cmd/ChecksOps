# Plan: Moov Identity Verification Implementation Audit & Refinement

The user wants to know if Moov identity verification (as described in their [Identity Verification guide](https://docs.moov.io/guides/accounts/requirements/identity-verification/)) is implemented.

ChecksOps already has a robust Moov integration including account creation, document uploads for KYC/KYB, and readiness tracking. However, the specific "Identity Verification" flow (which often involves providing SSN/ITIN for individuals or EIN for businesses) needs to be cross-referenced with Moov's latest requirements to ensure full compliance.

## Proposed Changes

### 1. Document Upload Enhancements
- Refine the `identity_verification` and `individual_verification` purpose mapping to ensure they are correctly linked to Moov's expectations for both business and individual accounts.
- Verify that `representative_verification` correctly handles the `representative_id` requirement, which is critical for identity verification of business owners/controllers.

### 2. Identity Data Collection Policy
- Confirm that sensitive data (SSN/EIN) is handled via Moov's hosted flows or Drops to maintain security, as identified in existing `moovImportRules.ts`.
- Ensure the `PaymentReadinessPanel` clearly communicates when "Identity Verification" is the specific blocker.

### 3. Backend Alignment
- Update the `moov-sync` and `moov-account-create` functions if any new identity-related capabilities or requirements have been introduced in the linked documentation.

## Technical Details

- **Frontend**: 
  - `src/components/payments/VerificationDocumentsPanel.tsx`: Audit for clarity on identity document types.
  - `src/lib/payments/verificationFiles.ts`: Ensure purposes match Moov's latest API.
- **Backend**:
  - `supabase/functions/moov-account-file-upload/`: Verify streaming logic for identity documents.
  - `supabase/functions/_shared/moovReadiness.ts`: Refine `identity_verification` label and state logic to match the granular "Identity" requirements from the Moov API.
- **Security**:
  - Maintain the "no local storage" policy for KYC/KYB documents (streaming directly to Moov).
