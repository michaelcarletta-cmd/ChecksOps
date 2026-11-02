# Production SQL 139 (the billing account write policy back to the tenant-write contract)

| key | file | what it does |
|---|---|---|
| `sql139` | `aws/workflows/sql/139_tenant_billing_accounts_write_policy_reconcile.sql` (sha256 `cfe8e15d93b0461d27f31d5c0652e08bb42a4c19ea53932e1ed7306ca1e5e776`) | Refuses unless `public.tenant_billing_accounts` is an ordinary table with ROW LEVEL SECURITY enabled (`42P01 sql139_table_missing`, `55000 sql139_rls_disabled`), `aws_write_tenant_billing_accounts` exists PERMISSIVE `FOR ALL` (`42704 sql139_write_policy_missing`, `55000 sql139_write_policy_shape`), the live-only `aws_write_tenant_billing_accounts_job` exists PERMISSIVE `FOR ALL TO checksops` (exactly) with USING and WITH CHECK `aws_monthly_billing_job()` (`42704 sql139_job_policy_missing`, `55000 sql139_job_policy_collision`), and `public.aws_can_write_tenant(uuid)` exists (`42883 sql139_function_missing`). Then `DROP POLICY IF EXISTS` / `CREATE POLICY aws_write_tenant_billing_accounts ... FOR ALL TO authenticated USING / WITH CHECK (public.aws_can_write_tenant(tenant_id))`, exactly SQL 24's statement, and re-reads it (`sql139_write_policy_not_reconciled`, `sql139_job_policy_mutated`, `sql139_rls_disabled_after_reconcile`). |

**Why.** The read-only billing write diagnostic on staging (#1515, main `1e51f8d3`) showed a tenant member who
cannot save the billing account although `public.aws_can_write_tenant(tenant)` is true for them:

- `lock:0`: `SELECT ... FOR UPDATE` of the tenant's own row returns 0 rows, so the UPDATE USING policies hide it;
- `aws_write_tenant_billing_accounts` (the authenticated write policy) renders, USING and WITH CHECK, to sha256-12
  `8c72ef93d1e5` and does not depend on `public.aws_can_write_tenant(uuid)`; the repository's rendering
  `aws_can_write_tenant(tenant_id)` is `2523b078754a`. The live text is not known and nothing here assumes it;
- `aws_write_tenant_billing_accounts_job` (`ALL TO checksops`) and `aws_select_tenant_billing_accounts_job`
  (`SELECT TO checksops`) render to `1c3f7a3edd76`, which is `aws_monthly_billing_job()`;
- `aws_select_tenant_billing_accounts` renders to `7b9c86002fdd`,
  `(aws_is_cross_tenant_reader() OR aws_can_access_tenant(tenant_id))`, as the repository;
- the table's trigger is the repository's (`c10d3ecdb68d`), there is no rule, and there is one
  `aws_can_write_tenant` overload.

The repository's policy is `aws/rls/sql/24_complete_write_policies.sql`'s
`aws_write_tenant_billing_accounts FOR ALL TO authenticated USING / WITH CHECK (public.aws_can_write_tenant(tenant_id))`.
Precedent: `aws/write-path/guarded-sql-executor/sql/39_tmp_write_policy_reconcile.sql` reconciled the same kind of
drift on `tenant_maintenance_payments` and refused unless its `_job` policy was intact.

**What it changes.** One policy: `aws_write_tenant_billing_accounts` is dropped and created as SQL 24 has it.
The machine write path (the monthly billing job) is `aws_write_tenant_billing_accounts_job`, which must be intact
first, so replacing the authenticated policy cannot be what removes it.

**Not changed:** `aws_select_tenant_billing_accounts`, `aws_select_tenant_billing_accounts_job`,
`aws_write_tenant_billing_accounts_job`, SQL 136's RESTRICTIVE `aws_money_write_gate_*_tenant_billing_accounts`
(applied or not: they are other policies, and a RESTRICTIVE policy ANDs with this permissive one), any grant, RLS
enable or FORCE, any function (`aws_can_write_tenant`, `aws_monthly_billing_job`), trigger, column, row or other
table. The release engine's unrelated-catalog snapshot holds every other policy of the table.

**Production: unverified.** Nothing recorded says production has the same drift, the `_job` policy or
`aws_monthly_billing_job()`. A read-only production inspect decides that; if production already has the repository
policy the inspect reports `already_applied` true and there is nothing to apply.

**Staging executor refreshed (2026-11-02).** Inspect run 41367344136 (main `383f8a89`) found the live
executor at `ODAzQ8ftXKSMX18xlkCNHgJ+PUwUi3Q4gr7L4GFpev8=` (current false: without
`sql/139_tenant_billing_accounts_write_policy_reconcile.sql`). Deploy run 41367591449
(`expected_executor_code_sha256` `ODAzQ8ft…` matched) updated `checksops-staging-guarded-sql-executor` to
`e/7IOeV85/ABLNfaECLrtGwKOQV6yC+ZeVLLkyejFdw=`.

**Staging read-live (2026-11-02).** Run 41367825238 (main `383f8a89`, executor `e/7IOeV8…`): `already_applied`
false, `precondition_failures` `[]`, `prerequisites_missing` `[]`, counts `billing_table_rls_enabled` 1,
`billing_write_policy_permissive_all` 1, `billing_job_policy_intact` 1. Live
`8727ecb1f834f9623c1ea7f568621f64a4212dadf3d28a5a7741a6a542cdb22f`: staging's drifted policy as that run read it
(not derivable, see the pre-state below); intended `17f07a31…`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 35) under the owner's words of 2026-11-02, "record the
SQL 139 staging pin". The staging apply is a separate run after this pin is merged and the executor is redeployed
carrying it, on the owner's words for that run, "apply SQL 139 in staging". The production pin stays pending: a
read-only production inspect decides production's pre-state.

**Staging executor refreshed for the pin (2026-11-02).** The staging pin (wave 35, PR #1517) merged as
`75b0b9f1c30cc05933cd95a0603e4a90fdb20ae3`. Inspect run 41369442859 (main `75b0b9f1`) found the live
executor at `e/7IOeV85/ABLNfaECLrtGwKOQV6yC+ZeVLLkyejFdw=` (`executor_current` false). Deploy run 41369655188
(`expected_executor_code_sha256` `e/7IOeV8…` matched) updated `checksops-staging-guarded-sql-executor` to
`7x52PS7o2AbqXrTW+TBY0hKcix1vW/+iOi8RxtVDeYE=`.

**Staging apply (2026-11-02).** Apply run 41369892057 (2026-11-02T00:59Z, main `75b0b9f1`, workstream
`github-staging-sql-41369892057`, pin commit `6f72d3e25`, `expected_live_definition_sha256`
`8727ecb1f834f9623c1ea7f568621f64a4212dadf3d28a5a7741a6a542cdb22f`) under the owner's words "apply SQL 139 in
staging": success. The receipt prints `result` `applied`, `before_hash` `8727ecb1…`, `after_hash`
`17f07a31e274899a50f53877dc1df48839614ba6148047a4321000e474bd446d`; the policy
`tenant_billing_accounts aws_write_tenant_billing_accounts` in state `intended`; `prerequisites_missing` `[]`.
Read-live run 41370841522 (main `75b0b9f1`, executor `7x52PS7o…`): `already_applied` true,
`live_definition_sha256` `17f07a31…` equal to the intended hash, `precondition_failures` `[]`,
`prerequisites_missing` `[]`, counts `billing_table_rls_enabled` 1, `billing_write_policy_permissive_all` 1,
`billing_job_policy_intact` 1. Staging acceptance: the owner tested in staging on 2026-11-02,
"It saved, record SQL 139 staging": after the apply, unticking auto-debit on Freedom Adjustment's billing account
saved; before the apply the same save returned 409 `billing_update_not_applied` with the diagnostic `lock:0`. The
staging pin keeps `execute: true`; the staging runs are recorded in the production pin's `staging_acceptance` by the
production pin PR.

**Production inspect (2026-11-02).** Read-only `--inspect` through SSM
`5eb60937-5d3d-4196-93b8-bd874aac63db` on `i-0c35557c4e5385406` (under the owner's words "start the SQL runner for
the SQL 139 production inspect"), main `0984b4049` (tarball sha256
`3f0588a912f05605b93098573641f89b0eab7cde90bcae2296ee1bf1b7e8c46d`, staged by `sql53-temporary-transfer.yml`,
migration source `cfe8e15d…` == pin), connected as `checksops_admin`: the policy
`tenant_billing_accounts aws_write_tenant_billing_accounts` `different`; counts `billing_table_rls_enabled` 1,
`billing_write_policy_permissive_all` 1, `billing_job_policy_intact` 1; every prerequisite present
(`aws_monthly_billing_job()` included); `predecessors` `{}`, `successors_applied` `[]`; live
`8727ecb1f834f9623c1ea7f568621f64a4212dadf3d28a5a7741a6a542cdb22f`, `already_applied` false,
`precondition_failures` `[]`. Production has the same drift as staging: its pre-state equals staging's (read-live
run 41367825238), so the staging apply took the path production will
(`aws/tests/sql139-billing-write-policy-pg.test.mjs`). Recorded in the production pin with the staging apply (run
41369892057) as its staging acceptance and `execute: true` under the owner's words "record the SQL 139 production
pin"; the owner's words so far name the staging steps, the inspect and this pin, not the production apply. The
owner merges the pin change; the apply still needs the owner's words for that run and runs only after that merge is
on main and staged.

**Status:** applied in staging (wave 35, 2026-11-02); staging acceptance: owner tested in staging (the billing account saved); production pin execute-authorized; not applied to production

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql139` in
`release-sql-specs.mjs`). Intended `17f07a31e274899a50f53877dc1df48839614ba6148047a4321000e474bd446d`:

```
release sql139 v1
policy public.tenant_billing_accounts aws_write_tenant_billing_accounts: cmd=ALL permissive=true roles=authenticated qual=8617e9848be47feb0e8b187dacaff23125033829092a68defc6e900d2736c4d4 with_check=8617e9848be47feb0e8b187dacaff23125033829092a68defc6e900d2736c4d4
```

(`8617e984…` is sha256 of `public.aws_can_write_tenant(tenant_id)`, the rendering with search_path `pg_catalog`.)

**Pre-state: not derivable.** It is the live `aws_write_tenant_billing_accounts` line (cmd, permissive, roles and
the sha256 of its USING and WITH CHECK renderings), and staging's drifted text is unknown. Each pin records its own
environment's read-live or inspect; no value is written into a pin before a run reads it. A pre-state equal to the
intended one is `already_applied` true (nothing to apply).

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`public.tenant_billing_accounts`, column `tenant_id`, `public.aws_can_write_tenant(uuid)`,
`public.aws_monthly_billing_job()`, roles `checksops` and `authenticated`); `altered_relations_owned_by_login`
(DROP / CREATE POLICY need the table owner); and three read-only catalog counts, each exactly 1:
`billing_table_rls_enabled`, `billing_write_policy_permissive_all`, `billing_job_policy_intact` (an unreadable
count fails closed).

Post-conditions: the intended fingerprint; everything else in schema `public` (and the functions of `auth`)
unchanged. The tools roll back otherwise.

## Steps

1. Staging: the staging executor must carry SQL 139 first (the executor package gains
   `sql/139_tenant_billing_accounts_write_policy_reconcile.sql`: refresh through the guarded staging executor
   `deploy` mode, its own reviewed run). Then run the guarded staging SQL executor with `read-live` for
   `sql139-tenant-billing-accounts-write-policy-reconcile`. Expected: `already_applied` false,
   `precondition_failures` `[]`, `prerequisites_missing` `[]`, the three counts 1. If any differs, stop.
   Otherwise record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`, owner-approved
   `authorization`, `execute: true`) in a reviewed change, `apply` on the owner's words for that run, then
   `read-live` again (`already_applied` true), and have the owner save the billing account in staging (the billing
   write diagnostic then reports `lock:1`). Record the staging apply and the owner's test in a staging record PR.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql139 … --phase inspect`); record
   `production_inspect` and copy `live_definition_sha256` into `expected_live_definition_sha256`; record the staging
   runs in `staging_acceptance`; set an owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs --migration sql139
   --approval-scope sql139 … --phase apply` with the owner's words (authorization phrase
   `APPLY_TENANT_BILLING_ACCOUNTS_WRITE_POLICY_RECONCILE`).
4. Record the apply and retire the pin (`execute: false`).

**Revert.** A new reviewed migration through the same guarded path. Never change the policy by hand.
