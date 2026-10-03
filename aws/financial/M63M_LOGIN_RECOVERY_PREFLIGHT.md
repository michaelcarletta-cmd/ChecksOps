# M6.3M — Production login recovery pre-flight

**PRE-FLIGHT ONLY. MFA was not changed.**

Do **not** call `AdminSetUserMFAPreference` until this card is approved.
Do **not** change `mcarletta@freedomadj.com` password, passkeys, pool, or client.
Do **not** `AdminDeleteSoftwareToken`. Do **not** use `admin-reset-totp.mjs`.
Do **not** overlay repo `auth-cognito.mjs` onto the live Lambda (that would drop M6.3G).
Do **not** touch Moov, recipient links, SQL72, or money flags.

M6.3L tester proof is accepted. This document is the remaining-blocker review
before the disable step.

## Return card (2026-09-11T12:40Z)

```
REMAINING BLOCKERS:
  None that keep app TOTP / SQL / wrap key / identity / Freedom admin /
  M6.3G selection unready.

  Still required before the disable is executed (process, not infra):
  1. Human approval of the exact mutation below.
  2. Executing principal must have cognito-idp:AdminSetUserMFAPreference
     on us-east-1_h00WorYMT. ChecksOpsCursorCloudStaging Allow is UNPROVEN
     (iam:SimulatePrincipalPolicy and ListRolePolicies denied). Do not probe
     by calling the API. If AccessDenied, use console/CLI with a principal
     that already has that action. Do not fall back to admin-reset-totp.
  3. EMAIL_OTP return is expected by tester-control analogy, not yet observed
     on this user. Immediate post-disable USER_AUTH proof is mandatory.
  4. Keep live auth-cognito.mjs SHA d3c8178fd5fa9709da055e0fbed3ec41dc2243d8f4a729479257a6decb0cd199.
     Repo file SHA e7665c559ca30cba515c3a42917378e0a1ae8f16b3d48a88757e13972eb0f5b2
     lacks SELECT_CHALLENGE fallback.

APP TOTP HEALTHY: YES
PRODUCTION IDENTITY MAPPING: CORRECT
PRODUCTION MEMBERSHIP: Freedom tenant_users.role=admin; user_roles.admin
CURRENT COGNITO MFA: UserMFASettingList=["SOFTWARE_TOKEN_MFA"]; PreferredMfaSetting=null
PASSKEY PRESERVATION: YES — mutation must omit WebAuthnMfaSettings; API does not delete credentials
M6.3G LOGIN FIX LIVE: YES (live zip; do not replace with repo)
EMAIL_OTP EXPECTED AFTER DISABLE: YES (expected, not proven on this user)
EXACT MFA MUTATION REQUIRED: AdminSetUserMFAPreference SoftwareTokenMfaSettings Enabled=false PreferredMfa=false only
GLOBAL SIGNOUT REQUIRED: NO
PASSWORD CHANGE REQUIRED: NO
PRODUCTION APP TOTP CURRENTLY ENROLLED: NO
FAILURE/ROLLBACK PLAN: Do not re-enable SOFTWARE_TOKEN_MFA; STOP; see below
SAFE TO BEGIN LOGIN RECOVERY: YES
GO/NO-GO: GO for AdminSetUserMFAPreference disable-only after human approval.
          NO-GO for money, SQL72, password, passkeys, AdminDeleteSoftwareToken,
          admin-reset-totp, pool/client edits, overlaying repo auth-cognito.mjs.

STOP FOR REVIEW.
```

## What was verified (read-only)

Probes used `AdminGetUser`, `InitiateAuth` USER_AUTH **without**
`PREFERRED_CHALLENGE` (does not send EMAIL_OTP), Lambda invoke of `/health`,
`/db-health`, `/financial/status`, `/auth/mfa/status`, Secrets Manager
`describe-secret` + resource policy, and a download of the live Lambda zip.
`AdminSetUserMFAPreference` was **not** called. Passwordless/start with
preferred EMAIL_OTP was **not** invoked for the production user (that would
send mail if Cognito accepted it).

Production `UserLastModifiedDate` remains `2026-09-10T18:56:10.659Z`.

### App TOTP infrastructure

| Check | Result |
| --- | --- |
| Lambda `checksops-production-prep-api` | Active, last update Successful, CodeSha256 `iSlY+6TrrGJLPRUj5mOZ7drrAzHlMSpg/haisS02j8E=` |
| `/health` | 200 `production-prep` |
| `/db-health` | TLS/auth/select1 ok; DB `checksops` as `checksops` |
| `/financial/status` | money execution flags false |
| Wrap key | `checksops/production/financial-totp-wrap-key` ARN `.../checksops/production/financial-totp-wrap-key-81bFID`; `DeletedDate` null |
| Lambda env | `FINANCIAL_TOTP_WRAP_KEY_ARN` set; hex `FINANCIAL_TOTP_WRAP_KEY` absent |
| Wrap resource policy | `GetSecretValue` only for `checksops-production-api-execution` on that ARN |
| Identity IAM on Lambda role | still not applied (`iam:PutRolePolicy` AccessDenied in M6.3L); live GetSecretValue already proved via tester enroll |
| SQL | `financial_totp_enrollments` + `financial_totp_rate_limits` RLS on; DEFINER functions owned by `checksops_admin` with `search_path=public, pg_temp` |
| Live financial handlers | `financial-totp.mjs` / `auth-financial-totp.mjs` / `auth-mfa.mjs` match the M6.3L overlay; issuer `ChecksOps Financial`; no Associate/Verify/SetUserMFAPreference on enroll |
| Tester `/auth/mfa/status` | `totpEnrolled=true`, `source=financial_totp_enrollments` |
| Production `/auth/mfa/status` | `totpEnrolled=false`, `enrolledAt=null`, same source |

Money flags on the Lambda (must stay false):
`AWS_MOOV_ENABLED`, `AWS_PROVIDER_EXECUTION_ENABLED`,
`AWS_FINANCIAL_PERMISSIONS_ACTIVATED`, `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED`.
Keep `AWS_PROVIDER_LIVE_READS_ENABLED=true`, `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`,
`AWS_COGNITO_MFA_PREFERRED=false`, `CHECKSOPS_ENV=production-prep`.

Rehearsal oneshot CodeSha256 is the original
`Uuqs/fRkCulPrdKUj72FJTlHdTkfhVXc+mttZljUzwk=` (pre-flight SQL overlay restored).

### Production identity and membership

| Field | Value |
| --- | --- |
| Email | `mcarletta@freedomadj.com` (`email_verified=true`) |
| Pool / client | `us-east-1_h00WorYMT` / `3ja9fqaq2fjkv3i6up2varcqpe` (`checksops-production-web`) |
| Cognito username/sub | `a45884b8-d051-70b3-b19d-ca704964c6e8` |
| App UUID | `7dbb3009-f059-4767-b5dc-1c5c72379330` |
| `identity_accounts` | `cognito_sub` matches production pool sub; `status=active`; production email match true |
| Freedom membership | `tenant_users.role=admin` on `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a` (slug `freedom`) |
| `user_roles` | `admin` |

Tester control (not mutated): `checksops-tester@freedomadj.com`, app UUID
`abd3c2a0-6dc0-4680-92dd-a013e1141c91`, production Cognito username
`f468b438-4081-7004-d865-a1b86eb19beb`, `UserMFASettingList` empty,
`UserLastModifiedDate` `2026-09-10T18:53:52.398Z`, Freedom `operator` / `staff`,
app TOTP enrolled.

### Current Cognito MFA vs EMAIL_OTP

Pool MFA OPTIONAL. Software token MFA enabled **at pool**. WebAuthn RP
`checksops.com`, `FactorConfiguration=SINGLE_FACTOR`. Recovery `verified_email`.
Client flows: USER_AUTH / PASSWORD / SRP / REFRESH. Sign-in first factors:
`EMAIL_OTP`, `PASSWORD`, `WEB_AUTHN`. `PreventUserExistenceErrors=ENABLED`.
Account-takeover medium/high historically `MFA_IF_CONFIGURED` (Batch 3).
Client last modified `2026-09-05T19:07:24.978Z` (unchanged).

Production USER_AUTH **without** preferred challenge:

- `ChallengeName=SELECT_CHALLENGE`
- `AvailableChallenges=["PASSWORD","PASSWORD_SRP"]`
- **No EMAIL_OTP. No WEB_AUTHN.** Session present. OTP not sent.

Tester USER_AUTH **without** preferred challenge, same pool/client:

- `AvailableChallenges=["PASSWORD_SRP","PASSWORD","EMAIL_OTP"]`

That is the login outage: `SOFTWARE_TOKEN_MFA` on the user correlates with
EMAIL_OTP missing from USER_AUTH. The tester without login TOTP still gets
EMAIL_OTP. After disable, EMAIL_OTP is **expected** by that control, **not
yet proven** on `mcarletta@freedomadj.com`.

Live passwordless/start (`initiateUserAuth(email, true)`) sets
`PREFERRED_CHALLENGE=EMAIL_OTP`. If Cognito returns `SELECT_CHALLENGE` and
EMAIL_OTP is listed, it `RespondToAuthChallenge` `ANSWER=EMAIL_OTP`. If EMAIL_OTP
is not listed it fail-closes `email_otp_unavailable`. That is why production
login currently 409s. After disable, the same code should issue EMAIL_OTP
once the challenge is listed (as it does for the tester).

### Passkeys

`ListWebAuthnCredentials` requires a user access token; there is no admin list.
Neither production nor tester USER_AUTH listed `WEB_AUTHN`, so these users
likely have no Cognito passkeys as a first factor.

`AdminSetUserMFAPreference` with **only** `SoftwareTokenMfaSettings` does not
call `DeleteWebAuthnCredential`. AWS documents that disabling TOTP MFA does
not reset/delete the software token, and passkey credentials are a separate
API. Pool WebAuthn stays `SINGLE_FACTOR`.

**Do not pass** `--web-authn-mfa-settings` or `--email-mfa-settings` or
`--sms-mfa-settings`. Those are out of scope.

### Global sign-out and password

`aws/functions/api/admin-reset-totp.mjs` also calls `AdminUserGlobalSignOut`
and nulls `profiles.totp_enrolled_at`. That helper is **not** the recovery
path. The user is locked out at first-factor USER_AUTH; leftover refresh
tokens are not a justified reason to global-sign-out before EMAIL_OTP is
restored.

PASSWORD remains in `AvailableChallenges`. The UI is passwordless. Do **not**
change or reset the password. Do **not** use password as the recovery path
unless a later review authorizes it after EMAIL_OTP failure.

## Exact mutation (do not run now)

```bash
aws cognito-idp admin-set-user-mfa-preference \
  --user-pool-id us-east-1_h00WorYMT \
  --username a45884b8-d051-70b3-b19d-ca704964c6e8 \
  --software-token-mfa-settings Enabled=false,PreferredMfa=false
```

Do **not**:

- `AdminDeleteSoftwareToken`
- `AdminSetUserPassword` / forgot-password
- `AdminUserGlobalSignOut`
- `SetUserPoolMfaConfig` / client updates
- enable SMS, email MFA, or another login MFA
- pass `WebAuthnMfaSettings`
- touch passkeys
- overlay repo `auth-cognito.mjs`

## Approved sequence after this pre-flight is accepted

1. Disable SOFTWARE_TOKEN_MFA as LOGIN MFA with the command above.
2. Immediately prove USER_AUTH **without** preferred challenge lists
   `EMAIL_OTP` (same probe as this pre-flight; does not send mail).
3. Confirm `AdminGetUser` `UserMFASettingList` no longer contains
   `SOFTWARE_TOKEN_MFA`. `UserLastModifiedDate` will change; that is expected.
4. STOP. Human completes normal EMAIL_OTP login in the product UI.
   Do not consume extra codes during probes. Do not call passwordless/start
   with preferred EMAIL_OTP from this agent after the list-proof (that sends
   the human's code).
5. Once logged in, enroll a **new** “ChecksOps Financial” app-level authenticator
   (`financial_totp_enrollments`, issuer `ChecksOps Financial`). This is not
   Cognito login TOTP.
6. Verify financial step-up writes a bound `financial_stepup_log`
   (`deposit.submit`, server amount/tenant from `check_intake_items`).
7. Confirm Cognito `UserMFASettingList` remains without `SOFTWARE_TOKEN_MFA`.

Window after step 1 and before step 5: production app TOTP is absent.
Money flags stay false, so no live money movement.

## Failure / rollback if EMAIL_OTP does not return

If disable succeeds and USER_AUTH still lacks EMAIL_OTP:

1. STOP. Do not keep mutating.
2. **Do not re-enable** `SOFTWARE_TOKEN_MFA` (that recreates this outage).
3. Do not re-enable preferred MFA.
4. Do not delete the software token.
5. Do not change password, pool, or client.
6. Do not global-sign-out as a “fix”.
7. Re-read `AdminGetUser` to confirm the disable actually applied.
8. Re-run tester USER_AUTH as a control (must still list EMAIL_OTP).
9. New review. Possible later exception (not authorized here): password
   first-factor still exists on USER_AUTH, but the product login path must
   stay EMAIL_OTP/passkey unless explicitly approved.

If disable **fails** (`AccessDenied` / API error):

1. User MFA must remain `SOFTWARE_TOKEN_MFA` / last modified
   `2026-09-10T18:56:10.659Z`.
2. Retry only with a principal that has `AdminSetUserMFAPreference`.
3. Do not use `admin-reset-totp`.

## Holds that remain after GO

- Money flags stay false.
- SQL72 not applied.
- No Moov / recipient-link / provider execution.
- No production app TOTP enroll until the human is logged in.
- No overlay of repo `auth-cognito.mjs`.
