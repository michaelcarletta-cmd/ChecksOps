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
3. Tags equal the snapshot. The request sends no tags; if a user tag (not `aws:*`) is missing,
   restore it with `TagResource` on the pool ARN.
4. A `SignUp` with a made-up `@example.invalid` email on the pool's app client is refused with
   `NotAuthorizedException: SignUp is not permitted for this user pool`. If it is accepted, delete
   that user at once (`AdminDeleteUser`) and stop: the setting is not enforced.
5. Staging: an invite (`AdminCreateUser`) still works.

## 2026-10-30 runs

- Staging (owner: "apply sign-up off to staging"): precondition equal; `UpdateUserPool` HTTP 200
  (request `52a47e82-c283-40f4-a025-d0ea50dde684`); only `AllowAdminCreateUserOnly` changed; MFA
  config unchanged; `SignUp` refused ("SignUp is not permitted for this user pool").
- Production (owner: "apply sign-up off to production"): precondition equal; the request then
  carried the pool's user tags, and `UpdateUserPool` answered `InvalidParameterException: Caller
  is an end user and not allowed to mutate system tags` (the pool carries `aws:cloudformation:*`
  tags). The pool nonetheless reads `AllowAdminCreateUserOnly: true` (LastModifiedDate
  2026-10-30T01:35:58Z) with every other setting, the MFA config and all tags unchanged, but a
  verification `SignUp` was accepted (user `34c8e4f8-c021-7023-9140-1558af378da2`, deleted at once;
  13 users remain): recorded, not enforced. The builder no longer sends tags. The production
  re-apply runs the same steps; its precondition is the snapshot with
  `AllowAdminCreateUserOnly: true`, the state the refused call left.

## Rollback

The same request with `AllowAdminCreateUserOnly: false`, built from the live pool.

## Applied (2026-10-30)

Identity: `arn:aws:iam::806168576068:user/claude-code`. Requests built from the live pool by
`buildAdminCreateOnlyUpdate`.

- **Staging** `us-east-1_vPmQ7cL1F`. Owner: "apply sign-up off to staging". Builder at `fa41e4d`
  (PR #1417); the staging pool has no tags. Precondition equal to the snapshot; `UpdateUserPool`
  HTTP 200, request `52a47e82-c283-40f4-a025-d0ea50dde684`, LastModifiedDate
  2026-10-30T01:32:56Z. After: only `AllowAdminCreateUserOnly` differs (true); MFA config
  unchanged; `SignUp` refused (`NotAuthorizedException: SignUp is not permitted for this user pool`).
- **Production** `us-east-1_h00WorYMT`. Owner: "apply sign-up off to production", then "re-apply
  sign-up off to production" after the first run below. Re-apply with the builder at `5f91964`
  (PR #1419, no `UserPoolTags`). Precondition: the snapshot with
  `AllowAdminCreateUserOnly: true` (the state the first run left), 13 users. `UpdateUserPool` HTTP
  200, request `fa434eae-815d-434f-8d74-2ef70848afb3`, LastModifiedDate 2026-10-30T01:54:24Z.
  After: only `AllowAdminCreateUserOnly` differs (true); tags and MFA config unchanged; `SignUp`
  refused (`NotAuthorizedException: SignUp is not permitted for this user pool`); 13 users, no
  test user left.

Not verified: an invite (`AdminCreateUser`) after the change; the flag does not restrict it.
