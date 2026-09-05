# SES From for production Cognito (not switched)

Production pool `us-east-1_h00WorYMT` currently uses `EmailSendingAccount=COGNITO_DEFAULT` (same as staging). Estimated users: **0**. Auth is **not** switched.

This Cloud Agent role **cannot** call SES (`ListIdentities`, `GetIdentityVerificationAttributes`, `VerifyDomainIdentity` all AccessDenied). A custom From address therefore cannot be attached from this PR.

## What is already true

| Item | Value |
|---|---|
| EMAIL_OTP first-auth factor | on the pool |
| MFA | OFF |
| WebAuthn RP | `checksops.com` (set via `SetUserPoolMfaConfig`, not staging) |
| Email sending | `COGNITO_DEFAULT` |

Cognito-default mail is enough to **prepare** EMAIL_OTP. It is **not** a branded `noreply@checksops.com` From.

## Operator follow-up (does not switch auth)

1. Verify SES domain `checksops.com` in us-east-1 (DNS CNAMEs under `_amazonses` / DKIM — **not** apex/`www` A records).
2. `UpdateUserPool` on **`us-east-1_h00WorYMT` only** with `EmailSendingAccount=DEVELOPER` and a verified From. Preserve existing `SignInPolicy`, MFA OFF, deletion protection, and WebAuthn. **Never** run this against `us-east-1_vPmQ7cL1F`.
3. Send a test EMAIL_OTP to a non-production mailbox. Do not invite the eight production users until cutover.

Do not point `.env.production` at this pool until cutover approval.
