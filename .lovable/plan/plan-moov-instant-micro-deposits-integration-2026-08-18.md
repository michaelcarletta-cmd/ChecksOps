# Plan: Moov Instant Micro-deposits Integration

Replace Plaid-dependency for bank verification with Moov's native Instant Micro-deposit flow. This leverages Moov's `v2024.01.00` API for bank connection and verification, keeping the entire money-movement lifecycle within the Moov rail while maintaining the existing Actum/Plaid fallbacks.

## User Review Required

> [!IMPORTANT]
> The "Instant Micro-deposit" flow in Moov typically refers to **Micro-deposit verification** (which takes 1-2 days) unless using the **Instant Bank Login** (Plaid-like) via Moov.js. Moov also supports **Instant account verification** for certain banks. The implementation will focus on Moov's native bank link component and its micro-deposit lifecycle.

- **Wait Time**: Standard micro-deposits require 1-2 business days for the credits to appear in the bank statement.
- **Moov.js**: We will use the Moov.js `bank-account` and `micro-deposits` components to ensure a secure, embedded experience.

## Proposed Changes

### Backend (Edge Functions & Schema)

- **`moov-bank-link-token`**: Update to include `micro-deposits` scopes if not already present, ensuring the token allows for both linking and initiating verification.
- **`moov-sync`**: Enhance to pull `verification` objects for bank accounts, capturing `micro-deposit` status and mapping it to the `payment_provider_methods.verification_status`.
- **`moov-micro-deposit-initiate` & `moov-micro-deposit-confirm`**: Verify these are fully wired to the latest Moov verification API (using `/verify` endpoints).
- **`moovReadiness.ts`**: Update the readiness engine to include bank verification status as a hard blocker for `send-funds` capabilities.

### Frontend (React & Hooks)

- **`PaymentAccountPanel`**: Replace the "Bridge from Plaid" button with a "Connect Bank Account" flow that uses the Moov.js Drop component.
- **`MoovBankLink`**: A new component to wrap the Moov.js bank-link drop.
- **`MicroDepositVerification`**: A new UI component (replacing or augmenting `PlaidVerification`) that allows users to enter the two amounts once they appear in their statement.
- **`usePaymentAccount`**: Update to reflect real-time verification progress (e.g., "Verification Pending" vs "Verified").

## Technical Details

- **Moov API Version**: `v2024.01.00`.
- **Verification mapping**: 
  - `pending` -> `pending_micro_deposit`
  - `verified` -> `connected`
- **Security**: All PII (routing/account numbers) stays within the Moov.js iframe/drop. The app only handles short-lived tokens and non-sensitive metadata.

## Verification Plan

- **Automated Tests**:
  - Update `test-moov-readiness.mjs` to include bank verification scenarios.
  - Create `test-moov-micro-deposits.mjs` to mock the verification lifecycle (initiate -> confirm).
- **Manual Verification**:
  - Open Payment Settings.
  - Launch Moov Bank Link.
  - Verify account is created/linked.
  - Trigger micro-deposits and verify the "Pending" state in the UI.
  - Mock a successful verification via admin tool and verify the "Active" status.
