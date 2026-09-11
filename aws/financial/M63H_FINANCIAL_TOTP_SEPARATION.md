# M6.3H — Separate financial TOTP from Cognito login MFA

**STOP FOR REVIEW.** Do not disable or remove MFA on `mcarletta@freedomadj.com`.
Do not change password or `PreferredMfaSetting`. Do not apply the proposed SQL.
Do not deploy this as login recovery until the sequence below is approved.
Do not touch Moov, recipient links, SQL72, or money flags.

## Conflict

Cognito pool MFA is OPTIONAL. Enabling `SOFTWARE_TOKEN_MFA` on the user
(`SetUserMFAPreference` `Enabled: true`, `PreferredMfa: false`) makes
`USER_AUTH` offer only `PASSWORD` / `PASSWORD_SRP`. `EMAIL_OTP` leaves
`AvailableChallenges`. Lambda fail-closed cannot select it.

Normal ChecksOps login must remain EMAIL_OTP / WebAuthn. Authenticator TOTP
is intended only for financial step-up. Those two uses were collapsed onto
the same Cognito software token.

Current enroll path in `auth-mfa.mjs`: `AssociateSoftwareToken` →
`VerifySoftwareToken` → `SetUserMFAPreference({ Enabled: true, PreferredMfa: false })`.
Enrollment is then read from `UserMFASettingList`, so **login MFA state is
financial authorization enrollment**. That coupling is the bug.

## Can the existing TOTP secret be reused?

**No, not safely as app-level material.**

- `AssociateSoftwareToken` returns `SecretCode` **once**. Cognito does not
  export it later (`AdminGetUser` has no software-token secret).
- `SetUserMFAPreference` with `Enabled: false` **does not delete** the
  associated token (AWS: this operation does not reset existing TOTP).
- Ongoing Cognito TOTP **sign-in** uses `RespondToAuthChallenge` /
  `SOFTWARE_TOKEN_MFA`, which requires the factor to be **enabled as login MFA**.
- `VerifySoftwareToken` is the **enrollment** API, not a financial challenge
  API. Reusing it after disable is unproven and still Cognito-lifecycle coupled
  (`AssociateSoftwareToken` overwrites the token).
- Requirement: login MFA state must not determine financial authorization.

A temporary Cognito-verifier bridge after `Enabled: false` is **not** the
architecture. Do not use it on this production user.

The user will need a **new** `ChecksOps Financial` authenticator entry after
EMAIL_OTP login is restored. The existing `ChecksOps` Cognito entry can stay
until they delete it; it must not be re-enabled as login MFA.

## Recommended architecture

**LOGIN:** Cognito `USER_AUTH` EMAIL_OTP / WEB_AUTHN. Pool MFA stays OPTIONAL.
Do not enable `SOFTWARE_TOKEN_MFA` for login. Do not implement password+TOTP
login.

**FINANCIAL STEP-UP:** application TOTP in RDS, encrypted at rest with AES-256-GCM
and a wrap key in Secrets Manager (same secret store as the DB password; do not
put the wrap key in Lambda env). Verification server-side only. Successful
step-up inserts `financial_stepup_log` bound to:

- `application_user_id`
- `tenant_id` from the check (browser tenant ignored)
- `action_key`
- `metadata.check_id`
- `metadata.amount_cents` (server-derived)
- `created_at` TTL already 30 minutes in `checkalt-authz.mjs`

Replay: store `last_used_timestep` and reject reuse in the ±1 window.
Rate limit: `consume_financial_totp_rate_limit` (5 / 5 minutes for `step_up`).
Enrollment status: `financial_totp_enrollments.verified_at`, **never**
`UserMFASettingList`.

Issuer label: `ChecksOps Financial` so it is distinct from the Cognito login
token during the cutover.

## New storage

Proposed, **not applied:**
`aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql`

- `financial_totp_enrollments` (ciphertext, nonce, key_id, last_used_timestep)
- `financial_totp_rate_limits`
- SECURITY DEFINER functions; **no table GRANT** to `checksops` or
  `authenticated`; not on `allowed-tables.json` / write allowlist

Wrap key (operator, later): Secrets Manager
`checksops/production/financial-totp-wrap-key` (64 hex chars). Do not create it
in this PR.

## Recovery sequence for mcarletta@freedomadj.com

Do **not** start step 3 until 1–2 are reviewed and deployed.

1. Apply proposed SQL + wrap key; deploy Lambda that enrolls/verifies **app**
   TOTP and **stops** calling `SetUserMFAPreference({ Enabled: true })` on new
   enrollments. Keep EMAIL_OTP select from M6.3G.
2. Prove verification with unit tests and a **non-production** tester (RFC 6238
   + encrypt/replay/rate-limit). This production user cannot enroll until they
   can log in.
3. Disable login MFA only: `AdminSetUserMFAPreference`
   `SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false }`.
   Do **not** `AdminDeleteSoftwareToken` unless the token must be destroyed.
   Do not change password. Existing helper: `admin-reset-totp.mjs` (also
   global sign-out). Use it only after review.
4. `InitiateAuth` `USER_AUTH` preferred EMAIL_OTP must list `EMAIL_OTP` in
   `AvailableChallenges` (or issue EMAIL_OTP directly).
5. User completes email-code login. Do not consume extra codes during probes.
6. User scans a **new** `ChecksOps Financial` QR and confirms. Then
   `POST /auth/mfa/step-up` must succeed against the **app** secret and write
   `financial_stepup_log`. Cognito `UserMFASettingList` must remain without
   `SOFTWARE_TOKEN_MFA`.

Window after step 3 and before step 6: financial TOTP is unavailable. Money
flags stay false, so no live money movement.

## Rollback

- Leave Cognito user unchanged if this PR is not deployed.
- If SQL is applied: keep table; do not delete ciphertext; stop serving enroll
  routes.
- If login MFA was disabled and EMAIL_OTP still fails: **do not** re-enable
  `SOFTWARE_TOKEN_MFA` without a new review (that recreates this outage).
- Do not re-enable preferred MFA.

## Holds

User MFA last modified `2026-09-10T18:56:10.659Z` must stay until step 3 is
explicitly approved. Money flags remain false.
