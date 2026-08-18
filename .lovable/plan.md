# Plan - Moov Account Creation Implementation

The user wants to confirm if we can create accounts as described in the [Moov Accounts Documentation](https://docs.moov.io/guides/accounts/create-accounts/). Based on the codebase audit, we have already implemented a robust account creation flow that matches these requirements.

## Current Implementation Details

1.  **Automated Account Creation**: The `moov-account-create` Edge Function handles the creation of "Connected Accounts" for each tenant (Public Adjusters, Contractors, etc.).
2.  **Account Types**: We correctly create accounts as `accountType: "business"`, as the platform is built for restoration businesses.
3.  **Capabilities**: We request the following capabilities by default to support the full insurance check lifecycle:
    *   `transfers`: To move money.
    *   `send-funds`: For ACH disbursements (next-day/same-day).
    *   `collect-funds`: To pull funds (facilitator fees, platform fees).
    *   `wallet`: For the Moov balance capability.
4.  **Profile Synchronization**: The implementation automatically pulls business details (legal name, email, phone, address) from our `tenants` table to pre-populate the Moov account profile.
5.  **Idempotency**: We use deterministic `X-Idempotency-Key` headers (e.g., `checksops-account-${environment}-${tenant_id}`) to ensure that multiple clicks don't create duplicate accounts.
6.  **Terms of Service**: We support both hosted onboarding (via `moov-onboarding-link`) and direct ToS acceptance tracking.

## Verification & Confirmation

1.  **Backend Verification**: Confirmed that `supabase/functions/moov-account-create/index.ts` implements the exact POST request structure required by Moov.
2.  **Frontend Verification**: Confirmed that `PaymentAccountPanel.tsx` handles the UI trigger for this creation flow.
3.  **Data Persistence**: Verified that account IDs are stored in `payment_provider_accounts` and mirrored to the `tenants` table for fast lookup.

## Conclusion

Yes, we are fully able to create accounts as described. The infrastructure is already built, tested, and integrated into the "Set Up Payment Account" workflow in the Payments dashboard.
