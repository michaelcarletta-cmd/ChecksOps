# Plan - Moov Onboarding and Verification Flow

The goal is to ensure a seamless and robust Moov onboarding flow for Freedom Adjustment, aligning with the expected sequence of account creation, terms acceptance, identity verification, bank linking, and readiness synchronization.

## User Improvements

- **Reliable Onboarding States**: The system will accurately reflect Moov's live status (Pending, Action Required, Approved) throughout the identity verification (KYC/KYB) process.
- **Continuous Bank Linking**: Users can connect and verify their bank accounts while their business identity verification is still in progress, avoiding unnecessary waiting.
- **Accurate Balance Reporting**: The wallet balance will never show a misleading "$0" during synchronization issues; instead, it will clearly indicate "Pending Sync" or "Balance unavailable."
- **Seamless Readiness Sync**: Accepting the Terms of Service will trigger an immediate backend sync, ensuring the readiness checklist updates instantly without manual refreshes.

## Technical Details

### Backend (Edge Functions)
- **`moov-account-create`**: Pin the baseline capabilities to `send-funds.ach` and `wallet.balance`.
- **`moov-sync`**: Harden the proactive capability logic to only request `collect-funds.ach` when explicitly required by the tenant's product configuration.
- **`moov-wallet-sync`**: Ensure the sync-failure state is persisted so the frontend can distinguish between a zero balance and a failed fetch.
- **`moov-readiness`**: Update the `evaluateReadiness` logic in `_shared/moovReadiness.ts` to provide more granular feedback based on Moov's capability requirements and identity verification status.

### Frontend (React)
- **`PaymentReadinessPanel.tsx`**: Ensure the "Terms of Service accepted" check triggers the `moov-sync` and `load` flow immediately.
- **`WalletPanel.tsx` & `MoovTreasuryPanel.tsx`**: Handle the `sync_failed` status by displaying "Balance unavailable" or "Pending Sync" instead of a raw $0.00 value.
- **`PaymentAccountPanel.tsx`**: Remove any UI blocks that prevent bank linking before business identity verification is complete.

### Verification
- **Sandbox Testing**: Use the `0000` bypass code for automated E2E verification of the successful bank-linking path in the sandbox environment.
- **Readiness Audit**: Verify that the `canMoveMoney` selector accurately reflects the minimum capability requirements confirmed by Moov.
