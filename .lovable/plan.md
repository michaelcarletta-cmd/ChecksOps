# Plan - Test Moov Process with Sandbox Credentials

The user wants to test the Moov process using sandbox credentials, specifically moving money to the Moov wallet. The system is already built for this but is gated behind several conditions. I will enable the necessary flags for testing and ensure the Wallet UI is visible for the target tenant.

## Proposed Changes

### 1. Database Configuration
- Ensure the `freedom` tenant (and any other test tenant) is allowlisted for Moov.
- Ensure the `freedom` tenant has `payment_provider` set to `moov` to use the new rail.
- Ensure the user being used for testing has the `admin` role in `user_roles` or a high-privilege role in `tenant_users` to see the Payments > Settings tab.

### 2. Secrets & Environment
- The user provided Moov production details in a previous message, but the codebase (specifically `_shared/moovClient.ts`) explicitly refuses production for now.
- I will verify if `MOOV_PUBLIC_KEY` and `MOOV_SECRET_KEY` (sandbox) are set.
- I will keep the environment as `sandbox` as requested for "testing".

### 3. UI Adjustments
- The `WalletPanel` is currently only visible if `enabled` is true from `usePaymentProviderEligibility`.
- `enabled` requires `moov_allowlisted` to be true on the tenant.
- I will verify the current user's role and ensure they can see the "Payment Settings" tab where the `WalletPanel` lives.

### 4. Verification
- Use a Playwright script to:
  1. Log in as a test user.
  2. Navigate to `/{slug}/payments`.
  3. Click on the "Payment Settings" tab.
  4. Verify the "Organization balance" (WalletPanel) is visible.
  5. Check the status of the Moov account.

## Implementation Steps

1. **SQL Migration**:
   - Update `public.tenants` for the test tenant to set `moov_allowlisted = true`, `moov_environment = 'sandbox'`, and `payment_provider = 'moov'`.
   - Ensure the current user has the `admin` role.

2. **Wait for UI Refresh**:
   - The frontend should pick up the changes via `usePaymentProviderEligibility`.

3. **Manual/Automated Test**:
   - Provide the user with the path to the wallet funding UI (Payments > Payment Settings).
