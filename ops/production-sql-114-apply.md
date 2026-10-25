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

**Staging apply (2026-10-25).** After the staging pin change (#1233, main `952ecf7a6`), inspect run
40153686657 found the executor superseding only `lib/sql-executor-auth.mjs`; deploy run 40153846012
refreshed it (`r6G9KanI…`). Apply run 40154043207: result `applied`, before `8b5d1d4d49188412317a60036a392c27727852b246a1d59a9c2807cb17186e00`,
after `809eba9b7f5d40b984f4f37562dfe5419ec2de50de103fc2699048eea5bf6c46` (intended). Read-live run
40154234967: `already_applied` true, each of the six columns `authenticated UPDATE` and
`checksops UPDATE`.

**Production inspect (2026-10-25).** Read-only `--inspect` through SSM
`f4d57070-7215-4c70-93d0-43a03d3bc68a` on `i-0c35557c4e5385406`, main `952ecf7a6` (tarball sha256
`8af03c02dcca2deb97636f81807df65ffbb54b393b90361ebe5881dd1e2d91d6`, transfer run 40184052967, migration
source `484a6c17…` == pin), connected as `checksops_admin`: no column grant on the six columns; live
`8b5d1d4d49188412317a60036a392c27727852b246a1d59a9c2807cb17186e00` (the staging pre-state), `already_applied` false,
`precondition_failures` `[]`. Recorded in the production pin with the staging apply as its staging
acceptance and `execute: true` under the owner's words of 2026-10-25, "approve SQL 114 production
apply". Each apply still needs the owner's run-time approval.

**Status:** applied to staging and to production (2026-10-25); the production pin is retired
(`execute: false` again; see "Production apply of SQL 114").

## Production apply of SQL 114 (2026-10-25)

The owner's message of 2026-10-25 was "merge 1234 when green and approve SQL 114 production
apply"; its statement "approve SQL 114 production apply" was passed verbatim (base64,
`--approval-statement-b64`) and recorded by the one-shot as `approval_statement`. The one-shot
cannot verify who said it, and the statement covered this run only. `production-sql-one-shot.mjs
--migration sql114 --approval-scope sql114` on `i-0c35557c4e5385406` (operator-supplied
`--runner`, not verified by the one-shot), operator `michaelcarletta-cmd`, workstream
`prod-sql114-stakeholder-settings-20261025`, from main `9fa66403c` (tarball
`source-9fa66403c6d4d358693ab8155a16393142177e7f.tar.gz`, sha256 `be81479a…`, 12711 files, transfer
run `40185445236`, `sql53-temporary-transfer.yml` on main after the #1234 merge; it printed
`TARBALL_SHA256 be81479a99c7bd1d42d6df16d701675a47413bdd22ce9154bad4a98ca887b240`).

- **Inspect phase:** SSM `47fee3cf-be4e-4336-b85a-6f5a41b2220d` (exit 0), run_id
  `b122c1a3-4a1f-4b0c-ba03-256d076f719d`: pin (execute true, staging acceptance run 40154043207),
  source, inspect and contracts ok (claim-ledger 4/4, tenant-isolation 6/6,
  financial-write-protections 43/43), read-only; live `8b5d1d4d…` (live_matches_expected true),
  already_applied false, precondition_failures [], apply_preconditions_met true, connected as
  `checksops_admin`.
- **Apply phase:** SSM `f32cfcbd-c69e-46a7-958c-0cf3d1510d91` (2026-10-25T10:39:21Z to 10:39:38Z,
  exit 0), run_id `65090c03-0403-4a95-92e4-3687e7f173b5`, one_use_id
  `sql114-prod-a664d4c7-f0ce-4876-9b88-39b11c6a9701` (spent): every step ok (pin, source, inspect,
  contracts, manifest, source-recheck-before-preflight, preflight (receipt issued), evaluate
  (`sql114_production_apply_allowed` true), source-recheck-before-apply, apply (applied),
  post-apply-inspect); migration source `484a6c17…` (== pin); pre-apply inspect live `8b5d1d4d…`,
  live_matches_expected true, precondition_failures [], each of the six columns `different`
  (`acl: []`); contracts claim-ledger 4/4, tenant-isolation 6/6, financial-write-protections 43/43;
  manifest `96416d48…`; receipt `8b5d1d4d…` -> `809eba9b…`, result applied, unrelated catalog
  `7089cbcd…` (relations 890, columns 3536, constraints 2234, policies 404, functions 1326, indexes
  654, triggers 180, views 25, types 18, roles 29, role memberships 15); post-apply inspect live
  `809eba9b…` (= intended), already_applied true, precondition_failures [], missing_dependencies
  []. Each of `is_active`, `is_primary`, `account_type`, `homeowner_name`, `homeowner_email` and
  `updated_at` is `intended` with exactly `authenticated UPDATE` and `checksops UPDATE`.
- **Not captured:** the SSM output was cut at 24000 characters, so the one-shot's summary after
  `post_apply_inspect` (its trailing `not_observed_by_this_run` list beyond the first entry) was
  not captured in full. A read-only listing of the runner's source directory after the apply (SSM
  `c4b8df91-7877-4c09-bdb9-4a0851cf6966`) showed the receipt, the lease, the consumed receipt and
  `sql114-stakeholder-settings-update-grant-production-consumed.json` (66 bytes); the consumed
  entry itself was not read back.

No later read-only inspect is recorded. The pin is `execute: false` again; a re-apply needs a new
reviewed pin change.

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
