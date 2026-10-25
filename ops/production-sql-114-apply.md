# Production SQL 114 (the stakeholder accounts settings update grant)

| key | file | what it does |
|---|---|---|
| `sql114` | `aws/workflows/sql/114_stakeholder_accounts_settings_update_grant.sql` (sha256 `484a6c17d8dd8d25108a7de15c2181d20fca645838f37b5cfe3081cfa986d811`) | `GRANT UPDATE (is_active, is_primary, account_type, homeowner_name, homeowner_email, updated_at) ON TABLE public.stakeholder_accounts`, to `checksops` and to `authenticated`, each only when the role exists (the table or a column that is absent is skipped with a NOTICE). Nothing else: no table-wide UPDATE, no other column, no INSERT or DELETE, no PUBLIC or anon grant, no RLS or policy change. |

**Why.** Settings > Stakeholder Accounts
(`src/components/disbursement/StakeholderAccountSettings.tsx`) removes a non-payee stakeholder
with `UPDATE stakeholder_accounts SET is_active = false, is_primary = false`, and changes a
stakeholder's type (for example homeowner to contractor) with `SET account_type = ...`, clearing
`homeowner_name` and `homeowner_email` when it stops being a homeowner. On AWS those writes need a
`/data/write` route (a later code PR; this migration adds none) and an UPDATE privilege for
`checksops` on those columns. No migration in this repository grants one: the restored database
gave `checksops` SELECT only (`aws/db-copy/sql/02_grant_readonly_application_role.sql`).
PostgreSQL checks table and column privileges before row-level security, so without it the UPDATE
is refused before any policy is evaluated. The policy `aws_write_stakeholder_accounts`
(`aws/rls/sql/24_complete_write_policies.sql`: `FOR ALL TO authenticated`, `USING` / `WITH CHECK
aws_can_write_tenant(tenant_id)`) stays the authorization boundary; the grant is column-scoped like
`aws/write-path/sql/35_tranche3_write_grants.sql` and SQL 92.

**Expected outcomes of the inspect.** `already_applied` false with `precondition_failures` `[]`
(no column grant on the six columns yet: the guarded apply path below adds them), or
`already_applied` true (both lines held on all six columns: nothing to apply; the inspect is
recorded as the verified-live evidence and the pin stays `execute: false`). Anything else (a
precondition failure, such as another role's grant on one of the columns, a missing table, column
or role) stops and needs its own reviewed change.

**Staging executor refreshed (2026-10-25).** Inspect run 40152370153 (main `cfc0829e5`) found the
live executor at CodeSha256 `nloTNyc3…` without SQL 114 (adds only
`sql/114_stakeholder_accounts_settings_update_grant.sql`, supersedes the three engine files,
nothing dropped, no collisions). Deploy run 40152534378 updated it to main's package (`VMyMjKW1…`).

**Staging read-live (2026-10-25).** Run 40152706123 (main `cfc0829e5`): no column grant on
`is_active`, `is_primary`, `account_type`, `homeowner_name`, `homeowner_email` or `updated_at`
(each `acl: []`); live `8b5d1d4d49188412317a60036a392c27727852b246a1d59a9c2807cb17186e00`, `already_applied` false,
`precondition_failures` `[]`. Recorded in the staging pin (`expected_live_definition_sha256`,
`execute: true`, wave 15) under the owner's words of 2026-10-25, "approve SQL 114 staging apply".

**Status:** staging pin execute-authorized (wave 15); nothing applied yet; production pin pending.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`column_acl` in `release-sql-specs.mjs`, as SQL 92): the column ACL (`pg_attribute.attacl`, every
grantee) of `is_active`, `is_primary`, `account_type`, `homeowner_name`, `homeowner_email` and
`updated_at`, or `absent` per column. Intended
`809eba9b7f5d40b984f4f37562dfe5419ec2de50de103fc2699048eea5bf6c46`:

```
release sql114 v1
column public.stakeholder_accounts.is_active acl: authenticated UPDATE;checksops UPDATE
column public.stakeholder_accounts.is_primary acl: authenticated UPDATE;checksops UPDATE
column public.stakeholder_accounts.account_type acl: authenticated UPDATE;checksops UPDATE
column public.stakeholder_accounts.homeowner_name acl: authenticated UPDATE;checksops UPDATE
column public.stakeholder_accounts.homeowner_email acl: authenticated UPDATE;checksops UPDATE
column public.stakeholder_accounts.updated_at acl: authenticated UPDATE;checksops UPDATE
```

Table-level grants (`relacl`: the table-level SELECT of `checksops` and `authenticated`, the
owner's) are outside the fingerprint; the unrelated-catalog snapshot requires them, every other
column of the table, its RLS flags and its policies unchanged.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the table, its six columns, roles `checksops` and `authenticated`);
`altered_relations_owned_by_login` (the login owns the table, so its GRANTs take effect);
`column_acl_replaceable` (every live grant on the six columns is one of the two pinned lines:
another role's grant there would survive the file and is refused). No predecessor. A column that
already holds one or both lines passes: the file only adds the missing ones; all held is
`already_applied` true.

Post-conditions: the intended fingerprint; everything else in schema `public` (and the functions
of `auth`) unchanged, the six columns' ACLs excepted. The tools roll back otherwise.

## Order

No predecessor and no order. The `/data/write` route that uses the grant is a later, separate
code change; the grant alone changes no behaviour. No later migration revokes these grants.

## Steps

1. Staging: the staging executor must carry SQL 114 first (executor package refresh through
   `sql-executor-ensure.mjs` / the guarded staging executor `deploy` mode, its own reviewed run).
   Then run the guarded staging SQL executor with `read-live` for
   `sql114-stakeholder-settings-update-grant`. If it reports `already_applied` true, record the
   run as the staging evidence (nothing to apply). If it reports `already_applied` false and
   `precondition_failures` `[]`, record `LIVE_DEFINITION_SHA256` in the staging pin
   (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in a
   reviewed change, `apply` with the owner's approval of that run, then `read-live` again
   (expected `already_applied` true). Anything else: stop and record it in its own reviewed
   change.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/sql114-stakeholder-settings-update-grant-production-apply.mjs --inspect`,
   or the one-shot's `--phase inspect`); record `production_inspect`. If `already_applied` is
   true, the reviewed change records it as verified live and leaves `execute: false`. Otherwise
   copy `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs
   in `staging_acceptance`, and set an owner-approved `authorization` and `execute: true`, in one
   reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql114 --approval-scope sql114 … --phase inspect`, then the owner-named
   `--phase apply`.
4. Record the apply and retire the pin (`execute: false`).
