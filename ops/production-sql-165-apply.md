# Production SQL 165 (pay a vendor: the API's vendor payee lookup and payroll runs that name a vendor)

| key | file | what it does |
|---|---|---|
| `sql165` | `aws/workflows/sql/165_vendor_payee_lookup_and_payroll_vendor.sql` (sha256 `18dfb11105daeb92d202fb8d1f3c0aba16e087c0933ed3352321e5e62e29bd84`, authored by `ffbff4fa9`) | Refuses without its prerequisites (`55000 sql165_prerequisite_missing`), unless the applying login reads `tenants`, `vendor_tenants` and `tenant_vendor_payees` past row security (`55000 sql165_definer_cannot_read`) or unless it owns `payroll_runs` (`55000 sql165_not_payroll_owner`); then creates the read `aws_vendor_payees_for_tenant(uuid)` and lets `payroll_runs` name a vendor. |

**Why.** Owner 2026-11-13: a tenant pays a vendor (SQL 141) from a check, as a recipient beside stakeholders and
partners, and from the standalone Payroll payment, where the vendor is an allowed single recipient. Asked how, the owner
chose "New migration" (a read-only lookup, so unmarking a vendor stops new payments at once and the vendor list can show
"no longer a vendor") and "Record in payroll" (payroll history holds a vendor, so a vendor payroll payment shows in
payroll history and reports).

- The send endpoint (`moov-send.mjs`) must refuse a payee link that was removed, whose organization is no longer
  marked a vendor, or that is not active. The API login (`checksops`, a member of `authenticated`, subject to
  row-level security) cannot read another organization's `vendor_tenants` row: SQL 141's `aws_select_vendor_tenants`
  admits only the vendor's own members and the platform owner (`aws/tests/sql141-permanent-vendor-payees-pg.test.mjs`).
- `payroll_runs.stakeholder_account_id` is `NOT NULL REFERENCES stakeholder_accounts`; a vendor is an organization,
  not a stakeholder account, so a payroll run to a vendor could not be recorded.

**What it does.**
- `public.aws_vendor_payees_for_tenant(_tenant_id uuid) RETURNS jsonb` (new; plpgsql, STABLE, SECURITY DEFINER,
  `search_path = public`, `row_security = off`; EXECUTE `checksops` and the owner only). Reads only, never raises for
  a refusal:
  - not signed in, no tenant, or the caller is not a member of the tenant: `{"ok": false, "error": "forbidden"}`;
  - otherwise `{"ok": true, "tenant_id", "payees": [{"link_id", "vendor_tenant_id", "vendor_name",
    "partner_code_used", "added_at", "is_vendor", "subscription_status", "payable"}]}`: the tenant's live
    `tenant_vendor_payees` links (removed links are not listed), by vendor name; `payable` is `is_vendor` and
    `subscription_status = 'active'`.
- `public.payroll_runs`: `vendor_tenant_id uuid` (nullable, no default) with `payroll_runs_vendor_tenant_id_fkey`
  (`REFERENCES public.tenants(id)`, no ON DELETE action, as `stakeholder_account_id`'s) and the partial index
  `payroll_runs_vendor_tenant_idx`; `stakeholder_account_id` DROP NOT NULL (its foreign key unchanged);
  `payroll_runs_one_payee_check` (`num_nonnulls(stakeholder_account_id, vendor_tenant_id) = 1`: every run still names
  exactly one payee; every existing row names a stakeholder); column INSERT on `vendor_tenant_id` for `checksops`.

Not changed: SQL 141's tables, policies and functions (read only; the SQL 141 production-apply test's guard now allows
exactly this file and asserts it only reads them); `public.tenants`; every `payroll_runs` policy (`aws_select_payroll_runs`,
`aws_write_payroll_runs`, SQL 136's restrictive money-write gates) and table grant; no other function, policy, RLS
setting, table grant or trigger; no row is written by the apply; no money moves. No API, Lambda or SPA change is part of
this pin: the send endpoint's vendor recipients, the vendor payee endpoints and the platform-owner vendor flag ship
afterwards through their own guarded path.

**Engine.** The release engine gains `altered_columns` (`release-sql-state.mjs`, `release-sql-specs.mjs`): an existing
column whose NOT NULL the file changes, fingerprinted by type, NOT NULL and default (`altered column ...` lines),
checked before the apply by `altered_columns_before_or_intended` (it must exist with the reviewed type and default, and
NOT NULL as before or as after the file), and skipped by the unrelated-catalog snapshot like an added column. No other
migration's fingerprint changes.

**Status:** staging pin execute-authorized (wave 57); not applied anywhere. The production pin is pending.

**Staging read-live (2026-11-13).** Run 43506600170 (main `31c0c874b`, after executor inspect run 43505703831 and executor deploy
run 43506159674 (executor CodeSha256 `K6NRf+LR…` -> `cE42JmZv…`)), under the owner's words "Start the SQL 165 staging refresh
and read-live": `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`; the function, the column, its
foreign key, the check and the index absent, `stakeholder_account_id` not yet altered. Live
`3a6d086e37c04740397c0b6a99d558ed0a5e907c296f8a99a71ae323acdca248`, equal to the derived pre-state; intended `23c689b9…`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 57) on the owner's words "Do the SQL 165 staging pin and apply". The
staging apply is a separate run after this pin is merged and the executor is redeployed carrying it.

Production authorization phrase (pin `authorization_phrase`): `ENABLE_VENDOR_PAYEE_LOOKUP_AND_PAYROLL_VENDOR`.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql165` in
`release-sql-specs.mjs`). Intended `23c689b9ac0dad2ee1760214a37038a86142041c104867da8381cffb3d8202fa`:

```
release sql165 v1
function public.aws_vendor_payees_for_tenant(uuid): lang=plpgsql vol=s parallel=u secdef=true result=jsonb config=row_security=off;search_path=public prosrc=ac5bf9d39027c08b439841a0438526fd92a2e85bd19b9115d25a3d4eeb57b535 acl=checksops EXECUTE;owner EXECUTE
column public.payroll_runs.vendor_tenant_id: uuid notnull=false default=- acl=checksops INSERT
altered column public.payroll_runs.stakeholder_account_id: uuid notnull=false default=-
constraint public.payroll_runs payroll_runs_vendor_tenant_id_fkey: d2e0033b9b61262dc31cf4da789c7aac902fefbeba797d230ab911eef7f660bf validated=true
constraint public.payroll_runs payroll_runs_one_payee_check: 832bf08fa86c57b3253ec4c3ca1c25a4c218ccb848a575a6fad11dc09c73363c validated=true
index public.payroll_runs payroll_runs_vendor_tenant_idx: 31f7cd2cac32be52801c1b47ddf76ed5037527e3312fa0dcda58c92e6d897dda
```

**Expected pre-state (both environments).** SQL 141 applied; the function, the column, both constraints and the index
absent; `payroll_runs.stakeholder_account_id` `uuid`, NOT NULL, no default:

```
release sql165 v1
function public.aws_vendor_payees_for_tenant(uuid): absent
column public.payroll_runs.vendor_tenant_id: absent
altered column public.payroll_runs.stakeholder_account_id: uuid notnull=true default=-
constraint public.payroll_runs payroll_runs_vendor_tenant_id_fkey: absent
constraint public.payroll_runs payroll_runs_one_payee_check: absent
index public.payroll_runs payroll_runs_vendor_tenant_idx: absent
```

That is `3a6d086e37c04740397c0b6a99d558ed0a5e907c296f8a99a71ae323acdca248` (`releaseStateHash('sql165', { altered_columns: stakeholder_account_id uuid NOT NULL })`). Each pin records its own environment's read; neither value is written
into a pin before a run reads it. A pre-state other than this one is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present`; `predecessors_applied` (SQL 141); `altered_relations_owned_by_login` (`payroll_runs`);
`function_acl_replaceable`, `functions_owned_by_login` and `function_results_match`; `added_columns_absent_or_intended`,
`altered_columns_before_or_intended`, `added_indexes_absent_or_intended` and the constraints absent or intended;
`definer_can_write_relations` on `tenants`, `vendor_tenants` and `tenant_vendor_payees` (the relations the function
reads past row security).

Post-conditions: the intended fingerprint; everything else in schema `public` unchanged. The tools roll back otherwise.

## Steps (each its own reviewed PR or owner-approved run)

1. Staging read-live (`guarded-staging-sql-executor.yml`, choice `sql165-vendor-payee-lookup-and-payroll-vendor`), then the staging pin PR and the staging apply.
2. Production read-only inspect: `production-sql-one-shot.mjs --migration sql165 --phase inspect` (`ops/production-sql-one-shot.md`).
3. Production pin PR: record `production_inspect` and `staging_acceptance`, set `execute: true`; the owner merges it.
4. Production apply: `--phase apply` with the owner's exact words.
5. Record PR: the `applied` block, `execute: false`.
