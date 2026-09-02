# AWS staging authorization completion (RLS still off)

This phase:

1. Backfills `claims.org_id` for **83** Freedom claims only.
2. Prepares the remaining **108** tenant-scoped write policies plus **7** platform-owner write policies.
3. Retargets **47** former `auth.users` FKs to `identity_accounts(application_user_id)` if there are no orphans.
4. Keeps **97** NULL-org claims fail-closed for tenant users (master/platform owner may read).
5. Runs rollback-only SELECT+write tests.

Live oneshot: `ok: true`. Global RLS still off. Details: `aws/rls/AUTH_COMPLETE_RESULTS.md`.
