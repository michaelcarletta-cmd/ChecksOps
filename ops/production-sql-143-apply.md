# Production SQL 143 (members and agents add, edit and delete mortgage companies; delete only when unused)

| key | file | what it does |
|---|---|---|
| `sql143` | `aws/workflows/sql/143_mortgage_companies_member_delete_unused.sql` (sha256 `77705dd93494f4353a70b99b0db956ce764aaca0f38e5916b0187f7eb7bbb76c`) | Refuses unless `public.mortgage_companies` is an ordinary table with ROW LEVEL SECURITY enabled (`42P01 sql143_table_missing`, `55000 sql143_rls_disabled`), a uuid `id` and a boolean `is_active` (`42703 sql143_column_missing`); `claims`, `loss_draft_tracking` and `check_cases` are ordinary tables with a uuid `mortgage_company_id` (`42703 sql143_reference_missing`); `aws_write_mortgage_companies` is exactly the platform-owner form (`42704 sql143_owner_policy_missing`, `55000 sql143_owner_policy_collision`); SQL 142's two policies are in SQL 142's form (`55000 sql143_sql142_policy_collision`) and present, or absent with this file's three present on a re-run (`55000 sql143_sql142_policy_missing`); `aws_is_authenticated()`, `aws_has_any_tenant_membership()` and `aws_is_active_mortgage_agent(uuid)` exist (`42883 sql143_function_missing`); and no other policy is on the table (`55000 sql143_unexpected_policy`). Then creates `public.aws_can_edit_mortgage_company_directory()` and `public.aws_mortgage_company_in_use_guard()`, the trigger `aws_mortgage_company_in_use_guard`, drops SQL 142's two policies, creates `aws_insert_mortgage_companies_member`, `aws_update_mortgage_companies_member` and `aws_delete_mortgage_companies_member`, and re-reads them (`sql143_member_policy_not_created`, `sql143_sql142_policy_not_dropped`, `sql143_owner_policy_mutated`, `sql143_guard_trigger_not_created`, `sql143_guard_not_definer`, `sql143_guard_cannot_see_all_rows`, `sql143_rls_disabled_after_apply`). |

**Why.** Owner decisions of 2026-11-05: "Remove should delete it. It can always be added again later, anyone can do
this, mortgage agents should be able to share and edit list", then, on what a delete may do to the files that use a
company, "1": delete only when unused. SQL 142 (applied in production 2026-11-05) let tenant admins add and edit; a
plain member, a mortgage desk agent and any delete were still refused.

**Who may write.** `public.aws_can_edit_mortgage_company_directory()` = `aws_is_authenticated() AND
(aws_has_any_tenant_membership() OR aws_is_active_mortgage_agent(auth.uid()))`: any member of any tenant (SQL 90:
role ignored) or an active mortgage desk agent (SQL 47 / SQL 100). Three PERMISSIVE policies TO `authenticated` on
`(public.aws_can_edit_mortgage_company_directory() AND is_active)`: INSERT (WITH CHECK), UPDATE (USING and WITH CHECK)
and DELETE (USING). A row they write must stay active; an inactive row is not theirs to change or delete. Deactivating
and reactivating stay with `aws_write_mortgage_companies` (platform owner only), which must be intact and is not
changed. SQL 142's two tenant-admin policies are dropped (the new ones cover tenant admins).

**Delete only when unused, for every caller.** `aws_mortgage_company_in_use_guard` (BEFORE DELETE OR UPDATE OF id,
FOR EACH ROW) counts `claims`, `loss_draft_tracking` and `check_cases` rows for the company and refuses with SQLSTATE
`MC143`, message `sql143_company_in_use: this company is used by N files` and DETAIL `{"files": N, "claims": a,
"loss_drafts": b, "check_cases": c}` (the API maps it to a 409 `mortgage_company_in_use`). It covers the API, the
platform owner and the admin login. A BEFORE row trigger runs before the foreign keys' actions, so
`loss_draft_tracking`'s `ON DELETE SET NULL` never runs on a refused delete; `check_cases` (no foreign key) is
counted explicitly. The guard is SECURITY DEFINER with `row_security = off`, owned by the applying login: it counts
rows the caller cannot see, or raises (a query RLS would filter fails instead of returning fewer rows). Known limit:
a check case written for a company in the same instant another transaction deletes it is not blocked by a lock.

**Not changed:** `aws_select_mortgage_companies`, `aws_write_mortgage_companies`, any table grant, RLS enable or
FORCE, any column, foreign key, row or other table. The API allowlist (`aws/functions/api/write-allowlist.mjs`) still
decides which columns a write may carry. The release engine's unrelated-catalog snapshot holds every other object.

**Order.** After SQL 142 (predecessor; SQL 143 supersedes it, so after SQL 143 SQL 142 counts as applied while SQL
143 is: SQL 142 has no object SQL 143 keeps, so no partial fingerprint is pinned). The API and Remove-button change
(#1617, `write-allowlist.mjs` and `write-app-metadata.mjs`) is deployed in an environment only after SQL 143 is
applied there.

**Production: unverified** through the release engine for SQL 143. A read-only production inspect decides the
pre-state, the referencing tables' columns and ownership, and FORCE ROW LEVEL SECURITY.

**Staging executor refreshed (2026-11-05).** Inspect run 42019009492 (main `6498b1fb0`) found the live
executor at `UMj/UNO8tqBoGuGnflpp8VrdimQy0qmFMVA7i6/fABc=`. Deploy run 42019363178
(`expected_executor_code_sha256` `UMj/UNO8…` matched) updated `checksops-staging-guarded-sql-executor` to
`SS564lomN093k/jPs/Hczu1uzGY8hGZxQ3/O2uAgolY=` (inspect run 42019761339).

**Staging read-live (2026-11-05).** Run 42020037212 (main `6498b1fb0`, executor `SS564lom…`): `already_applied`
false, `precondition_failures` `[]`. Live `c62a1b0b337cca713cd8551f1a1c70f507ef451e40731baa6e8479abae51038d`: SQL 142's two policies, nothing of SQL 143, equal to the
derived pre-state; intended `d14d6ac5…`. Recorded in the staging pin (`expected_live_definition_sha256`,
`execute: true`, wave 38) under the owner's words of 2026-11-05, "record the SQL 143 staging pin". The staging
apply is a separate run after this pin is merged and the executor is redeployed carrying it, on the owner's words
for that run, "apply SQL 143 in staging". The production pin stays pending: a read-only production inspect decides
production's pre-state.

**Staging executor refreshed for the pin (2026-11-05).** The staging pin (wave 38, PR #1620) merged as
`5de159cab082193c9c0f9c7a078e485dfee3949c`. Inspect run 42022190786 (main `5de159cab`) found the live executor at
`SS564lomN093k/jPs/Hczu1uzGY8hGZxQ3/O2uAgolY=`. Deploy run 42022476995 (`expected_executor_code_sha256`
`SS564lom…` matched) updated `checksops-staging-guarded-sql-executor`; inspect run 42022862289 read it at
`5aWzE+Sj5D8/I6L8pnECbyXvzZu9Q4VwmVMWkfiuAT8=`. Read-live run 42023189620 (executor `5aWzE+Sj…`): `already_applied`
false, `precondition_failures` `[]`, live `c62a1b0b…`, equal to the pin.

**Staging apply (2026-11-05).** Apply run 42023495275 (2026-11-05T12:00:21Z, main `5de159cab`, workstream
`github-staging-sql-42023495275`, pin commit `407ca2264`, `expected_live_definition_sha256`
`c62a1b0b337cca713cd8551f1a1c70f507ef451e40731baa6e8479abae51038d`) under the owner's words "apply SQL 143 in
staging": success. The receipt prints `result` `applied`, `before_hash` `c62a1b0b…`, `after_hash`
`d14d6ac55a8cc18c49d502cb508ddcb3a03969b7d196843224156d4ef0483029`; both functions, the three member policies, SQL
142's two policies and the trigger in state `intended`. Read-live run 42023847018 (executor `5aWzE+Sj…`):
`already_applied` true, `live_definition_sha256` `d14d6ac5…` equal to the intended hash, `precondition_failures`
`[]`. The staging live record is in `ops/deployment-guard/staging-sql-live.json` (#1621). The API change (#1617) and
the website followed in staging after it (validator run 42026743112, `write-allowlist.mjs` run 42027076925,
`write-app-metadata.mjs` run 42027400258, SPA run 42027746031). Staging acceptance: the owner tested in staging on
2026-11-05, "SQL 143 accepted in staging". The staging pin keeps `execute: true`; the staging runs are recorded in the
production pin's `staging_acceptance` by the production pin PR.

**Production inspect (2026-11-05).** Read-only `--inspect` through SSM
`34e080cb-a508-4f8f-9969-a7433619d673` on `i-0c35557c4e5385406` (under the owner's words "run the read-only production check
for SQL 143"; runner started 14:43:50Z, stopped 14:44:18Z), main `9e2b0da69` (tarball sha256
`9b38212579bb7fc90b819c81256cbc978cf0ae3fd53d1596209d021eb997f5b3`, staged by `sql53-temporary-transfer.yml` run
42047541991, migration source `77705dd9…` == pin), connected as `checksops_admin`: both functions, the three member
policies and the trigger `absent`, SQL 142's two policies `present`; the seven counts 1
(`mortgage_companies_rls_enabled`, `mortgage_companies_id_uuid_is_active_boolean`, `mortgage_company_references_uuid`,
`mortgage_companies_owner_policy_intact`, `mortgage_companies_sql142_policies_replaceable`,
`mortgage_companies_no_unexpected_policy`, `mortgage_company_references_readable_by_login`); every prerequisite
present; `predecessors` `{sql142: true}`, `successors_applied` `[]`; live `c62a1b0b337cca713cd8551f1a1c70f507ef451e40731baa6e8479abae51038d`, `already_applied` false,
`precondition_failures` `[]`. Production's pre-state equals staging's (read-live runs 42020037212 and 42023189620),
so the staging apply took the path production will (`aws/tests/sql143-mortgage-companies-member-delete-tool-pg.test.mjs`).
Recorded in the production pin with the staging apply (run 42023495275) as its staging acceptance and `execute: true`
under the owner's words "record the SQL 143 production pin"; the owner's words so far name the staging steps, the
inspect and this pin, not the production apply. The owner merges the pin change; the apply still needs the owner's
words for that run and runs only after that merge is on main and staged.

**Production apply (2026-11-05).** After the pin change (#1624, merged to main as `5446fd292`), transfer run
42053822728 staged main `5446fd292` (tarball sha256
`4e1e2a207bd1385798615bb8123e4e9c5d99a257b48c0633cbfea02d6ce8f196`). Under the owner's words
"apply SQL 143 in production" (passed verbatim), a one-shot `--phase inspect` (SSM
`8faa26ab-2dd5-4cf4-922a-a41275a975fe`, run `6bfcd677-9a89-4ac9-904b-c7791dec933b`, nothing written) read live `c62a1b0b…` (the pinned pre-state,
`live_matches_expected` true, `apply_preconditions_met` true, `precondition_failures` `[]`, the seven counts 1);
then one-shot `--phase apply` run `2bdbab74-39ad-46a1-8371-f51ce6c532c0` through SSM
`fecb38b8-9305-41e2-a44b-6e3a0a928f06`, workstream `prod-sql143-mortgage-companies-member-delete-unused-20261105`, one_use_id
`sql143-prod-f74ec3d8-c8f5-413b-aef3-ea69b54c7155`: its own inspect step read the same pre-state; contracts 4/4,
6/6 and 43/43; all 11 steps ok; manifest `6391c149…`; receipt `c62a1b0b…` →
`d14d6ac55a8cc18c49d502cb508ddcb3a03969b7d196843224156d4ef0483029` (intended), result `applied`, unrelated
catalog `28044dcf…` (policies 476, functions 1357); post-apply inspect `already_applied` true,
`precondition_failures` `[]`: both functions, the three member policies and the trigger
`mortgage_companies aws_mortgage_company_in_use_guard` `intended`, SQL 142's two policies dropped, the seven counts 1,
`prerequisites_missing` `[]`. SSM returned the first 24000 characters of the run's JSON, cut inside
`applied.receipt`; the receipt and post-apply inspect are recorded from the run's top-level `details.apply_result`
and `details.post_apply_inspect`, which arrived whole (as for SQL 134). The runner `i-0c35557c4e5385406` was started
for this work at 15:21:10Z and stopped at 15:22:19Z. Production's `/db-readonly-validate` expects 184 public triggers
until `db-readonly-validate.mjs` (185, #1621) is deployed; this record states SQL 143 verified live in the production
overlay plan's `sql_prerequisites`, which lifts that member's hold. The API and website that use SQL 143 (#1617) are
not yet deployed to production. Production acceptance had not been reported by the owner when this record was
written; this record does not claim it.

**Production acceptance (2026-11-05).** The API and website that use SQL 143 (#1617) were deployed to production on
the owner's per-run words (`write-allowlist.mjs` run 42057609583, `write-app-metadata.mjs` run 42058501143,
`db-readonly-validate.mjs` run 42058917794, website run 42059289942). The owner then tested adding, editing and
removing mortgage companies in production and reported, verbatim, "1 and 2 work." (item 2: mortgage companies). The record
above, written before that test, is unchanged.

**Status:** applied to staging (wave 38) and to production (2026-11-05); the production pin is retired
(`execute: false`); owner production acceptance 2026-11-05.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql143` in
`release-sql-specs.mjs`). Intended `d14d6ac55a8cc18c49d502cb508ddcb3a03969b7d196843224156d4ef0483029`:

```
release sql143 v1
function public.aws_can_edit_mortgage_company_directory(): lang=sql vol=s parallel=u secdef=true result=boolean config=row_security=off;search_path=public prosrc=718f7e2e8c39c3f48ca4d65adb216e8cd5ac04151f3c85dcbd2931ca877104c7 acl=authenticated EXECUTE;checksops EXECUTE;owner EXECUTE
function public.aws_mortgage_company_in_use_guard(): lang=plpgsql vol=v parallel=u secdef=true result=trigger config=row_security=off;search_path=public prosrc=d0137623d54e1b3d635a3c69b56a36e6f869f4277e27e250715aae7a34dc5875 acl=owner EXECUTE
policy public.mortgage_companies aws_insert_mortgage_companies_member: cmd=INSERT permissive=true roles=authenticated qual=- with_check=5d6ba60fe19447017ff69478e5bb26a2ca039d500ad5bf10a8c9300225b84fd0
policy public.mortgage_companies aws_update_mortgage_companies_member: cmd=UPDATE permissive=true roles=authenticated qual=5d6ba60fe19447017ff69478e5bb26a2ca039d500ad5bf10a8c9300225b84fd0 with_check=5d6ba60fe19447017ff69478e5bb26a2ca039d500ad5bf10a8c9300225b84fd0
policy public.mortgage_companies aws_delete_mortgage_companies_member: cmd=DELETE permissive=true roles=authenticated qual=5d6ba60fe19447017ff69478e5bb26a2ca039d500ad5bf10a8c9300225b84fd0 with_check=-
policy public.mortgage_companies aws_insert_mortgage_companies_tenant_admin: absent
policy public.mortgage_companies aws_update_mortgage_companies_tenant_admin: absent
trigger public.mortgage_companies aws_mortgage_company_in_use_guard: enabled=O def=9a051b5c49bb3fdf346d30db147ce5fa2fff0dfa0efe470836102c4c7705f414
```

(`5d6ba60f…` is sha256 of `(public.aws_can_edit_mortgage_company_directory() AND is_active)` and `9a051b5c…` of the
trigger definition, the renderings with search_path `pg_catalog`; `prosrc` is sha256 of each function body.)

**Pre-state: derivable.** After SQL 142: SQL 142's two policies as SQL 142's file leaves them, nothing of SQL 143
(`c3ef3619…` is sha256 of `(public.aws_is_tenant_manager_admin() AND is_active)`):
`c62a1b0b337cca713cd8551f1a1c70f507ef451e40731baa6e8479abae51038d` (derived by `aws/tests/release-sql143-executor.test.mjs` and read back on PostgreSQL 16):

```
release sql143 v1
function public.aws_can_edit_mortgage_company_directory(): absent
function public.aws_mortgage_company_in_use_guard(): absent
policy public.mortgage_companies aws_insert_mortgage_companies_member: absent
policy public.mortgage_companies aws_update_mortgage_companies_member: absent
policy public.mortgage_companies aws_delete_mortgage_companies_member: absent
policy public.mortgage_companies aws_insert_mortgage_companies_tenant_admin: cmd=INSERT permissive=true roles=authenticated qual=- with_check=c3ef36198fdeacd682aef8862fee4095bd694dbf5342d63ef6578c918906e7a3
policy public.mortgage_companies aws_update_mortgage_companies_tenant_admin: cmd=UPDATE permissive=true roles=authenticated qual=c3ef36198fdeacd682aef8862fee4095bd694dbf5342d63ef6578c918906e7a3 with_check=c3ef36198fdeacd682aef8862fee4095bd694dbf5342d63ef6578c918906e7a3
trigger public.mortgage_companies aws_mortgage_company_in_use_guard: absent
```

Each pin still records its own environment's read-live or inspect; a pre-state equal to the intended one is
`already_applied` true (nothing to apply).

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`public.mortgage_companies` with columns `id` and `is_active`; `public.claims`,
`public.loss_draft_tracking` and `public.check_cases` with column `mortgage_company_id`; `public.aws_is_authenticated()`,
`public.aws_is_cross_tenant_reader()`, `public.aws_has_any_tenant_membership()`, `public.aws_is_active_mortgage_agent(uuid)`,
`auth.uid()`; roles `authenticated` and `checksops`); `predecessors_applied` (SQL 142 on its intended fingerprint);
`altered_relations_owned_by_login` (CREATE POLICY and CREATE TRIGGER need the table owner); and seven read-only
catalog counts, each exactly 1: `mortgage_companies_rls_enabled`, `mortgage_companies_id_uuid_is_active_boolean`,
`mortgage_company_references_uuid`, `mortgage_companies_owner_policy_intact`,
`mortgage_companies_sql142_policies_replaceable`, `mortgage_companies_no_unexpected_policy` and
`mortgage_company_references_readable_by_login` (the login, owner of the guard, reads the three referencing tables
past row level security: owner without FORCE, or superuser / BYPASSRLS, with SELECT). An unreadable count fails
closed.

Post-conditions: the intended fingerprint; everything else in schema `public` (and the functions of `auth`)
unchanged. The tools roll back otherwise.

## Steps

1. Staging: the staging executor must carry SQL 143 first (the executor package gains
   `sql/143_mortgage_companies_member_delete_unused.sql`: refresh through the guarded staging executor `deploy` mode,
   its own reviewed run). Then run the guarded staging SQL executor with `read-live` for
   `sql143-mortgage-companies-member-delete-unused`. Expected: `already_applied` false, `precondition_failures` `[]`,
   `prerequisites_missing` `[]`, the seven counts 1, live `c62a1b0b…` (staging has SQL 142 applied). If any differs,
   stop. Otherwise record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`,
   owner-approved `authorization`, `execute: true`) in a reviewed change, `apply` on the owner's words for that run,
   then `read-live` again (`already_applied` true). Deploy #1617's API change to staging through its own guarded
   runs, have a member add, edit and remove an unused company and see a used one refused, and record the staging
   apply and the owner's test in a staging record PR.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql143 … --phase inspect`); record
   `production_inspect` and copy `live_definition_sha256` into `expected_live_definition_sha256`; record the staging
   runs in `staging_acceptance`; set an owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs --migration sql143
   --approval-scope sql143 … --phase apply` with the owner's words (authorization phrase
   `APPLY_MORTGAGE_COMPANIES_MEMBER_DELETE_UNUSED`). Then #1617's production API deploys, each on the owner's words.
4. Record the apply and retire the pin (`execute: false`).

**Revert.** A new reviewed migration through the same guarded path. Never change the policies, functions or trigger
by hand.
