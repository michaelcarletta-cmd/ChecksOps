# Staging controlled Cognito onboarding

This phase creates Cognito identities for the **8 known restored users** and maps each new `sub` onto the existing ChecksOps UUID in `identity_accounts`.

It does **not**:

- invite users by email (`AdminCreateUser` `MessageAction=SUPPRESS`)
- import Supabase password hashes
- rewrite `profiles.id`, `tenant_users.user_id`, `user_roles.user_id`, or audit UUIDs
- create Cognito or email for ninth UUID `dd24eea5-5d12-47d1-999e-d5930c278b7d`
- change RLS policies (`165` select / `127` write remain)
- enable application writes or call providers

Identity remains:

`Cognito sub -> identity_accounts.application_user_id -> existing ChecksOps UUID -> request.app_user_id -> auth.uid()`

## Order

1. Reconcile live `profiles` / `tenant_users` / `user_roles` / `identity_accounts`. Abort any user with a missing or duplicate email.
2. Clear the `isolated_test` probe mapping on Tester. Do not delete the application UUID.
3. Create 8 Cognito users with invitation emails suppressed. Capture each `sub`.
4. `UPDATE identity_accounts` pending rows to `active` with that `sub`. `cognito_sub` stays unique and never equals `application_user_id`.
5. Validate `/identity/me` and `/authorization/isolation` with `ADMIN_USER_PASSWORD_AUTH` (no email).
6. Return users to `FORCE_CHANGE_PASSWORD` without sending reset email.
7. Confirm ninth UUID still pending, no Cognito, no tenant membership, RLS fail-closed.

## STOP

Do not send invitation or password-reset emails. Do not enable normal writes. Next phase is controlled login/password activation.
