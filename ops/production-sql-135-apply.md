# Production SQL 135 (the check create INSERT grant)

| key | file | what it does |
|---|---|---|
| `sql135` | `aws/workflows/sql/135_check_create_insert_grant.sql` (sha256 `a71a5f7f9da8c5784d517ebe198a91c3bbf8591a5f4824705c075317a47967e8`) | Fail-closed preconditions (`sql135_table_missing`, `sql135_column_missing`, `sql135_role_missing`), then `GRANT INSERT (id, tenant_id, uploaded_by, status, check_stage, ocr_status, front_image_path, back_image_path, ocr_needs_verification, carrier_name, check_number, payee_line, property_address, funds_type, review_notes, payee_address, expiration_days, is_multi_payee, issue_date, amount, claim_id, cash_job_id, check_source, cash_job_payment_class) ON TABLE public.check_intake_items TO checksops` and `REVOKE INSERT (the same columns) ON TABLE public.check_intake_items FROM authenticated`. No other statement: no table-wide INSERT, no other column, no UPDATE, DELETE, SELECT, sequence or function grant, no PUBLIC or anon grant, no RLS or policy change. |

**Why.** Staging "Upload & Analyze" on the Check Command Center fails. The staging API log
(`/aws/lambda/checksops-staging-api`, 2026-10-31 13:06:40Z and 13:15:40Z) shows
`POST /staging/workflow/checks` answered 403 with the PostgreSQL error
`permission denied for table check_intake_items`. That route is `handleCreateCheck`
(`aws/functions/api/workflow.mjs`), which runs, as `checksops`:

```
INSERT INTO public.check_intake_items (
  id, tenant_id, uploaded_by, status, check_stage, ocr_status,
  front_image_path, back_image_path, ocr_needs_verification,
  carrier_name, check_number, payee_line, property_address,
  funds_type, review_notes, payee_address, expiration_days,
  is_multi_payee, issue_date, amount, claim_id
  [, cash_job_id, check_source, cash_job_payment_class]   -- a cash-job check only
) VALUES (...) RETURNING *
```

`claim_id` has been named on every create since the cash-jobs change (#1317, 2026-10-27); the three
cash-job columns only when the check is uploaded from a cash job. SQL 50
(`aws/workflows/sql/50_tranche5_write_grants.sql`) granted column INSERT on the first twenty columns
to `checksops` and `authenticated` (not `claim_id`: the create then left it null); SQL 51
(`51_tranche5_revoke_write_grants.sql`) revokes INSERT on the table from both where it is run (a
table-level REVOKE also removes their column INSERT). No later migration grants INSERT on
`check_intake_items`. PostgreSQL checks table and column privileges before row-level security, so
the create is refused (42501) before any policy is evaluated. `RETURNING *` reads with the table
SELECT `checksops` already holds; SQL 135 does not grant SELECT.

Production differs: its SQL 89 inspect (2026-10-16, SSM `0435c387-8f9b-405d-9463-f1cc81124d36`)
recorded the table ACL `checksops=arwd/checksops_admin`, `ard` after SQL 89, so `checksops` holds
table-level INSERT there and the create is not refused. SQL 135 does not change the table ACL; it
makes the twenty-four columns' ACL the same in both environments.

**Roles.** `checksops` only receives the grant: the API connects as `checksops`. `authenticated`
(whose only member is `checksops`) loses INSERT on the same twenty-four columns: SQL 50's lines,
where SQL 51 was never run, would otherwise leave staging and production in different states (as
SQL 100 revoked SQL 50's `authenticated` UPDATE on `mortgage_handling_requests`). The policies below
are `TO authenticated` and apply to `checksops` as a member.

**Policies (not changed).** `aws_write_check_intake_items` (`aws/rls/sql/21_proposed_write_policies.sql`:
`FOR ALL TO authenticated`, `USING` / `WITH CHECK` `aws_can_write_tenant(tenant_id)`) and
`aws_select_check_intake_items` (for `RETURNING *`) stay the authorization boundary.
`aws_can_write_tenant` needs a `tenant_users` member of the tenant who also holds `user_roles`
admin or staff (or a platform owner); a member without one is refused by row-level security after
SQL 135, as before.

**Other inserts into `check_intake_items`.** `aws/functions/api/homeowner.mjs` (the homeowner upload
review and attach paths) inserts `claim_id, tenant_id, uploaded_by, front_image_path,
back_image_path, amount, status, check_stage, check_source`, a subset of the twenty-four, so SQL 135
covers them at the grant layer too.

**Expected outcomes of the inspect.** `already_applied` false with `precondition_failures` `[]`, or
`already_applied` true (every pinned line held and no `authenticated` INSERT: nothing to apply; the
inspect is recorded as the verified-live evidence and the pin stays `execute: false`). Anything else
(a precondition failure, such as another role's grant on one of the columns, a missing table,
column or role) stops and needs its own reviewed change.

**Staging executor refreshed (2026-10-31).** Inspect run 41213856434 (main `c92da0bc5`) found the live
executor at `PPZJFH/UBvNACkdfIyCBNG4T9g0z69dc/WnNkJC+nRg=` (LastModified 2026-10-30T21:45:43Z,
`executor_current` false) without `sql/135_check_create_insert_grant.sql` (main's package also
superseded `lib/release-sql-specs.mjs`, `lib/release-sql-state.mjs` and `lib/sql-executor-auth.mjs`;
`collisions` `[]`, `dropped` `[]`). Deploy run 41214086396 (main
`c92da0bc53232379053ca93f8ea0bb753f9fde04`, `expected_executor_code_sha256` `PPZJFH/…` matched) updated
`checksops-staging-guarded-sql-executor` to main's package
(`5FlB5t/EKAjx8OGEoia4nooAyExOnXewmXXG5+8OsIo=`, RevisionId `c895b177-f301-4d09-8f26-7988928ef0ce`,
LastModified 2026-10-31T15:19:21Z).

**Staging read-live (2026-10-31).** Run 41214330222 (main `c92da0bc5`, executor `5FlB5t…`,
`executor_current` true, pin commit `71cda1678`): the twenty columns `id` through `amount` each hold
`authenticated INSERT` and `checksops INSERT` (SQL 50's lines), the seventeen SQL 89 covers also
`checksops UPDATE` (`id`, `tenant_id` and `uploaded_by` have no UPDATE); `claim_id`, `cash_job_id`,
`check_source` and `cash_job_payment_class` have no column grant (acl `[]`), the cause of the staging
403 on `/workflow/checks`. SQL 51 was never run in staging. Live
`4dac49398757060deee5d636f193059e30cbe1ffdb33890122f79f026d144f33` (the staging pre-state derived
below, SQL 50's lines plus SQL 89's), intended `946e84be…`, `already_applied` false,
`precondition_failures` `[]`, `prerequisites_missing` `[]`, `predecessors` `{}`, `mutation` false.
Recorded in the staging pin (`expected_live_definition_sha256`, `execute: true`, wave 31) under the
owner's words of 2026-10-31, "the SQL 135 staging pin", then "apply SQL 135 in staging". The staging
apply itself is a separate run after this pin is merged.

**Status:** staging pin execute-authorized (wave 31); nothing applied yet; production pin pending.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`column_acl` in `release-sql-specs.mjs`, as SQL 92, SQL 114 and SQL 134; `revokes` as SQL 100): the
column ACL (`pg_attribute.attacl`, every grantee) of the twenty-four columns, or `absent` per
column. Seventeen of them keep SQL 89's `checksops UPDATE`, which the file does not touch. Intended
`946e84beb5a459f55bdc1fb90d839dcfeb292901573e3e5fb6ceb24a65213a6d`:

```
release sql135 v1
column public.check_intake_items.id acl: checksops INSERT
column public.check_intake_items.tenant_id acl: checksops INSERT
column public.check_intake_items.uploaded_by acl: checksops INSERT
column public.check_intake_items.status acl: checksops INSERT;checksops UPDATE
column public.check_intake_items.check_stage acl: checksops INSERT;checksops UPDATE
column public.check_intake_items.ocr_status acl: checksops INSERT;checksops UPDATE
column public.check_intake_items.front_image_path acl: checksops INSERT;checksops UPDATE
column public.check_intake_items.back_image_path acl: checksops INSERT;checksops UPDATE
column public.check_intake_items.ocr_needs_verification acl: checksops INSERT;checksops UPDATE
column public.check_intake_items.carrier_name acl: checksops INSERT;checksops UPDATE
column public.check_intake_items.check_number acl: checksops INSERT;checksops UPDATE
column public.check_intake_items.payee_line acl: checksops INSERT;checksops UPDATE
column public.check_intake_items.property_address acl: checksops INSERT;checksops UPDATE
column public.check_intake_items.funds_type acl: checksops INSERT;checksops UPDATE
column public.check_intake_items.review_notes acl: checksops INSERT;checksops UPDATE
column public.check_intake_items.payee_address acl: checksops INSERT;checksops UPDATE
column public.check_intake_items.expiration_days acl: checksops INSERT;checksops UPDATE
column public.check_intake_items.is_multi_payee acl: checksops INSERT;checksops UPDATE
column public.check_intake_items.issue_date acl: checksops INSERT;checksops UPDATE
column public.check_intake_items.amount acl: checksops INSERT;checksops UPDATE
column public.check_intake_items.claim_id acl: checksops INSERT
column public.check_intake_items.cash_job_id acl: checksops INSERT
column public.check_intake_items.check_source acl: checksops INSERT
column public.check_intake_items.cash_job_payment_class acl: checksops INSERT
```

**Expected pre-states (not recorded anywhere yet; each pin records its own environment's read).**
Derived by `aws/tests/release-sql135-executor.test.mjs` and read back from a PostgreSQL 16 database
with the table as the repository's grants leave it:

- SQL 89's `checksops UPDATE` on the seventeen columns and no other column grant on the
  twenty-four (production's expected state; `checksops` INSERT is table-level there):
  `5e147e3929d9f3ae9a8edbf9e3a1b1b896993a9b9ff88cb7d093b2e7273305e4`.
- The same plus SQL 50's `authenticated INSERT` and `checksops INSERT` on its twenty columns
  (staging if SQL 51 was never run there):
  `4dac49398757060deee5d636f193059e30cbe1ffdb33890122f79f026d144f33`.

Neither value is written into a pin before a run reads it. Table-level grants (`relacl`) and every
other column's grants are outside the fingerprint; the unrelated-catalog snapshot requires them,
the table's RLS flag and its policies unchanged.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the table, the twenty-four columns, roles `checksops` and `authenticated`);
`altered_relations_owned_by_login` (the login owns the table, so its GRANT and REVOKE take effect);
`column_acl_replaceable` (every live grant on the twenty-four columns is a pinned line or
`authenticated INSERT`, which the file revokes: another role's grant there would survive the file
and is refused). No predecessor. A column that already holds its lines passes: the file only adds
the missing ones; all held and no `authenticated INSERT` is `already_applied` true. A column that
lacks SQL 89's `checksops UPDATE` passes the pre-conditions but leaves another post-state: the
post-condition then fails and the tools roll back.

Post-conditions: the intended fingerprint; everything else in schema `public` (and the functions
of `auth`) unchanged, the twenty-four columns' ACLs excepted. The tools roll back otherwise.

## Order

No predecessor and no order. The API already sends the statement; once SQL 135 is applied in an
environment the create passes the grant layer there and row-level security decides. No Lambda or
SPA change goes with it. No later migration revokes these grants. After the staging apply, retry
Upload & Analyze on staging and read the staging API log: the create also writes
`check_audit_log` (SQL 33's INSERT grant) and fires the table's INSERT triggers as `checksops`,
which this file does not cover.

## Steps

1. Staging: the staging executor must carry SQL 135 first (executor package refresh through
   `sql-executor-ensure.mjs` / the guarded staging executor `deploy` mode, its own reviewed run).
   Then run the guarded staging SQL executor with `read-live` for
   `sql135-check-create-insert-grant`. Expected: `already_applied` false,
   `precondition_failures` `[]`, `live_definition_sha256` one of the two pre-states above. Read its
   `release_sql_inspect.columns` either way. If it reports `already_applied` true, record the run
   as the staging evidence (nothing to apply). If it reports `prerequisites_missing` other than `[]`
   or `precondition_failures` other than `[]`, stop. Otherwise record `LIVE_DEFINITION_SHA256` in
   the staging pin (`expected_live_definition_sha256`, owner-approved `authorization`,
   `execute: true`) in a reviewed change, `apply` with the owner's approval of that run, then
   `read-live` again (expected `already_applied` true).
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql135 … --phase inspect`,
   or the tool's `--inspect`); record `production_inspect`. If `already_applied` is true, the
   reviewed change records it as verified live and leaves `execute: false`. Otherwise copy
   `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs in
   `staging_acceptance`, and set an owner-approved `authorization` and `execute: true`, in one
   reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql135 --approval-scope sql135 … --phase inspect`, then the owner-named
   `--phase apply` with the owner's words (authorization phrase
   `APPLY_CHECK_CREATE_INSERT_GRANT`).
4. Record the apply and retire the pin (`execute: false`).
