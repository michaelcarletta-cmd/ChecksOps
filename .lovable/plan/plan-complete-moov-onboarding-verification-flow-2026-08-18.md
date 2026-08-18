# Plan: Complete Moov Onboarding & Verification Flow

We will finish the Moov onboarding and verification for the Freedom Adjustment tenant, transitioning it from `action_required` to `ready`. This involves completing the Terms of Service acceptance, verifying Identity/KYC requirements, and executing the Instant Micro-Deposit flow for bank verification.

## User Review Required

> [!IMPORTANT]
> The automated end-to-end test confirmed that the Freedom Adjustment account is currently stuck in `action_required` due to outstanding **Terms of Service** and **Identity Verification** requirements. While I will automate the "Instant Micro-Deposit" verification in the backend (using sandbox codes), the initial **ToS acceptance** and **Identity Doc uploads** require valid tokens or documents which are best handled through the live UI.

- **ToS Acceptance**: I will use the Moov.js Terms of Service Drop in the onboarding UI.
- **KYC/KYB**: I will ensure the UI correctly displays the requirements reported by Moov (currently `account.tos-acceptance`).
- **Bank Verification**: I will run the `$0.01 MV####` flow.

## Proposed Changes

### Backend (Edge Functions)

- **Sync Logic**: Update `moov-sync` and `moov-readiness` to proactively request all required capabilities (`send-funds.ach`, `collect-funds.ach`, `wallet.balance`) if they are missing during a sync.
- **Verification Helper**: Update `moov-micro-deposit-confirm` to support a special sandbox override (e.g., `0000`) for the `MV####` code to allow automated testing to complete without a real bank statement.
- **Wallet Provisioning**: Improve `moov-wallet-sync` to gracefully handle the "Bad Gateway" error by checking if the account is verified before attempting balance fetches, while still ensuring the wallet record is created.

### Frontend (Payments)

- **Readiness Panel**: Ensure the `PaymentReadinessPanel` correctly maps the `account.tos-acceptance` requirement to the "Review & accept terms" action.
- **Bank Link**: Ensure the "Connect Bank" button is enabled once the account is created, even if identity verification is pending.
- **Onboarding Flow**: Streamline the transition between "Account Created" -> "ToS Accepted" -> "Bank Linked" -> "Verified".

## Technical Details

- **Moov API**: All calls remain pinned to `v2024.01.00`.
- **Database**: Readiness states are synchronized to `payment_provider_accounts.readiness` and mirrored to `tenants` for global UI consistency.
- **Security**: All Moov.js tokens and session keys are scoped to the specific tenant and environment (sandbox).

## Verification Plan

### Automated Tests
- Run `moov-selftest` to verify API connectivity.
- Run a targeted script to initiate and confirm a micro-deposit using the sandbox override code.
- Verify `moov-readiness` reports `ready` once requirements are satisfied.

### Manual Verification
- View the **Payment Settings** tab in the preview.
- Confirm the **Payment Readiness** badges turn green as steps are completed.
- Verify the **Wallet** balance appears once verification is complete.
