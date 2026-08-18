# Plan - Moov Terms of Service Drop Implementation

The user wants to know if the [Moov Terms of Service Drop](https://docs.moov.io/moovjs/drops/terms-of-service/) has been implemented in ChecksOps.

## Audit Findings

Based on the audit of the codebase:

1.  **Backend Integration**: The backend already supports generating ToS tokens (`moov-tos-token` Edge Function) and recording acceptance (`moov-tos-accept` Edge Function).
2.  **Frontend Implementation**: The `PaymentReadinessPanel.tsx` component correctly implements the ToS Drop:
    *   It dynamically loads the Moov.js SDK (`https://js.moov.io/v1`).
    *   It creates the `<moov-terms-of-service>` custom element.
    *   It passes a secure session token to the drop.
    *   It listens for the `termsOfServiceToken` event from the drop.
    *   It automatically records the acceptance with the backend once the user signs the terms in the drop.
3.  **UI/UX**: The "Review & accept terms" button appears in the Payment Readiness panel whenever the payment provider requires ToS acceptance for a tenant.

## Conclusion

Yes, the Moov Terms of Service Drop is fully implemented in ChecksOps. It is integrated into the "Payment Readiness" flow, allowing tenants to review and sign Moov's terms directly within our application dashboard without being redirected.
