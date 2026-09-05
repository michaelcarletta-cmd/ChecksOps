# Production Cognito architecture (prepared, not switched)

Production ChecksOps today remains Supabase Auth. This document is the AWS replacement design.

## Pool (must be new)

| Field | Production | Staging (do not reuse) |
|---|---|---|
| User pool name | `checksops-production` | `checksops-staging` |
| Pool id | **not created** | `us-east-1_vPmQ7cL1F` |
| App client | new SPA client, no secret | `71bb7a192cbl6o6s8m259tl589` |
| `PreventUserExistenceErrors` | ENABLED | ENABLED |
| First auth factors | EMAIL_OTP, WEB_AUTHN, PASSWORD | same |
| Email delivery | SES verified identity for `checksops.com` / `notify.checksops.com` | Cognito default / tester intercept |
| WebAuthn RP ID | `checksops.com` | `staging.checksops.com` |
| WebAuthn origin | `https://checksops.com` | `https://staging.checksops.com` |
| Preferred software MFA | **false** until TOTP step-up is approved | false |

Do not point `.env.production` at the staging pool.

## EMAIL_OTP

Staging already uses `USER_AUTH` + `PREFERRED_CHALLENGE: EMAIL_OTP` (`/auth/passwordless/*`). Production uses the same routes after a production pool exists.

Production SES:

1. Verify domain identity for the From address (not the Lovable Resend path).
2. Cognito `EmailConfiguration.EmailSendingAccount = DEVELOPER` with `SourceArn` of that SES identity.
3. Keep `PreventUserExistenceErrors` so missing users get a generic failure.

Staging EMAIL_OTP is **GO**. Production EMAIL_OTP is **prepared / not switched**.

## Identity import (dry-run only)

Script: `aws/cutover/scripts/identity-migration-dry-run.mjs`

- Map eight known emails onto existing `application_user_id` values.
- Refuse `application_user_id === cognito_sub`.
- Exclude ninth UUID (`dd24eea5-5d12-47d1-999e-d5930c278b7d`) — orphan, no email.
- `--apply` exits non-zero. This PR does not create Cognito users.

Production passkeys in `user_passkeys` are **not** migrated. Users EMAIL_OTP first, then register Cognito WebAuthn on `https://checksops.com`.

## WebAuthn RP

A future production Lambda must set:

```
COGNITO_WEBAUTHN_ORIGIN=https://checksops.com
COGNITO_WEBAUTHN_RP_ID=checksops.com
SIGN_BASE_URL=https://checksops.com
```

Live staging template keeps staging origin/RP ID hardcoded.
