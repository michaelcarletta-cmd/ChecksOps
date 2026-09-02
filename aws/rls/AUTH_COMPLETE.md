# AWS staging authorization completion (RLS still off)

This phase:

1. Backfills `claims.org_id` for **83** Freedom claims only.
2. Prepares the remaining **108** tenant-scoped write policies plus **7** platform-owner write policies.
3. Retargets **47** former `auth.users` FKs to `identity_accounts(application_user_id)` if there are no orphans.
4. Keeps **97** NULL-org claims fail-closed for tenant users (master/platform owner may read).
5. Runs rollback-only SELECT+write tests.

Does **not** enable global RLS, invite users, create Cognito for the ninth UUID, or call Moov/CheckAlt/Plaid/Resend.

Identity path unchanged. **165** `aws_select_*` policies unchanged. Expected write policies: **127** (`12` representative + `108` remaining + `7` owner-only). **13** server-side tables and **2** obsolete tables have no write policy.

SQL: `23_claims_org_backfill.sql`, `24_complete_write_policies.sql`, `25_fk_retarget.sql`.
NULL-org SELECT: `aws_can_access_claim` requires `org_id IS NOT NULL` unless `aws_is_cross_tenant_reader()`.
