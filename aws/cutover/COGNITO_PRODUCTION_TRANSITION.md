# Cognito EMAIL_OTP / WebAuthn production transition and rollback

**Do not create a production user pool or switch production authentication from this PR.**

## Staging (proven — PR #126)

| Surface | Status |
|---|---|
| CheckOps EMAIL_OTP + passkey UI | PASS |
| WhiteLabel EMAIL_OTP + passkey UI | PASS |
| MortgageOps EMAIL_OTP + passkey UI + session isolation | PASS |
| `/h/upload` OTP | PASS (AWS OTP; not a Cognito SPA session) |
| Mapping | `cognito_sub → identity_accounts.application_user_id → auth.uid()`; refuse `sub === application UUID` |
| Pool | `us-east-1_vPmQ7cL1F` (`checksops-staging`) |
| Client flows | `ALLOW_USER_AUTH`, SRP, password, refresh; `PreventUserExistenceErrors=ENABLED` |
| MFA | OFF |
| Email | `COGNITO_DEFAULT` (tester intercept policy) |
| WebAuthn RP | `staging.checksops.com` (code default; SAM now sets `COGNITO_WEBAUTHN_*` to staging) |

Production SimpleWebAuthn rows in `user_passkeys` are **not** migrated.

## Production transition (future)

1. New user pool `checksops-production`. **Do not reuse** `us-east-1_vPmQ7cL1F`.
2. RP ID / origin `checksops.com` / `https://checksops.com` (pick one canonical host; `www` must redirect to it or be in the RP allowlist).
3. SES verified identity; Cognito `EmailSendingAccount=DEVELOPER`.
4. First-auth factors: EMAIL_OTP, WEB_AUTHN, PASSWORD (master/UAT only). Preferred software MFA stays **false** until TOTP is approved.
5. Import/link the eight production emails onto existing application UUIDs. Exclude ninth UUID.
6. First login: EMAIL_OTP. Then register new Cognito passkeys.
7. Production Lambda env (not staging template):

```
COGNITO_WEBAUTHN_ORIGIN=https://checksops.com
COGNITO_WEBAUTHN_RP_ID=checksops.com
```

Live `aws/template.yaml` keeps staging origin/RP ID. `Environment=production` is still not an AllowedValues entry.

Frontend production env: `.env.production.aws.example` (uncomment only on approved deploy). Today `.env.production` has no Cognito variables.

Identity dry-run (no users created):

```bash
node aws/cutover/scripts/identity-migration-dry-run.mjs
# --apply is refused
```

## Rollback

- Pre-DNS: do nothing to production Auth.
- Post-DNS: revert DNS; Supabase Auth + existing passkeys/MFA still work. Disable production-pool users created for the failed wave.
- Do not point production DNS at the staging pool as an emergency Auth path (wrong RP ID, tester email intercept, UAT users).
