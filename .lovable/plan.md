# Moov Instant Micro-deposits Integration - Phase 2: Frontend & Native Verification

This plan completes the integration of native Moov.js bank linking and micro-deposit verification, replacing the Plaid bridge.

## Proposed Changes

### 1. Update Payment Settings UI
- **File**: `src/components/payments/PaymentAccountPanel.tsx`
- **Change**: Replace the "Bridge from Plaid" button with the "Connect Bank" flow. Use `MoovBankLink` for the initial connection and `MicroDepositVerification` for unverified accounts.

### 2. Finalize Bank Link Component
- **File**: `src/components/payments/MoovBankLink.tsx`
- **Change**: Ensure the component correctly handles the `onSuccess` callback by passing the Moov bank account ID back to the parent for synchronization.

### 3. Enhance Micro-deposit Verification Component
- **File**: `src/components/payments/MicroDepositVerification.tsx`
- **Change**: Ensure it correctly looks up pending verifications from `payment_method_verifications` and handles both initiation and confirmation.

### 4. Verification & Sync Logic
- **File**: `supabase/functions/moov-sync/index.ts` (Already partially updated)
- **Change**: Confirm that the sync function correctly maps `verification.status` from Moov to the `payment_provider_methods` and `tenants` tables.

## User Review Required

> [!IMPORTANT]
> The current implementation uses **Moov Instant Micro-deposits**, which allows users to verify their bank account by providing the exact amounts of two small deposits made by Moov. This replaces the Plaid-based verification.

- **Standard Micro-deposits**: 1-2 business days to appear on the statement.
- **Instant Micro-deposits**: Some banks support instant verification via the same flow if the amounts can be retrieved immediately (though typically it's the 1-2 day flow for standard ACH).

## Technical Details
- **Scopes**: `bank-accounts.verify` is now included in the `dropBankLink` scope for Moov.js.
- **Data Flow**:
  1. User clicks "Connect Bank".
  2. `MoovBankLink` (via Moov.js) collects routing/account numbers and links the bank to the Moov account.
  3. `moov-sync` runs to record the new bank account and its "pending" verification status.
  4. User sees the `MicroDepositVerification` UI to enter amounts once they arrive.
  5. Confirmation calls the `moov-micro-deposit-confirm` edge function.
