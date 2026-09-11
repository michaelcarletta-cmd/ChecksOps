# M6.3N — Production login MFA disable-only

**Executed 2026-09-11T12:48Z.** One Cognito mutation. EMAIL_OTP login was **not**
completed for the human.

Do **not** delete the software token, change password, touch passkeys, overlay
repo `auth-cognito.mjs`, enable money flags, apply SQL72, or move money.

## Return card

```
MFA DISABLE EXECUTED: YES
IAM RESULT: Allow (exit 0, ChecksOpsCursorCloudStaging)
COGNITO MFA AFTER: UserMFASettingList empty/null (SOFTWARE_TOKEN_MFA removed)
PREFERRED MFA: null/unset
EMAIL_OTP AVAILABLE: YES (USER_AUTH without preferred; OTP not sent)
PASSWORD CHANGED: NO
PASSKEYS CHANGED: NO
GLOBAL SIGNOUT: NO
AUTH-COGNITO SHA: d3c8178fd5fa9709da055e0fbed3ec41dc2243d8f4a729479257a6decb0cd199 (unchanged)
PRODUCTION APP TOTP: NOT ENROLLED
MONEY FLAGS: unchanged (execution false)
MONEY MOVED: NO
SAFE FOR HUMAN EMAIL_OTP LOGIN: YES
GO/NO-GO: GO for human EMAIL_OTP login only.
          NO-GO for money, SQL72, password, passkeys, AdminDeleteSoftwareToken,
          admin-reset-totp, overlaying repo auth-cognito.mjs, agent-completed login.

STOP FOR REVIEW.
```

## Mutation (exactly one)

```bash
aws cognito-idp admin-set-user-mfa-preference \
  --user-pool-id us-east-1_h00WorYMT \
  --username a45884b8-d051-70b3-b19d-ca704964c6e8 \
  --software-token-mfa-settings Enabled=false,PreferredMfa=false
```

Principal: `arn:aws:sts::806168576068:assumed-role/ChecksOpsCursorCloudStaging/checksops-t0-run`.
CLI exit 0. No `AccessDenied`. No second auth mutation.

Not called: `AdminDeleteSoftwareToken`, `AdminUserGlobalSignOut`,
`AdminSetUserPassword`, `DeleteWebAuthnCredential`, `SetUserPoolMfaConfig`,
`admin-reset-totp`, Lambda overlay.

## Before / after

| Field | Before | After |
| --- | --- | --- |
| `UserMFASettingList` | `["SOFTWARE_TOKEN_MFA"]` | null / empty |
| `PreferredMfaSetting` | null | null |
| `UserLastModifiedDate` | `2026-09-10T18:56:10.659Z` | `2026-09-10T18:56:10.659Z` (Cognito did not bump it for this preference-only call) |
| USER_AUTH (no preferred) | `PASSWORD`, `PASSWORD_SRP` | `PASSWORD_SRP`, `PASSWORD`, **`EMAIL_OTP`** |
| OTP sent | no | no (`ChallengeName=SELECT_CHALLENGE`) |

`email_verified` remains `true`. User remains `CONFIRMED` / `Enabled`.

Pool last modified still `2026-09-05T22:27:59.855Z` (MFA OPTIONAL).
Client last modified still `2026-09-05T19:07:24.978Z`.
Pool software-token MFA remains enabled **at pool**; only this user's login
TOTP preference was disabled. WebAuthn stays `SINGLE_FACTOR` / `checksops.com`.

## EMAIL_OTP proof (no code sent)

`InitiateAuth` `USER_AUTH` with `USERNAME=mcarletta@freedomadj.com` and **no**
`PREFERRED_CHALLENGE`:

- `ChallengeName=SELECT_CHALLENGE`
- `AvailableChallenges=["PASSWORD_SRP","PASSWORD","EMAIL_OTP"]`
- Session present; `AuthenticationResult` absent
- `ChallengeName` was not `EMAIL_OTP`, so Cognito did not send a code

Live M6.3G `auth-cognito.mjs` (SHA unchanged) will set `PREFERRED_CHALLENGE=EMAIL_OTP`
and, if needed, `SELECT_CHALLENGE` `ANSWER=EMAIL_OTP`. The human must complete
that login in the product UI. This agent must not consume a code.

## Unchanged infrastructure

- Lambda CodeSha256 `iSlY+6TrrGJLPRUj5mOZ7drrAzHlMSpg/haisS02j8E=`
- Live `auth-cognito.mjs` SHA `d3c8178fd5fa9709da055e0fbed3ec41dc2243d8f4a729479257a6decb0cd199`
- `/auth/mfa/status` for production: `totpEnrolled=false`, `enrolledAt=null`,
  `source=financial_totp_enrollments`, issuer `ChecksOps Financial`
- Wrap key `checksops/production/financial-totp-wrap-key` not deleted
- `/db-health` TLS/auth/select1 ok
- Money flags: `AWS_MOOV_ENABLED=false`, `AWS_PROVIDER_EXECUTION_ENABLED=false`,
  `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`,
  `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=false`,
  `AWS_PROVIDER_LIVE_READS_ENABLED=true`, `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`

## Human next step

1. Complete normal EMAIL_OTP login as `mcarletta@freedomadj.com`.
2. Enroll a **new** “ChecksOps Financial” app-level authenticator (not Cognito login TOTP).
3. Later: prove step-up writes `financial_stepup_log` and Cognito
   `UserMFASettingList` remains without `SOFTWARE_TOKEN_MFA`.

Money flags stay false until a later activation review.
