# Moov Implementation Plan

The Moov integration is already extensive, following the platform model where each tenant has its own connected account. The "API Quick Start" mentioned is likely already reflected in the current architecture.

## Status Audit
- **Infrastructure**: Shared REST client (`moovClient.ts`) and security middleware (`moovGuard.ts`) are implemented.
- **Account Management**: `moov-account-create`, `moov-sync`, and `moov-readiness` handle the lifecycle.
- **Money Movement**: `moov-transfer-create` and `moov-disburse` are ready.
- **Verification**: KYC/KYB document uploads (`moov-account-file-upload`) and micro-deposits (`moov-micro-deposit-initiate/confirm`) are live.
- **Frontend**: The `moovProvider.ts` adapter connects the UI to these backend functions.

## Recommendations
Based on the quick-start guide, we should ensure the following refinements are in place to move closer to production readiness:

### 1. Webhook Robustness
Enhance `moov-webhook` to handle more granular status changes (e.g., `transfer.updated`, `dispute.created`) to ensure the local database stays in sync with Moov state without relying solely on manual syncs.

### 2. Capabilities Management
Ensure `moov-sync` proactively requests missing capabilities if a tenant's profile is updated (e.g., adding a rep might be required for `send-funds`).

### 3. Error Handling
Standardize error reporting in `moovClient.ts` to map Moov-specific error codes to user-friendly messages in the UI.

### Technical Details
- **Environment**: Currently pinned to `sandbox` in `moovClient.ts`.
- **Authentication**: Uses platform-level `MOOV_PUBLIC_KEY` and `MOOV_SECRET_KEY` with scoped token exchange.
- **Idempotency**: Implemented in `moov-transfer-create` to prevent duplicate payouts.

No immediate actions are required to "start" with the API as the core integration is already mature, but we can proceed with strengthening the webhook and sync logic.
