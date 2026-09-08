# SECURITY HARDENING BATCH 3: PASS

**Closed:** 2026-09-07  
**STOP FOR REVIEW.**

Financial and provider activation remains **NOT AUTHORIZED**.
Moov, CheckAlt, provider execution, financial execution, and
`64_financial_activation_grants.sql` stay **OFF / NOT_APPLIED**.
API-behind-CloudFront remains a later **MUST FIX** and was **not**
deployed in this batch.

## Verdict

| Check | Result |
|---|---|
| Production pool MFA | **OPTIONAL** (not ON/required) |
| Software TOTP | Enabled for enrollment |
| WebAuthn | RP `checksops.com`, `UserVerification=preferred`, **SINGLE_FACTOR** |
| First-factor login | Unchanged: EMAIL_OTP, PASSWORD, WEB_AUTHN |
| Password login without MFA challenge | **PASS** (tester + C1C admin) |
| Preferred MFA at login | **OFF** (`AWS_COGNITO_MFA_PREFERRED=false`; `/auth/mfa/set-preference` **403**) |
| Staging pool | MFA **OFF**, RP `staging.checksops.com` (unchanged) |
| Privileged policy advertised | `/identity/me` + `/financial/status` |
| `/data` `/storage` `/identity` usable without TOTP | **PASS** |
| Money / provider flags | All **false** |
| Prep Lambda role | `checksops-production-api-execution` (unchanged) |
| Public site / login / endorse | **200** |
| Recent prep Lambda ERROR logs | **0** (30 min after overlay) |

**SECURITY HARDENING BATCH 3: PASS**

## Live Cognito (production `us-east-1_h00WorYMT`)

| Setting | Value |
|---|---|
| `MfaConfiguration` | `OPTIONAL` |
| `SoftwareTokenMfaConfiguration.Enabled` | `true` |
| WebAuthn RP | `checksops.com` |
| WebAuthn user verification | `preferred` |
| WebAuthn factor | `SINGLE_FACTOR` |
| Allowed first factors | `EMAIL_OTP`, `PASSWORD`, `WEB_AUTHN` |
| Recovery | `verified_email` only (no SMS) |
| Password policy | 12 + upper/lower/number/symbol |
| Deletion protection | ACTIVE |
| Pool tier | ESSENTIALS |
| Client flows | USER_AUTH, PASSWORD, SRP, REFRESH |
| `PreventUserExistenceErrors` | ENABLED |
| SMS MFA | Not enabled |

## Risk / lockout

Applied on the production pool (Essentials allowed this configuration):

| Control | Action |
|---|---|
| Compromised credentials (sign-in, password change, sign-up) | `NO_ACTION` |
| Account-takeover low | `NO_ACTION` |
| Account-takeover medium / high | `MFA_IF_CONFIGURED` (notify false) |

No forced lockouts, no BLOCK on sign-in, and no preferred-MFA challenge.
Users without TOTP keep current password / EMAIL_OTP / passkey login.
Flood controls remain API throttle **50 rps / 100 burst** plus the live
CloudFront WAF.

## Privileged / financial operator policy

Roles: `admin`, `staff`, `owner`, `manager` (plus master owner).

- Enroll TOTP **or** a passkey before privileged/financial **actions**.
- Not enforced on `/data`, `/storage`, `/identity`, login, or enroll routes.
- Financial write routes stay flag-blocked (`unknown_operation` / 4xx).
- `/financial/status` advertises
  `financialOperatorStepUp=totp_or_webauthn_required_before_activation`
  and `apiBehindCloudFrontRequiredBeforeFinancial=true`.
- Money stays locked. This batch does **not** activate financial grants.

## Recovery and enrollment

| Flow | Policy |
|---|---|
| Password / account recovery | Cognito `verified_email` only |
| TOTP enroll | `/auth/mfa/associate` + `/auth/mfa/verify` (does not set preferred MFA) |
| TOTP reset | Admin-only `admin-reset-totp` (disable software token + global sign-out) |
| Passkey enroll | Existing Cognito WebAuthn routes; origin/RP `https://checksops.com` / `checksops.com` |
| Preferred MFA | Remains refused |

SPA TOTP UI (`TotpManagerCard` + `src/lib/awsMfa.ts`) ships in this PR
for the next frontend deploy. Live login usability does not depend on
that deploy.

## What was applied

1. `SetUserPoolMfaConfig` on **production only**: OPTIONAL + software token
   + existing WebAuthn block (so RP / SINGLE_FACTOR were not wiped).
2. `SetRiskConfiguration` as above.
3. Prep Lambda **code overlay only**: `privileged-auth.mjs`,
   `identity.mjs`, `financial.mjs`, `auth-mfa.mjs`.
4. No Lambda env / VPC / role change.
5. Staging pool not modified.
6. No API-behind-CloudFront redesign.

## What was not done

- Moov / CheckAlt / provider execution / financial execution: still OFF
- `64_financial_activation_grants.sql`: still NOT_APPLIED
- API-behind-CloudFront + execute-api restriction: still a later must-fix
- Pool MFA was **not** set ON/REQUIRED
- `AWS_COGNITO_MFA_PREFERRED` stays false
- SMS MFA not enabled

**SECURITY HARDENING BATCH 3: PASS**
