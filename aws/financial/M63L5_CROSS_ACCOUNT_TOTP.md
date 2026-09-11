# M6.3L.5 — Cross-account TOTP association investigation

Read-only. No TOTP secret was decrypted, printed, or compared. No enrollment
was reset. Cognito, Moov, and money flags were not changed.

## Return card (2026-09-11T14:43Z)

```
MICHAEL APP USER: 7dbb3009-f059-4767-b5dc-1c5c72379330
MICHAEL ENROLLMENT VERIFIED: YES
ENROLLMENT TIMESTAMPS: enrolled_at 2026-09-11T14:42:38.412Z
                       verified_at 2026-09-11T14:43:13.231Z
ENROLLMENT METADATA: key_id financial-totp-v1; SHA1; 6 digits; 30s;
                     last_used_timestep null; issuer expected ChecksOps-Financial
CONDITION ONE APP USER: fd857564-9534-4b0f-95ac-624ed1273725
SAME APP USER: NO
CONDITION ONE FINANCIAL TOTP ROW: NONE
ENROLLMENT KEY SCOPE: application_user_id PRIMARY KEY / ON CONFLICT
LATEST MICHAEL SECRET VERIFIED: YES (enroll-confirm 200 at 14:43:12Z;
                              last_used_timestep still null)
IDENTITY MAPPING CORRECT: YES (Cognito sub a45884b8-d051-70b3-b19d-ca704964c6e8
                            → Michael app user; email mcarletta@freedomadj.com)
SECRET REUSE POSSIBLE FROM CODE PATH: NO
APPLE ASSOCIATION MOST LIKELY: YES — Apple Passwords attached/updated the new
                            ChecksOps-Financial secret onto the existing
                            payments@condition1commercial.com credential
                            and kept that display name
SECURITY ISSUE: NO ChecksOps cross-account secret reuse.
                Apple credential UI association only.
MICHAEL SHOULD DELETE CONDITION ONE ENTRY: NO (that entry is now the working
                            ChecksOps Financial authenticator; rename it)
MICHAEL SHOULD RE-ENROLL: NO
SAFE TO CONTINUE: YES
GO/NO-GO: GO to continue. NO-GO for money flags, Cognito changes, reset,
          or deleting the Apple entry.

STOP FOR REVIEW.
```

## Why the Condition One code worked

ChecksOps did **not** verify a Condition One enrollment. Condition One has
**no** `financial_totp_enrollments` row.

The 6-digit code Apple showed under `payments@condition1commercial.com` matched
Michael’s **newest** Freedom financial TOTP row because Apple most likely
wrote the new `ChecksOps-Financial` secret into that existing Passwords item
(issuer family `ChecksOps*`) instead of creating a second account. The display
name/email on the Apple credential stayed Condition One. Server isolation is
user-scoped and correct.

## Production rows (metadata only)

| | Freedom Michael | Condition One payments@ |
| --- | --- | --- |
| application_user_id | `7dbb3009-f059-4767-b5dc-1c5c72379330` | `fd857564-9534-4b0f-95ac-624ed1273725` |
| identity status | active | active |
| Cognito sub on identity_accounts | `a45884b8-d051-70b3-b19d-ca704964c6e8` | `e418f488-4011-7046-5a09-3f8b51140899` |
| tenant | freedom / admin | c1c / admin |
| financial TOTP row | YES, verified | **none** |
| enrolled_at / verified_at | 14:42:38Z / 14:43:13Z | — |
| key_id / alg / digits / period | financial-totp-v1 / SHA1 / 6 / 30 | — |
| last_used_timestep | null (enroll-confirm does not burn it) | — |

Wrapped-blob equality was not applicable: there is no C1C ciphertext to copy.
Secrets were not decrypted.

Production Cognito MFA is empty for both Michael and
`payments@condition1commercial.com` (C1C production username
`74286478-c0c1-7068-9fea-9deea6f61627`). The Apple Condition One-labeled
item is leftover UI from the old Cognito `ChecksOps` software-token QR, not a
live C1C app-level financial TOTP.

## HTTP access log (codes not logged)

Same ChecksOps session, after the L.4 issuer deploy (14:09Z):

| UTC | Path | Status |
| --- | --- | --- |
| 14:40:55 | `POST /prep/auth/mfa/associate` | 200 |
| 14:41:50 | logout | 200 |
| 14:41:54 / 14:42:15 | EMAIL_OTP start / verify | 200 |
| 14:42:38 | `POST /prep/auth/mfa/associate` | 200 |
| 14:43:12 | `POST /prep/auth/mfa/verify` | 200 |
| 14:43:13 | `POST /prep/auth/mfa/status` | 200 (body grew; now enrolled) |

`enrolled_at` matches the **second** associate. `verified_at` matches verify.
Rate-limit: `enroll_start` count 2 from 14:40:55; `enroll_confirm` count 1 at
14:43:13. Lambda success paths do not log Cognito sub, TOTP codes, or secrets.
Identity is `cognito_sub → identity_accounts.application_user_id` (not email,
not tenant). otpauth email is label-only.

## Code path (not a shared secret)

- PK / unique key: `PRIMARY KEY (application_user_id)` only
- UPSERT: `ON CONFLICT (application_user_id)` and only while `verified_at IS NULL`
- `p_user_id` must equal `auth.uid()`
- `generateTotpSecret()` is `randomBytes(20)` per associate
- Verify loads `financial_totp_get_enrollment($mapping.application_user_id)`

No tenant key, no email key, no C1C row to copy.

## Human next step

Keep the Apple entry. Rename it in Passwords to **ChecksOps Financial** /
`mcarletta@freedomadj.com`. Do not delete it. Do not re-enroll. Do not enable
money.

Rehearsal oneshot restored to
`Uuqs/fRkCulPrdKUj72FJTlHdTkfhVXc+mttZljUzwk=` / `index.handler`.
Prep Lambda CodeSha256 still `l9nHBQHn+cwwroKO9+czOXi2WMjoeChOpgVFtR0Tj7A=`.
Money flags remain false.
