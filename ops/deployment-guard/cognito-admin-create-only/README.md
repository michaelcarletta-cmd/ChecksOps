# Cognito pools: self sign-up off (AllowAdminCreateUserOnly)

Security audit follow-up (2026-10-29: "set `AllowAdminCreateUserOnly: true` on the production pool").
Owner decision of 2026-10-30: "Work on production sign off".

| File | What it is |
|---|---|
| `staging-pool.live-2026-10-30.json` | `DescribeUserPool` (less user count and dates) and `GetUserPoolMfaConfig` of `us-east-1_vPmQ7cL1F`, read 2026-10-30 |
| `production-pool.live-2026-10-30.json` | the same for `us-east-1_h00WorYMT` |
| `scripts/deployment-guard/lib/cognito-admin-create-only.mjs` | builds the `UpdateUserPool` request from a live `DescribeUserPool` |

Test: `aws/tests/cognito-admin-create-only.test.mjs`.

## Why

Both pools have `AdminCreateUserConfig.AllowAdminCreateUserOnly: false`: anyone who has the public
app client id can call Cognito `SignUp` and create an account (it then has no ChecksOps tenant, but
it is a login in the pool). ChecksOps never creates accounts that way: invites use `AdminCreateUser`
(`tenant-admin.mjs`), the passwordless route only signs in existing users (`auth-cognito.mjs`), and
the SPA's `signUp` is a stub that refuses on AWS (`src/integrations/aws/client.ts`).

## Read-only inspect (2026-10-30, `user/claude-code`)

- CloudTrail, last 90 days: 0 `SignUp` calls on any pool.
- Production pool: 13 users, one app client (`checksops-production-web`), no Lambda triggers,
  deletion protection on, MFA `OPTIONAL` (TOTP and passkeys, relying party `checksops.com`),
  first factors `EMAIL_OTP`, `PASSWORD`, `WEB_AUTHN`. Not managed by CloudFormation: the stack that
  created it (`checksops-production-prep`, stack id `446083d0-…`) was deleted 2026-09-05 with the
  pool retained (`DELETE_SKIPPED`); today's `checksops-production-prep` stack defines only the client.
- Staging pool: the same settings except MFA `OFF`.

## What changes

- `SignUp` against either pool is refused (`NotAuthorizedException`).
- Invites (`AdminCreateUser`), sign-in (email code, passkey), MFA and recovery: unchanged.

## Apply (staging first; each pool only on the owner's approval of its run)

`UpdateUserPool` resets every setting it is not given to its default, so the request is built from
the pool as it is at apply time, never typed by hand:

1. `DescribeUserPool` and `GetUserPoolMfaConfig`; stop if any setting other than the user count
   and dates differs from the snapshot in this folder.
2. `request = buildAdminCreateOnlyUpdate(UserPool)`; `UpdateUserPool(**request)`.

Order: staging `us-east-1_vPmQ7cL1F` first, verify; then production `us-east-1_h00WorYMT`.

## Verify after apply

1. `DescribeUserPool` equals the snapshot except `AdminCreateUserConfig.AllowAdminCreateUserOnly`
   (now `true`; `UnusedAccountValidityDays` may disappear, superseded by
   `PasswordPolicy.TemporaryPasswordValidityDays: 7`) and `LastModifiedDate`.
2. `GetUserPoolMfaConfig` (get_user_pool_mfa_config) equals the snapshot (TOTP, passkeys, MFA mode).
3. Staging: an invite (`AdminCreateUser`) still works.

## Rollback

The same request with `AllowAdminCreateUserOnly: false`, built from the live pool.
