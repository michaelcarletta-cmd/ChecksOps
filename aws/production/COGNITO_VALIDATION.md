# Production Cognito pool/client validation (not switched)

**Do not invite, import, or switch production auth.** Pool `us-east-1_h00WorYMT` is prepared only. Staging pool `us-east-1_vPmQ7cL1F` must not be reused.

Validated live 2026-09-05 via `cognito-idp describe-user-pool` / `describe-user-pool-client` / `list-users` / `get-user-pool-mfa-config`. No `UpdateUserPool` / `AdminCreateUser` from this pass.

## Pool `us-east-1_h00WorYMT` (`checksops-production`)

| Setting | Live value | Expected for prep | Status |
|---|---|---|---|
| Users | **0** | 0 until import | **GO (prepared, not switched)** |
| Deletion protection | ACTIVE | ACTIVE | **GO** |
| Username attributes | email | email | **GO** |
| Auto-verified | email | email | **GO** |
| MFA | OFF | OFF until TOTP approved | **GO** |
| First-auth factors | EMAIL_OTP, PASSWORD, WEB_AUTHN | same | **GO** |
| Email sending | `COGNITO_DEFAULT` | SES `DEVELOPER` + verified From | **PARTIAL** — SES From outstanding |
| WebAuthn RP ID | `checksops.com` (`UserVerification=preferred`, `SINGLE_FACTOR`) | `checksops.com` | **GO (prepared, not switched)** |
| Domain / custom domain | none | none until cutover | **GO** |
| Lambda triggers | none | none | **GO** |
| Tags | `DoNotCutover=true`, `DoNotSwitchAuth=true`, `Environment=production-prep` | present | **GO** |
| User pool tier | ESSENTIALS | ESSENTIALS | **GO** |

Staging comparison: pool `us-east-1_vPmQ7cL1F` has `WebAuthnConfiguration.RelyingPartyId=staging.checksops.com`, MFA OFF, 13 users, also `COGNITO_DEFAULT` email. Do not copy staging users onto production.

Live `get-user-pool-mfa-config` on `us-east-1_h00WorYMT` already returns `RelyingPartyId=checksops.com`. Staging pool remains `staging.checksops.com`. Do not run `UpdateUserPool` (omitted fields reset to defaults). Do not invite or import users.

## Client `3ja9fqaq2fjkv3i6up2varcqpe` (`checksops-production-web`)

| Setting | Live value | Status |
|---|---|---|
| Generate secret | false (public SPA client) | **GO** |
| ExplicitAuthFlows | ALLOW_USER_AUTH, ALLOW_USER_SRP_AUTH, ALLOW_USER_PASSWORD_AUTH, ALLOW_REFRESH_TOKEN_AUTH | **GO** |
| PreventUserExistenceErrors | ENABLED | **GO** |
| Token revocation | true | **GO** |
| Access/Id token | 60 minutes | **GO** |
| Refresh token | 30 days | **GO** |
| OAuth / hosted UI | AllowedOAuthFlowsUserPoolClient=false | **GO** (SPA uses USER_AUTH, not hosted UI) |
| In `.env.production` | **no** | **GO** (production SPA still Supabase) |

## Not done (auth switch — cutover decision)

- Identity import of the eight production emails (`--apply` remains refused)
- Pointing `.env.production` at this pool/client
- Attaching SES From (`EmailSendingAccount=DEVELOPER`)
- Setting WebAuthn RP ID on the pool
- Creating a Cognito domain
