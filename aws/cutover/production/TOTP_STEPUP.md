# Financial TOTP / step-up (prepared, flags OFF)

Production money movement still uses Supabase `auth.mfa` TOTP. AWS staging financial execution stays **off**.

## Prepared now

- `/auth/mfa/associate` — Cognito `AssociateSoftwareToken`
- `/auth/mfa/verify` — Cognito `VerifySoftwareToken` (enrollment only)
- `/auth/mfa/status` — `GetUser` MFA list
- `/auth/mfa/set-preference` — **always 403** (`AWS_COGNITO_MFA_PREFERRED` stays false)
- AWS client MFA methods call those routes
- Responses always include `financialPermissionsActivated: false` and `moneyMovementUnlocked: false`
- `financial_stepup_log` insert-only write path already exists

## Intentionally not done

| Item | Why |
|---|---|
| `SetUserMFAPreference` preferred SOFTWARE_TOKEN_MFA | Would change EMAIL_OTP-first login |
| Treat step-up success as money authority | `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` remains false; provider flags remain false |
| Migrate Supabase TOTP factors | Not portable into Cognito |
| Apply `64_financial_activation_grants.sql` | Forbidden |

## Remaining after this PR

1. Decide whether production login stays EMAIL_OTP/WebAuthn-only at DNS cut (recommended while money flags are off).
2. If TOTP is required before money-on, enable preferred MFA on the **production** pool only after EMAIL_OTP still works, then add a logged-in step-up challenge that does not unlock flags by itself.
3. Named review still required before financial grants / provider execution.
