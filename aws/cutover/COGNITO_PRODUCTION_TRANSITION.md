# Cognito EMAIL_OTP / WebAuthn production transition and rollback

**Do not switch production authentication from this PR.** Production pool `us-east-1_h00WorYMT` is prepared with **0 users**. Do not invite or import.

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

## Production pool (prepared, not switched)

Live validation: `aws/production/COGNITO_VALIDATION.md`. SES: `aws/production/SES_EMAIL_OTP_READINESS.md`.

1. Pool `checksops-production` / `us-east-1_h00WorYMT` exists. **Do not reuse** `us-east-1_vPmQ7cL1F`.
2. Client `checksops-production-web` / `3ja9fqaq2fjkv3i6up2varcqpe` — `ALLOW_USER_AUTH`, MFA OFF, 0 users.
3. RP ID / origin still need operator console set to `checksops.com` / `https://checksops.com` on **this pool only**.
4. SES verified identity and Cognito `EmailSendingAccount=DEVELOPER` still outstanding (`COGNITO_DEFAULT` today).
5. Import/link the eight production emails onto existing application UUIDs is a **cutover decision**. Exclude ninth UUID. `--apply` remains refused.
6. First login: EMAIL_OTP. Then register new Cognito passkeys.
7. Production-prep API templates (not live staging SAM) hard-code:

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
