# Plan - Hide Plaid and Focus on Micro-deposits

Hide all Plaid-related user interfaces and logic in the project to focus on native Moov bank linking and micro-deposit verification.

## User Review Required

> [!IMPORTANT]
> This plan will effectively disable the "Plaid" rail for all tenants. If any tenants are currently relying on Plaid for live disbursements (not Moov or Actum), they will hit a "Bank payments unavailable" notice.

- Are there any specific tenants that MUST keep Plaid access during this transition?

## Proposed Changes

### Configuration and Hooks
- **Feature Flags**: Update `src/lib/payments/featureFlags.ts` to set `USE_PLAID` to `false` by default.
- **Payment Rail Hook**: Modify `src/hooks/usePaymentRail.ts` to ensure `isPlaid` is always `false` (or handled as a legacy fallback that redirects to Actum/Moov).

### UI Components
- **Bank Verification Router**: Update `src/components/disbursement/BankVerification.tsx` to always use `AuthentecheckVerification` (or a Moov-equivalent if available for stakeholders) when not verified, hiding the `PlaidVerification` path.
- **Disbursement Console**: Adjust `src/components/disbursement/DisbursementConsole.tsx` to remove Plaid fallback logic, ensuring it only considers Moov and Actum.
- **Payment Account Panel**: Remove any remaining references to "Plaid bridge" in `src/components/payments/PaymentAccountPanel.tsx` and ensure the "Connect Bank" button only triggers the Moov native link.
- **Authentecheck Component**: Update `src/components/disbursement/AuthentecheckVerification.tsx` text (specifically line 130) to remove the mention of "Plaid sign-in".

### Backend/Integration (Read-only for now)
- Ensure shared logic for rail routing defaults away from Plaid.

## Technical Details
- Setting `PAYMENT_FLAGS.USE_PLAID = false` in `src/lib/payments/featureFlags.ts`.
- Updating `usePaymentRail` hook to return `isPlaid: false` and `rail: "actum"` if "plaid" was selected.
- Modifying `BankVerification` to bypass `PlaidVerification` component entirely.
- Cleaning up descriptive text in `AuthentecheckVerification.tsx`.

## Verification Plan
- **UI Check**: Verify that "Connect Bank" only opens the Moov iframe.
- **Disbursement Check**: Verify that the disbursement console does not mention Plaid or attempt to use `plaid-disburse`.
- **Settings Check**: Verify that the Payment Settings panel only shows Moov-related status and micro-deposit verification fields.
