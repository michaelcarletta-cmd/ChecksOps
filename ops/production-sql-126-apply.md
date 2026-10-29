# Production SQL 126 (the Supabase-era definer reads check their caller)

| key | file | what it does |
|---|---|---|
| `sql126` | `aws/workflows/sql/126_definer_reads_caller_gates.sql` (sha256 `398fe16cc3bfb0940e922a15233c56109a7b6f4f3990da4180f5e4cb58028933`) | Replaces thirteen Supabase-era `SECURITY DEFINER` read functions with the same signature, defaults, result, language, volatility, `SECURITY DEFINER` and `search_path = public`; each body is the supabase one with only the caller gate (or the row scoping) changed. `REVOKE ALL` on the thirteen from `PUBLIC`, and from `anon`, `authenticated` and `service_role` where they exist; `GRANT EXECUTE` to `checksops`. |

**Why.** Security audit 2026-10-29, finding 4, database part (owner, 2026-10-29: "Proceed with
2-4"; PR #1379 is the API part). These functions let in any caller holding a global
`user_roles` admin or staff role, and every tenant admin holds `user_roles.admin`
(`aws/rls/FINAL_POLICY_SET.md`), so a tenant admin could read every tenant through
`POST /data/rpc`: every check (`get_all_checks_safety_net`, `get_stuck_checks`), the deposit KPIs,
another tenant's dashboard counts, usage, users and emails, any check's claim settlement, another
user's permissions, and the unread counts of every tenant's check threads. PR #1379 refuses those
calls in the API (`aws/functions/api/data.mjs` `RPC_ACCESS_GATES`). SQL 126 puts the same rule
inside each function, so a path around the API gate cannot read across tenants.

**What it changes.** Each function as its supabase migration (restored onto the AWS databases)
defines it, with only this changed (`aws/tests/helpers/sql126-definer-reads-schema.mjs` lists the
exact edits; `aws/tests/release-sql126-executor.test.mjs` checks every body is the supabase body
with those edits and nothing else):

| function (supabase migration) | was | now |
|---|---|---|
| `get_all_checks_safety_net()` (20260502114110) | `user_roles` admin or staff | platform owner (`is_platform_owner()`), 42501 otherwise |
| `get_deposit_ops_kpis()`, `get_deposit_exception_kpis()` (20260308181449), `get_deposit_aging_summary()` (20260308173238) | `user_roles` admin or staff | platform owner, 42501 otherwise |
| `get_stuck_checks()` (20260502114110) | `user_roles` admin or staff: every tenant's checks | platform owner: every tenant's; `user_roles` admin or staff: only their own tenants' checks (`aws_user_tenant_ids()`); 42501 otherwise as before |
| `get_check_dashboard_counts_for_tenant(uuid)` (20260422135931), `get_loss_draft_dashboard_counts_for_tenant(uuid)` (20260603174139), `get_tenant_check_usage(uuid, timestamptz, timestamptz)` (20260820191520) | tenant member, or `user_roles` admin or staff for any tenant | `aws_can_access_tenant(_tenant_id)` (tenant member or platform owner), 42501 otherwise |
| `get_tenant_users_with_profiles(uuid)` (20260423231349), `is_checkalt_enabled_for_tenant(uuid)` (20260626191752) | tenant member or `user_roles` admin (users); anyone (Check Alt) | `aws_can_access_tenant(_tenant_id)`; no rows / false otherwise (LANGUAGE sql, as before) |
| `get_check_claim_settlement(uuid)` (20260608105612) | check's tenant, active share target, `user_roles` admin or staff | check's tenant, active share target (the partner keeps it), platform owner; NULL otherwise as before |
| `has_permission(uuid, text)` (20260106133153) | any user id | the caller's own id or the platform owner; 42501 otherwise |
| `get_check_unread_counts()` (20260502121539) | every check with messages | only checks whose messages the caller may read (`aws_can_access_check`, the `check_messages` read rule); `get_total_unread_check_messages()` sums it and is not changed |

`get_stuck_checks` is scoped rather than made owner-only because check reconciliation
(`aws/functions/api/check-reconciliation.mjs`) calls it for a tenant admin and already keeps only
that tenant's rows; the API route stays owner-only (PR #1379).

Not changed: `get_tenant_funds_received`, `get_check_stage_totals` and
`aws_tenant_referral_summary` (they already allow only tenant members, or members and the platform
owner); `get_total_unread_check_messages`; any table, column, view, policy, RLS setting, table
grant, trigger or row. No API or SPA change. No trigger is added, so the DB validator's public
trigger count is not concerned.

**Staging executor refreshed (2026-10-29).** Inspect run 40915770608 found the live executor at
`yHVZNx1R…` without `sql/126_definer_reads_caller_gates.sql`. Deploy run 40917101622 (main
`7d33d5c`) updated it to main's package ("Verify live executor now carries main's package" passed).

**Staging read-live (2026-10-29).** Run 40917478177 (main `7d33d5c`, executor `/ZkFu2xY…`): the thirteen
functions present, each `different` from the intended state; EXECUTE `PUBLIC` and the owner on every
one; `prerequisites_missing` `[]`, `precondition_failures` `[]`, `already_applied` false; live
`04106521263eeeb423ac2c0dfbf5e1f1af5a52c89501b63ac742d6b25c5e1612`, the restored pre-state derived from the supabase bytes and the
default ACL. Recorded in the staging pin (`expected_live_definition_sha256`, `execute: true`, wave 25)
under the owner's words of 2026-10-29, "start SQL 126 on staging".

**Staging apply (2026-10-29).** After #1390 merged the staging pin (main `7422c69`), under the
owner's words of 2026-10-29, "start the SQL 126 staging apply", each run approved by the owner in
the GitHub `staging` environment:

- Inspect run 40920400596: live executor `/ZkFu2xYI6I8lOfr9B7aLN2ODsr6k05SD2IDnoL2Rw0=` (deploy run
  40917101622); main supersedes only `lib/sql-executor-auth.mjs`; nothing added.
- Deploy run 40920738142: executor now `ODInv6cl/mZGp2lhmOqL8iT0WmjAnuRLpBVvaFBV5KE=` (revision
  `68275648-d17c-48bc-8319-ba3397b493a2`); "Verify live executor now carries main's package" passed;
  staging API untouched.
- Apply run 40921170890 (workstream `github-staging-sql-40921170890`, pin commit `747fc1e`): receipt
  before `04106521263eeeb423ac2c0dfbf5e1f1af5a52c89501b63ac742d6b25c5e1612`, after
  `3aebf853a375d7a668acf62c8877a7b6a0d5f791b73121b591acd9046b0510b2` (intended), result `applied`;
  the thirteen functions `intended`, EXECUTE `checksops` and the owner on every one,
  `prerequisites_missing` `[]`.
- Read-live run 40921576727: live `3aebf853…`, `already_applied` true, the thirteen functions
  `intended`, EXECUTE `checksops` and the owner, `precondition_failures` `[]`.

Not checked: the screens in step 1 (tenant admin and platform owner on staging); there are no staging
test logins for those roles in this workstream. The caller rules are covered by
`sql126-definer-reads-caller-gates-pg` on PostgreSQL 16, not by a signed-in staging check.

**Production inspect (2026-10-29).** Read-only `--inspect` through SSM
`a98a1794-509b-4689-ada4-1a35f32bbdaa` on `i-0c35557c4e5385406`, main `56a748c` (tarball sha256
`26e22d758d452b17a87ffe0e5572bad38f74d009ca83c66dc6d94dd1ec4c4321`, transfer run 40924642393, migration
source `398fe16c…` == pin), connected as `checksops_admin`: the thirteen functions present, each
`different`; every prerequisite present; live
`9ebc7455de1e0e467eabf59e697899bc64dc360efb8c34a3e00106e68b7754ed`, `already_applied` false,
`precondition_failures` `[]`. EXECUTE on every one is `PUBLIC`, `checksops` and the owner: production's
pre-state is staging's (the supabase bodies) plus a `checksops` EXECUTE grant that staging's restore did not
carry. The engine derives `9ebc7455…` from the supabase bodies with that ACL (asserted in
`aws/tests/release-sql126-executor.test.mjs`). SQL 126 grants `checksops` EXECUTE itself, so production
reaches the same intended state as staging. The runner was started for the run and stopped after it
(start requested 17:48:44 UTC, stopped 17:50:05 UTC). Recorded in the production pin with the staging apply
as its staging acceptance and `execute: true` under the owner's words of 2026-10-29, "open the SQL 126
production pin PR". The owner merges the pin change; the apply still needs the owner's run-time approval
and runs only after that merge is on main and staged.

**Status:** applied to staging (wave 25); production pin execute-authorized; not applied to production.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql126` in `release-sql-specs.mjs`): per function its language, volatility, parallel safety,
`SECURITY DEFINER`, result (the four `TABLE (...)` results as PostgreSQL renders them, stated in
the spec), `proconfig`, sha256 of the body and the EXECUTE ACL. Intended
`3aebf853a375d7a668acf62c8877a7b6a0d5f791b73121b591acd9046b0510b2`:

```
release sql126 v1
function public.get_all_checks_safety_net(): lang=plpgsql vol=v ... prosrc=65425ad84d8be7a5c027b3a2a3b9eeccc49250875833cc193c021ea082c661c7 acl=checksops EXECUTE;owner EXECUTE
function public.get_stuck_checks(): lang=plpgsql vol=v ... prosrc=3d7bcbb70b2cdd904eae06031806fa07dd408b9bf1e1960428c72ac5b352bbe8 acl=checksops EXECUTE;owner EXECUTE
function public.get_deposit_ops_kpis(): lang=plpgsql vol=s ... prosrc=45f66d90393a8361433ac0972203c61a79becb16ba0340263cf5e11b4c45fe77 acl=checksops EXECUTE;owner EXECUTE
function public.get_deposit_exception_kpis(): lang=plpgsql vol=s ... prosrc=23fb969d615fe7715fbd816285f49247fddb178f09d09eb3ca9eb4e3b784f440 acl=checksops EXECUTE;owner EXECUTE
function public.get_deposit_aging_summary(): lang=plpgsql vol=s ... prosrc=a5c77fc9d35a5ee948cde3e36a4e836265744560639e24d83ef840f7208e69ab acl=checksops EXECUTE;owner EXECUTE
function public.get_check_dashboard_counts_for_tenant(uuid): lang=plpgsql vol=s ... prosrc=1ad256d8d97236b10be346080cac41fb03442082a64cd86deca63feca05aabe3 acl=checksops EXECUTE;owner EXECUTE
function public.get_loss_draft_dashboard_counts_for_tenant(uuid): lang=plpgsql vol=s ... prosrc=833817ee2783d8c7293d6267d3ee47a9e932873a85076a3f9ecb0100b1559722 acl=checksops EXECUTE;owner EXECUTE
function public.get_tenant_check_usage(uuid, timestamp with time zone, timestamp with time zone): lang=plpgsql vol=s ... prosrc=3549102d1c76c8f47d9a8cd1f298db9511844d2d84e24561b50d3889e449942e acl=checksops EXECUTE;owner EXECUTE
function public.get_tenant_users_with_profiles(uuid): lang=sql vol=s ... prosrc=080012fe6ce57e5481e19895866d5ef0ce69d9a28773f88dd14f4e0c47d06146 acl=checksops EXECUTE;owner EXECUTE
function public.is_checkalt_enabled_for_tenant(uuid): lang=sql vol=s ... prosrc=f9ac394715bf4ff72ff819b8d5f2cabc5fd1c1741ffac6f784881c2d590ee3a6 acl=checksops EXECUTE;owner EXECUTE
function public.get_check_claim_settlement(uuid): lang=plpgsql vol=s ... prosrc=d1e6e60dba4cd8d65264263a86f62f532f5095fc520a6ec744a686c739d7f5cd acl=checksops EXECUTE;owner EXECUTE
function public.has_permission(uuid, text): lang=plpgsql vol=s ... prosrc=efe92a185f6124513a4104836d89052d6aa92a01697876993e472353a5c14aba acl=checksops EXECUTE;owner EXECUTE
function public.get_check_unread_counts(): lang=sql vol=s ... prosrc=f2349ce1739ef0eabde01ba7cd0ea406ab034b96d63aaa1b11baf2be9a21e698 acl=checksops EXECUTE;owner EXECUTE
```

**Expected pre-state.** The restore (`aws/db-copy/FIRST_COPY_PROCEDURE.md`: `pg_dump --no-acl`)
left each function with its supabase body and the default EXECUTE (`PUBLIC` and the owner). If
nothing else changed them, the read-live and the production inspect report every function
`different`, `function_acl` `PUBLIC EXECUTE` and `owner EXECUTE`, and
`04106521263eeeb423ac2c0dfbf5e1f1af5a52c89501b63ac742d6b25c5e1612` (derived from the supabase
bytes by `aws/tests/release-sql126-executor.test.mjs`, and read back from a PostgreSQL 16 database
built from those migrations). A different hash is not by itself a stop (an EXECUTE grant to
`authenticated`, `anon`, `service_role` or `checksops` changes it and is revoked or kept by the
file), but the per-function report and ACL must be read before recording it.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the thirteen functions, `auth.uid()`, `is_platform_owner()`,
`aws_can_access_tenant(uuid)`, `aws_can_access_check(uuid)`, `aws_user_tenant_ids()`,
`has_role(uuid, app_role)`, `user_belongs_to_tenant(uuid, uuid)`, the twenty tables and views the
bodies read, role `checksops`); `functions_owned_by_login`; `function_results_match` (each result
type is the one the file keeps; `CREATE OR REPLACE` could not change it); `function_acl_replaceable`
(no EXECUTE grant outside `PUBLIC`, `anon`, `authenticated`, `service_role`, `checksops` and the
owner).

Post-conditions: the intended fingerprint; every function owned by the login; everything else in
schema `public` (and the functions of `auth`) unchanged. The tools roll back otherwise.

## Steps

1. Staging: the staging executor must carry SQL 126 first (executor package refresh through the
   guarded staging executor `deploy` mode, its own reviewed run). Then run the guarded staging
   SQL executor with `read-live` for `sql126-definer-reads-caller-gates`. If it reports
   `prerequisites_missing` other than `[]` or `precondition_failures` other than `[]`, stop.
   Otherwise record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`,
   owner-approved `authorization`, `execute: true`) in a reviewed change, `apply`, then `read-live`
   again. Check on staging, as a tenant admin of one tenant: the Command Center (dashboard counts,
   loss-draft counts, unread badge), Settings > Users, billing usage, a check's claim
   ledger card, the check-message panel and `/reconciliation`; as the platform owner the Loss
   Prevention panel and Deposit Manager KPIs.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql126 … --phase inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging runs in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql126 --approval-scope sql126 … --phase apply` with the owner's words.
4. Record the apply and retire the pin (`execute: false`).
