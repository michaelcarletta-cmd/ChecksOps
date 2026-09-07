# SECURITY HARDENING BATCH 3: PASS / FAIL

**Status:** pending live apply and validation.  
**STOP FOR REVIEW** after the live result is recorded below.

Financial/provider activation remains **NOT AUTHORIZED**.
Moov, CheckAlt, provider execution, financial execution, and
`64_financial_activation_grants.sql` stay **OFF / NOT_APPLIED**.
API-behind-CloudFront is a later must-fix and is **not** deployed here.

## Intended policy (login usability preserved)

| Control | Policy |
|---|---|
| First-factor login | Unchanged: EMAIL_OTP, PASSWORD, WEB_AUTHN |
| Pool MFA | **OPTIONAL** (not ON/required) |
| Preferred MFA at login | **OFF** (`AWS_COGNITO_MFA_PREFERRED` stays false; `/auth/mfa/set-preference` stays 403) |
| Software TOTP | Enroll via `/auth/mfa/associate` + `/verify`. Not required at login |
| WebAuthn | RP `checksops.com`, `UserVerification=preferred`, **SINGLE_FACTOR** first-factor passkeys |
| Admin/staff/owner/manager | Enroll TOTP **or** a passkey before privileged/financial **actions** |
| Gated now | Not `/data`, `/storage`, `/identity`, login, or enroll routes |
| Financial step-up | Advertised now; enforced before activation. Money flags stay false |
| Recovery | `verified_email` only (no SMS) |
| TOTP reset | Existing `admin-reset-totp` (admin only; disable + global sign-out) |
| Password policy | 12 chars, upper/lower/number/symbol (unchanged) |
| Risk / lockout | MFA-if-configured on medium/high takeover **if** the pool tier allows. No forced lockouts that break current login. No SMS MFA |
| Staging pool | MFA stays OFF, RP `staging.checksops.com` (do not modify) |

## Live result

Filled after `--confirm-batch3` apply and smoke.

**SECURITY HARDENING BATCH 3: pending**
