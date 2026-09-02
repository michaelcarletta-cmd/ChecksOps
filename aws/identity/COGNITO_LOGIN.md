# Staging controlled Cognito login / password activation

This phase establishes the real Cognito email/password lifecycle for the **eight onboarded users only**. It does **not** cut over the production or staging frontend.

Identity remains:

`Cognito sub -> identity_accounts.application_user_id -> existing ChecksOps UUID -> request.app_user_id -> auth.uid()`

## Out of scope

- ninth UUID `dd24eea5-5d12-47d1-999e-d5930c278b7d`
- disabled probe `staging-identity-probe-c48b@checksops.invalid` / `2418c458-c011-70b7-07ac-6b9da2d9415d`
- bulk invitations or `AdminResetUserPassword`
- importing Supabase password hashes
- Resend / Moov / CheckAlt / Plaid / payment / webhook / Storage / DNS / `main` / production Lovable
- enabling `default_transaction_read_only=off`
- changing the 165 `aws_select_*` or 127 `aws_write_*` policies, 47 identity FKs, 83 Freedom claims, or 97 NULL-org claims

## Recorded pool configuration (before this phase)

| Setting | Value |
| --- | --- |
| Pool | `us-east-1_vPmQ7cL1F` (`checksops-staging`) |
| Client | `71bb7a192cbl6o6s8m259tl589` (`checksops-staging-web`, no secret) |
| Username | email |
| Auth flows (before) | `ALLOW_USER_SRP_AUTH`, `ALLOW_REFRESH_TOKEN_AUTH`, `ALLOW_ADMIN_USER_PASSWORD_AUTH` |
| Password policy | 12+, upper, lower, number, symbol; temp validity 7 days |
| Recovery | `verified_email` |
| Email | `COGNITO_DEFAULT` (not Resend, no custom sender) |
| MFA | OFF |
| UnusedAccountValidityDays | 7 |
| Tokens | ID/access 60 minutes, refresh 30 days, revocation enabled |
| OAuth / hosted UI | disabled |
| HTTP API JWT authorizer | iss pool, aud client |

## Activation procedure (no bulk email)

Users are `FORCE_CHANGE_PASSWORD` with discarded temps. Do **not** call `ForgotPassword` / `AdminResetUserPassword` / `AdminCreateUser MessageAction=RESEND` on the six non-lifecycle users.

1. Enable `ALLOW_USER_PASSWORD_AUTH` on the existing web client (frontend email/password). Keep SRP and refresh.
2. For **one Freedom user** (`checksops-tester@freedomadj.com`) and **one C1C user** (`payments@condition1commercial.com`) only:
   - `AdminSetUserPassword` temporary (no email)
   - public `InitiateAuth` `USER_PASSWORD_AUTH` → `NEW_PASSWORD_REQUIRED`
   - `RespondToAuthChallenge` with a new password (first-password-change)
   - public `InitiateAuth` again (normal login)
   - `REFRESH_TOKEN_AUTH`
   - `GlobalSignOut` / `RevokeToken`
3. Leave the other six in `FORCE_CHANGE_PASSWORD`. Verify mappings and Cognito attributes only.
4. Forgot-password: do not send `COGNITO_DEFAULT` mail to real inboxes. Prefer a suppressed/intercepted delivery for Tester only. If interception is unavailable, do not call `ForgotPassword` on a real mailbox.
5. Call `/identity/me` and `/authorization/isolation` with the resulting **ID** tokens. Confirm `auth.uid()` is the original ChecksOps UUID.
6. Reject unauthenticated, malformed, expired, wrong-audience, and wrong-issuer tokens. Using a Cognito `sub` as `request.app_user_id` must yield zero tenant rows.

## STOP

Live results: `aws/identity/COGNITO_LOGIN_RESULTS.md`. Do not wire the production frontend. Do not change DNS.
