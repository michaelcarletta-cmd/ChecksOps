# Plan: Moov API-Based Onboarding for Merchants

The user wants to implement Moov's [hosted onboarding](https://docs.moov.io/guides/accounts/hosted-onboarding/) for their merchants (tenants) directly within ChecksOps. This allows merchants to be onboarded via an embedded experience, avoiding duplicate data entry between ChecksOps and Moov.

## Proposed Changes

### Backend (Edge Functions)

#### 1. Update `moov-account-create`
- Ensure the initial account creation passes all available tenant data (legal name, email, phone) to pre-fill as much of the profile as possible.

#### 2. Update `moov-onboarding-link`
- Refine the onboarding invite generation to ensure all necessary scopes are included for a full "embedded" feel.
- Verify that `redirectURL` correctly handles the return to ChecksOps.

### Frontend

#### 1. Enhance `TenantPaymentAccountPanel`
- Update the "Onboarding Link" logic to handle the API-driven hosted onboarding flow.
- Add a way to open the onboarding link in a new tab or potentially within an iframe if the user prefers (though Moov usually recommends a redirect or a new tab for security).

#### 2. Implement a new Onboarding specialized flow (Optional/Future)
- If the user wants to *completely* hide Moov, we would need to build a custom form that hits the Moov API directly. However, the user explicitly mentioned the "hosted onboarding" guide, which uses a Moov-hosted link that is generated via API.

## Technical Details

- **Tooling**: Use `moov-onboarding-link` Edge Function to call Moov's `/onboarding-invites` endpoint.
- **Data Mapping**:
    - `legalBusinessName`: From `tenants.name`
    - `email`: From `tenants.email_from_address` or `tenants.email_reply_to`
    - `phone`: From `tenants.business_phone`
- **Security**: All API calls to Moov are performed server-side in Edge Functions using the platform's API keys stored in secrets.

## Questions for the User
1. Do you want the onboarding to open in a new tab, or should we try to embed it within a modal/iframe inside the app?
2. Are there specific merchant details (like SSN, EIN, or address) that you already collect in ChecksOps that we should attempt to pass through the API to pre-fill the Moov form?
