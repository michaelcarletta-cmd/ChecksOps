# Production SQL 154 (the optional Starter Package)

| key | file | what it does |
|---|---|---|
| `sql154` | `aws/workflows/sql/154_tenant_starter_package.sql` (sha256 `d550fb4aaa9a7569cb2ced49e5e8e335f115d147704062b5973ee5d7bdf614f9`) | Refuses without `tenants`, `check_billing_events`, `tenant_pricing_audit` (SQL 96), SQL 102's `aws_tenants_member_column_guard()`, `aws_tenant_profile_columns()` and `aws_tenant_has_moov_account(uuid)`, SQL 96's `aws_tenant_pricing_columns()`, SQL 120's `aws_check_processing_price_cents(uuid)` and SQL 152's `aws_failed_deposit_fee_cents()` (`55000 sql154_prerequisite_missing`). Then adds four package columns and the CHECK `tenants_starter_package_valid` to `tenants`, `package_included` to `check_billing_events`, four functions with two triggers, and replaces SQL 102's `aws_tenants_member_column_guard()` in place. |

**Why.** The optional Starter Package (owner 2026-11-10): $3,500 one time for the setup fee, 12 months of Monthly
Maintenance and 250 included Checks; "unused check can roll over", "a failed deposit uses one of the 250", "other
fees are still charged", "a toggle switch or date start to date end". #1753 added SQL 151, the engine and SPA
changes and the overlay plan entries. SQL 151 revoked EXECUTE on `aws_starter_package_checks_used(uuid)` from
`PUBLIC` and granted it to no one, but the API logs in as `checksops` and calls it in the billing snapshot
(`tenant-billing-engine.mjs` `loadTenantBillingContext`, through `optionalQuery`, which swallows the 42501): the
package would read as absent and Monthly Maintenance would be charged for a month the package covers. Found while
building SQL 151's tooling, before any run; owner 2026-11-11: option A, SQL 154 = SQL 151 plus
`GRANT EXECUTE ON FUNCTION public.aws_starter_package_checks_used(uuid) TO checksops;` (SQL 153 is the second
mortgagee fee). SQL 151 is never applied and has no spec or pin.

**What it changes.**
- `tenants`: `starter_package_enabled` (boolean NOT NULL DEFAULT false: every tenant starts off),
  `starter_package_starts_on`, `starter_package_maintenance_ends_on` (date), `starter_package_included_checks`
  (integer NOT NULL DEFAULT 250), and `tenants_starter_package_valid` (included checks >= 0; an enabled package has
  both dates and ends on or after it starts). No column grant.
- `check_billing_events.package_included` (boolean NOT NULL DEFAULT false): the event used an included Check.
- `aws_starter_package_checks_used(uuid)` (STABLE, SECURITY DEFINER) and
  `aws_platform_owner_set_tenant_starter_package(uuid, boolean, date, date, integer)` (SECURITY DEFINER; the platform
  owner only, 42501 otherwise): EXECUTE `checksops` and the owner.
- `aws_apply_starter_package_to_event()` with `aws_check_billing_event_starter_package` (BEFORE INSERT OR UPDATE OF
  status ON check_billing_events): a check fee or failed deposit fee is priced 0 and `package_included` while the
  package is on, started and has Checks left. `aws_tenant_starter_package_audit_row()` with
  `aws_tenant_starter_package_audit` (AFTER UPDATE ON tenants): one `tenant_pricing_audit` row per changed package
  column. Both SECURITY DEFINER, EXECUTE the owner only.
- `aws_tenants_member_column_guard()`: SQL 102's body plus the four package columns for the platform owner (SQL 102's
  body sha256 `5a3673fbc02710649a55ea20b8566d2aa906aec45ebc4fa640790d65e546c94b`, SQL 154's
  `276feac8ff001b95da65d1ca3a80624b1ab2baa8b28333bf69898e8b11546c85`); same attributes, owner and ACL (PUBLIC and the owner).

Not changed: no table, policy or RLS setting; no grant but the two EXECUTE grants to `checksops`; no existing event
repriced; no row written by the apply. The API members held on SQL 154 (`tenant-billing-engine.mjs`,
`tenant-billing-handlers.mjs`) reach production only through the guarded Lambda overlay, after this apply.

**Two new public triggers.** `aws_check_billing_event_starter_package` and `aws_tenant_starter_package_audit`: the
db-readonly-validate trigger count must follow once SQL 154 is applied (its own change; not part of this tooling).

**Predecessor.** SQL 102, whose guard SQL 154 replaces in place; SQL 154 supersedes SQL 102 and SQL 98 (SQL 98's guard
was replaced by SQL 102), so after SQL 154 each counts as applied only while every other object of its own still
matches (staging pin `superseded_intended_sha256`: SQL 102 `c7001f481b8a147ab4a623c9e724d34dd50eaaf11203a96da109b7e28c0fb529`, SQL 98
`4f271a4834ac9fa7809e822e8c8c70c4e0d8903e6318b80d432d248fe341518a`). No refuse-after marker is added to SQL 102: re-running SQL 102 after SQL
154 puts back SQL 102's guard, which fails closed (the package columns could no longer be changed) until SQL 154 is
re-run. SQL 120 and SQL 152 are prerequisites by their functions (applied in both environments).

**Status:** staging pin execute-authorized (wave 46); not applied anywhere. The production pin is pending.

**Staging read-live (2026-11-11).** Run 43033279908 (job 130565516078, main `a21972a85`, after executor deploy run
43032760894, inspect run 43032307944), under the owner's words "Redeploy the staging executor and run SQL 154 read-live":
`already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`, `definer_writes` `tenants`,
`tenant_pricing_audit` and `check_billing_events` `ok true`. Live
`05fb0b9959f677fb828ee1efaf7ffce3513ea83e6d5ed071417a7511be3231ca`: SQL 102's guard with everything else absent (SQL 120 and SQL 152 applied), equal to the derived pre-state;
intended `a50c631a…`. Recorded in the staging pin (`expected_live_definition_sha256`, `execute: true`, wave 46) under
the owner's words of 2026-11-11, "Record the SQL 154 staging pin and merge it when green". The staging apply is a
separate run after this pin is merged and the executor is redeployed carrying it, on the owner's words "then apply SQL
154 in staging". The production pin stays pending: a read-only production inspect decides production's pre-state.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql154` in `release-sql-specs.mjs`). Intended
`a50c631a5d185103fde4bff9be3aec08d78418f0c8524b535ca6ee794ca79fe2`:

```
release sql154 v1
function public.aws_starter_package_checks_used(uuid): lang=sql vol=s parallel=u secdef=true result=integer config=row_security=off;search_path=public prosrc=5e20059a6b1780171709037a6c5aef17b645e763a72e4e1a5eccad8d292f50dd acl=checksops EXECUTE;owner EXECUTE
function public.aws_apply_starter_package_to_event(): lang=plpgsql vol=v parallel=u secdef=true result=trigger config=row_security=off;search_path=public prosrc=d88fa20cf0498407fe25e27666037463865721c0b01a291a3f57c3fd2e764338 acl=owner EXECUTE
function public.aws_platform_owner_set_tenant_starter_package(uuid, boolean, date, date, integer): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=row_security=off;search_path=public prosrc=299ec24e3f4b54b6e6833d4f9b61484a2f30fb21c8480164579713d53fe98966 acl=checksops EXECUTE;owner EXECUTE
function public.aws_tenant_starter_package_audit_row(): lang=plpgsql vol=v parallel=u secdef=true result=trigger config=row_security=off;search_path=public prosrc=57490c0db7b6b005e0ee6256f72e100d6d31b581e44b1fc4544055596b1d981b acl=owner EXECUTE
function public.aws_tenants_member_column_guard(): lang=plpgsql vol=v parallel=u secdef=false result=trigger config=search_path=public prosrc=276feac8ff001b95da65d1ca3a80624b1ab2baa8b28333bf69898e8b11546c85 acl=PUBLIC EXECUTE;owner EXECUTE
column public.tenants.starter_package_enabled: boolean notnull=true default=fcbcf165908dd18a9e49f7ff27810176db8e9f63b4352213741664245224f8aa acl=
column public.tenants.starter_package_starts_on: date notnull=false default=- acl=
column public.tenants.starter_package_maintenance_ends_on: date notnull=false default=- acl=
column public.tenants.starter_package_included_checks: integer notnull=true default=1e472b39b105d349bcd069c4a711b44a2fffb8e274714bb07ecfff69a9a7f67b acl=
column public.check_billing_events.package_included: boolean notnull=true default=fcbcf165908dd18a9e49f7ff27810176db8e9f63b4352213741664245224f8aa acl=
constraint public.tenants tenants_starter_package_valid: 4c861546e495042f952b67f0073099d65a4f46c0c9b34ff80b4333345d2e9f91 validated=true
trigger public.check_billing_events aws_check_billing_event_starter_package: enabled=O def=9ed09a74c6f0ba4d5bcd4dff3f5f7129a2578f2e00202c6553c2108813902bec
trigger public.tenants aws_tenant_starter_package_audit: enabled=O def=d1a27ea2118af309c89b3a643cb2a624936956629a118040d59d17d8292d53d2
```

**Expected pre-state (both environments).** SQL 102's guard, none of SQL 154's other objects (SQL 102, SQL 120 and
SQL 152 applied):

```
release sql154 v1
function public.aws_starter_package_checks_used(uuid): absent
function public.aws_apply_starter_package_to_event(): absent
function public.aws_platform_owner_set_tenant_starter_package(uuid, boolean, date, date, integer): absent
function public.aws_tenant_starter_package_audit_row(): absent
function public.aws_tenants_member_column_guard(): lang=plpgsql vol=v parallel=u secdef=false result=trigger config=search_path=public prosrc=5a3673fbc02710649a55ea20b8566d2aa906aec45ebc4fa640790d65e546c94b acl=PUBLIC EXECUTE;owner EXECUTE
column public.tenants.starter_package_enabled: absent
column public.tenants.starter_package_starts_on: absent
column public.tenants.starter_package_maintenance_ends_on: absent
column public.tenants.starter_package_included_checks: absent
column public.check_billing_events.package_included: absent
constraint public.tenants tenants_starter_package_valid: absent
trigger public.check_billing_events aws_check_billing_event_starter_package: absent
trigger public.tenants aws_tenant_starter_package_audit: absent
```

That is `05fb0b9959f677fb828ee1efaf7ffce3513ea83e6d5ed071417a7511be3231ca` (`releaseStateHash('sql154', { functions: { guard: SQL 102's } })`, derived from SQL 102's bytes),
read back on PostgreSQL 16 by `aws/tests/release-sql154-executor.test.mjs`. Each pin records its own environment's
read; neither value is written into a pin before a run reads it. A pre-state other than this one is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present`; `predecessors_applied` (SQL 102); `functions_owned_by_login`, `function_results_match` and
`function_acl_replaceable` (the guard); `altered_relations_owned_by_login` (`tenants`, `check_billing_events`);
`definer_can_write_relations` on `tenants`, `tenant_pricing_audit` and `check_billing_events`;
`added_columns_absent_or_intended`.

Post-conditions: the intended fingerprint; everything else in schema `public` unchanged. The tools roll back
otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 154 first (executor package refresh through the guarded staging
   executor `deploy` mode, its own reviewed run). Then run the guarded staging SQL executor with `read-live` for
   `sql154-tenant-starter-package`. Expected: `already_applied` false, `precondition_failures` `[]`,
   `prerequisites_missing` `[]`, predecessors `{ sql102: true }`, `live_definition_sha256` `05fb0b99…`
   (above). Otherwise stop. Record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`,
   owner-approved `authorization`, `execute: true`) in a reviewed change, `apply`, then `read-live` again.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql154 … --phase inspect`); record
   `production_inspect` and copy `live_definition_sha256` into `expected_live_definition_sha256`; record the
   staging runs in `staging_acceptance`; set an owner-approved `authorization` and `execute: true`, in one
   reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs --migration sql154
   --approval-scope sql154 … --phase apply` with the owner's words (authorization phrase
   `APPLY_TENANT_STARTER_PACKAGE`).
4. Record the apply and retire the pin (`execute: false`); record SQL 154 live in the overlay plan and
   `staging-sql-live.json`; then the db-readonly-validate trigger count (its own change).
5. Then `tenant-billing-engine.mjs` and `tenant-billing-handlers.mjs` through the guarded Lambda overlay, each with
   its own approval.
