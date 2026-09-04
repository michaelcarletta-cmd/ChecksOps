# Add a secure administrator two-factor reset

## Goal
Allow an authorized administrator to clear a stale authenticator from a user account when the user no longer has access to the linked app, without deleting or changing the user account.

## Implementation
- Add one narrowly scoped backend function for two-factor resets.
- Require a signed-in administrator and verify the administrator role on the server before any reset.
- Accept a user ID, list only that user’s authenticator factors, remove only TOTP factors, and clear the profile’s two-factor enrollment timestamp.
- Never return factor secrets or expose server credentials.
- Add a **Reset two-factor** control beside users in Settings → User Management, with a confirmation prompt and clear success/error feedback.
- Replace the obsolete password-reset controls in User Management so the screen matches ChecksOps’ passwordless login policy.

## Immediate account recovery
- Use the new administrator control to reset only `mcarletta@freedomadj.com` after deployment.
- The reset will sign that account out of active sessions; sign in again by magic link, then go to Settings → Profile → Two-factor authentication to scan a new QR code.

## Verification
- Confirm non-admin users cannot invoke the reset.
- Confirm the selected account has no linked TOTP factor after reset.
- Confirm a fresh setup displays a QR code and can enroll a new authenticator.
- Confirm no roles, tenant access, passkeys, payment settings, or other users are changed.
