# Production SQL 142 (tenant admins may add and edit the shared mortgage company directory)

| key | file | what it does |
|---|---|---|
| `sql142` | `aws/workflows/sql/142_mortgage_companies_tenant_admin_write.sql` (sha256 `f140e75d67cdb67efa4c4ab21aa5d6bb04fb924a0b010c4496b48ab9fc4b156b`) | Refuses unless `public.mortgage_companies` is an ordinary table with ROW LEVEL SECURITY enabled (`42P01 sql142_table_missing`, `55000 sql142_rls_disabled`) and a boolean `is_active` (`42703 sql142_is_active_missing`), `aws_write_mortgage_companies` exists PERMISSIVE `FOR ALL TO authenticated` (exactly) with USING and WITH CHECK `aws_is_authenticated() AND aws_is_cross_tenant_reader()` (`42704 sql142_owner_policy_missing`, `55000 sql142_owner_policy_collision`), `public.aws_is_tenant_manager_admin()` exists (`42883 sql142_function_missing`), and the table has no policy besides `aws_select_mortgage_companies`, `aws_write_mortgage_companies` and the file's two (`55000 sql142_unexpected_policy`). Then `DROP POLICY IF EXISTS` / `CREATE POLICY` for `aws_insert_mortgage_companies_tenant_admin` (`FOR INSERT TO authenticated WITH CHECK (public.aws_is_tenant_manager_admin() AND is_active)`) and `aws_update_mortgage_companies_tenant_admin` (`FOR UPDATE TO authenticated USING / WITH CHECK (public.aws_is_tenant_manager_admin() AND is_active)`), and re-reads them (`sql142_tenant_admin_policy_not_created`, `sql142_owner_policy_mutated`, `sql142_rls_disabled_after_apply`). |

**Why.** Owner decision 2026-11-04 ("Option 2"). A tenant admin (`mcarletta@freedomadj.com`) could not add or edit a
mortgage company from Manager or a Loss Draft check. `public.mortgage_companies` is one directory shared by every
tenant, and its only write policy (`aws/rls/sql/24_complete_write_policies.sql`,
`aws_write_mortgage_companies FOR ALL TO authenticated USING / WITH CHECK (aws_is_authenticated() AND aws_is_cross_tenant_reader())`)
admits the platform owner alone. Evidence:

- the production API log, 2026-11-04T20:28:16Z, `/prep/data/write` `mortgage_companies`: `rls_denied`, "new row
  violates row-level security policy for table "mortgage_companies"";
- read-only production lookups SSM `da2687b5-bfbb-4397-93e7-08593a094e93` and
  `f90ee490-69f3-4057-a306-e8938dcc9371`: that exact policy live, the platform owner passing it, the API login
  `checksops` a member of `authenticated` with table SELECT, INSERT, UPDATE and DELETE.

Who counts as a tenant admin: `public.aws_is_tenant_manager_admin()` (`aws/rls/sql/35_manager_partner_parity.sql`),
the test Manager uses: the platform owner, a `user_roles` admin, or a `tenant_users` owner/admin.

**What it changes.** Two PERMISSIVE policies (they OR with the owner policy). A tenant admin adds active companies and
edits active ones; a row they write must stay active, and an inactive row is not theirs to change (no reactivation).
No DELETE policy for them. Deactivating, reactivating and deleting stay platform-owner only through
`aws_write_mortgage_companies`, which must be intact first and is not changed.

**Not changed:** `aws_select_mortgage_companies`, `aws_write_mortgage_companies`, any grant, RLS enable or FORCE, any
function (`aws_is_tenant_manager_admin`, `aws_is_cross_tenant_reader`), the `updated_at` trigger, any column, row or
other table. The API allowlist (`aws/functions/api/write-allowlist.mjs`) still decides which columns a write may
carry; the portal credential columns are not among them. The release engine's unrelated-catalog snapshot holds every
other policy of the table.

**Production: unverified** through the release engine. A read-only production inspect decides the pre-state; if
production already has both policies the inspect reports `already_applied` true and there is nothing to apply.

**Staging executor refreshed (2026-11-04).** Inspect run 41926552365 (main `7e17ab760`) found the live
executor at `VdiYmwJjoaU6MrZ3NUnpRFRSM/xrf9hGSQgRgoxN2Uo=`. Deploy run 41926865597
(`expected_executor_code_sha256` `VdiYmwJj…` matched) updated `checksops-staging-guarded-sql-executor` to
`UjZrML4kF/gQw1g8T4CsgT8O6tHFpreLkS+o81JzpII=`.

**Staging read-live (2026-11-04).** Run 41927312617 (main `7e17ab760`, executor `UjZrML4k…`): `already_applied`
false, `precondition_failures` `[]`, `prerequisites_missing` `[]`. Live
`ae3be52e6cdd57b9ba779e573a0e1cdab53c793a63893044fb124efbe81238f3`: both policies absent, equal to the derived pre-state; intended `2cff3727…`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 37) under the owner's words of 2026-11-04, "record the
SQL 142 staging pin". The staging apply is a separate run after this pin is merged and the executor is redeployed
carrying it, on the owner's words for that run, "apply SQL 142 in staging". The production pin stays pending: a
read-only production inspect decides production's pre-state.

**Staging executor refreshed for the pin (2026-11-04).** The staging pin (wave 37, PR #1606) merged as
`362db9e4276a76e1fa04adb43071e3a22102be97`. Inspect run 41930257623 (main `362db9e4`) found the live executor at
`UjZrML4kF/gQw1g8T4CsgT8O6tHFpreLkS+o81JzpII=`. Deploy run 41930617688 (`expected_executor_code_sha256`
`UjZrML4k…` matched) updated `checksops-staging-guarded-sql-executor`; inspect run 41931001410 read it at
`UMj/UNO8tqBoGuGnflpp8VrdimQy0qmFMVA7i6/fABc=`. Read-live run 41931277648 (executor `UMj/UNO8…`): `already_applied`
false, `precondition_failures` `[]`, live `ae3be52e…`, equal to the pin.

**Staging apply (2026-11-04).** Apply run 41931631914 (2026-11-04T23:10:57Z, main `362db9e4`, workstream
`github-staging-sql-41931631914`, pin commit `10ef4ea13`, `expected_live_definition_sha256`
`ae3be52e6cdd57b9ba779e573a0e1cdab53c793a63893044fb124efbe81238f3`) under the owner's words "apply SQL 142 in
staging": success. The receipt prints `result` `applied`, `before_hash` `ae3be52e…`, `after_hash`
`2cff3727e102a6dd7ed116b9ae6348a3725362b573c62fcc5050acec0bf10a69`; the policies
`mortgage_companies aws_insert_mortgage_companies_tenant_admin` and
`mortgage_companies aws_update_mortgage_companies_tenant_admin` in state `intended`; `prerequisites_missing` `[]`.
Read-live run 41932005822 (executor `UMj/UNO8…`): `already_applied` true, `live_definition_sha256` `2cff3727…`
equal to the intended hash, `precondition_failures` `[]`. Staging acceptance: the owner tested in staging on
2026-11-04, "SQL 142 accepted in staging". The staging pin keeps `execute: true`; the staging runs are recorded in the
production pin's `staging_acceptance` by the production pin PR.

**Production inspect (2026-11-04).** Read-only `--inspect` through SSM
`1252efe9-757d-4366-ad9e-9901488b4a7a` on `i-0c35557c4e5385406` (under the owner's words "merge 1608 and run the
read-only production check"; runner started 23:30:34Z, stopped 23:31:17Z), main `c8832e178` (tarball sha256
`2e56a4ee375d835e8814a88154aa78da34a211ebc69737d558b26554120e2b74`, staged by `sql53-temporary-transfer.yml` run
41934032301, migration source `f140e75d…` == pin), connected as `checksops_admin`: both policies `absent`; counts
`mortgage_companies_rls_enabled` 1, `mortgage_companies_is_active_boolean` 1, `mortgage_companies_owner_policy_intact`
1, `mortgage_companies_no_unexpected_policy` 1; every prerequisite present; `predecessors` `{}`, `successors_applied`
`[]`; live `ae3be52e6cdd57b9ba779e573a0e1cdab53c793a63893044fb124efbe81238f3`, `already_applied` false, `precondition_failures` `[]`. Production's pre-state equals staging's
(read-live runs 41927312617 and 41931277648), so the staging apply took the path production will
(`aws/tests/sql142-mortgage-companies-tenant-admin-tool-pg.test.mjs`). Recorded in the production pin with the staging
apply (run 41931631914) as its staging acceptance and `execute: true` under the owner's words "record the SQL 142
production pin"; the owner's words so far name the staging steps, the inspect and this pin, not the production apply.
The owner merges the pin change; the apply still needs the owner's words for that run and runs only after that merge is
on main and staged.

**Status:** applied in staging (wave 37, 2026-11-04); staging acceptance: owner tested in staging ("SQL 142 accepted in staging"); production pin execute-authorized; not applied to production

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql142` in
`release-sql-specs.mjs`). Intended `2cff3727e102a6dd7ed116b9ae6348a3725362b573c62fcc5050acec0bf10a69`:

```
release sql142 v1
policy public.mortgage_companies aws_insert_mortgage_companies_tenant_admin: cmd=INSERT permissive=true roles=authenticated qual=- with_check=c3ef36198fdeacd682aef8862fee4095bd694dbf5342d63ef6578c918906e7a3
policy public.mortgage_companies aws_update_mortgage_companies_tenant_admin: cmd=UPDATE permissive=true roles=authenticated qual=c3ef36198fdeacd682aef8862fee4095bd694dbf5342d63ef6578c918906e7a3 with_check=c3ef36198fdeacd682aef8862fee4095bd694dbf5342d63ef6578c918906e7a3
```

(`c3ef3619…` is sha256 of `(public.aws_is_tenant_manager_admin() AND is_active)`, the rendering with search_path
`pg_catalog`.)

**Pre-state: derivable.** Both policies absent:
`ae3be52e6cdd57b9ba779e573a0e1cdab53c793a63893044fb124efbe81238f3` (derived by
`aws/tests/release-sql142-executor.test.mjs` and read back on PostgreSQL 16). Each pin still records its own
environment's read-live or inspect; a pre-state equal to the intended one is `already_applied` true (nothing to apply).

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`public.mortgage_companies`, column `is_active`, `public.aws_is_tenant_manager_admin()`,
`public.aws_is_authenticated()`, `public.aws_is_cross_tenant_reader()`, role `authenticated`);
`altered_relations_owned_by_login` (CREATE POLICY needs the table owner); and four read-only catalog counts, each
exactly 1: `mortgage_companies_rls_enabled`, `mortgage_companies_is_active_boolean`,
`mortgage_companies_owner_policy_intact`, `mortgage_companies_no_unexpected_policy` (an unreadable count fails closed).

Post-conditions: the intended fingerprint; everything else in schema `public` (and the functions of `auth`)
unchanged. The tools roll back otherwise.

## Steps

1. Staging: the staging executor must carry SQL 142 first (the executor package gains
   `sql/142_mortgage_companies_tenant_admin_write.sql`: refresh through the guarded staging executor `deploy` mode,
   its own reviewed run). Then run the guarded staging SQL executor with `read-live` for
   `sql142-mortgage-companies-tenant-admin-write`. Expected: `already_applied` false, `precondition_failures` `[]`,
   `prerequisites_missing` `[]`, the four counts 1, live `ae3be52e…`. If any differs, stop. Otherwise record
   `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`, owner-approved `authorization`,
   `execute: true`) in a reviewed change, `apply` on the owner's words for that run, then `read-live` again
   (`already_applied` true), and have a tenant admin add and edit a mortgage company in staging. Record the staging
   apply and the owner's test in a staging record PR.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql142 … --phase inspect`); record
   `production_inspect` and copy `live_definition_sha256` into `expected_live_definition_sha256`; record the staging
   runs in `staging_acceptance`; set an owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs --migration sql142
   --approval-scope sql142 … --phase apply` with the owner's words (authorization phrase
   `APPLY_MORTGAGE_COMPANIES_TENANT_ADMIN_WRITE`).
4. Record the apply and retire the pin (`execute: false`).

**Revert.** A new reviewed migration through the same guarded path. Never change the policies by hand.
