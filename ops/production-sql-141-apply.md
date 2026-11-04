# Production SQL 141 (permanent vendors and vendor payees by Partner Code)

| key | file | what it does |
|---|---|---|
| `sql141` | `aws/workflows/sql/141_permanent_vendor_payees.sql` (sha256 `547a1ffe3ec4d6ae9aaa00432486791e721c712c07733bd72a7ba9408708fa88`) | Fail-closed preconditions (`sql141_prerequisite_missing`, `sql141_definer_cannot_read`, both 55000), then two new tables, `public.vendor_tenants` and `public.tenant_vendor_payees` (RLS on, not forced; one SELECT policy each `TO authenticated`; every non-owner grant revoked, then SELECT only to `checksops` and `authenticated`), and three SECURITY DEFINER functions, `aws_vendor_payee_add(uuid, text)`, `aws_vendor_payee_remove(uuid, uuid)` and `aws_platform_owner_set_tenant_vendor(uuid, boolean)` (VOLATILE, `search_path = public`, `row_security = off`, returns `jsonb`; EXECUTE revoked from PUBLIC and granted to `checksops` only). No INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER to any role on either table; nothing to anon, PUBLIC or `service_role`; no change to `public.tenants` or any existing object. |

**Why.** Owner decision 2026-11-03: the platform owner creates permanent vendor organizations. Each
has a Partner Code (`tenants.partner_code`, as every organization does). A tenant enters a vendor's
Partner Code to add that vendor as a payee, immediately, without the vendor approving. The code only
adds a payee: it never creates a tenant partnership and never shares a check, a claim or any other
record with the vendor. Money paid to a vendor lands in the vendor's own ChecksOps (Moov) wallet;
the vendor chooses on its Wallet page whether it stays there or goes to its bank. Vendors use the
Vendor Portal (`/vendor-ops`), not the Check Center.

Today a tenant can pay another organization's wallet only on the partner path of the send endpoint
(`aws/functions/api/providers/production/moov-send.mjs` `resolveDestinations`, kind `partner`), which
requires the check to be shared with that organization or an active `tenant_partnerships` row (SQL
76). A partnership is the check-sharing relationship, so it is the wrong permission for a vendor;
payee rows (SQL 113) are paid by ACH to a bank only. SQL 141 adds the permission a vendor payment
needs and nothing else. **Nothing here moves money**, creates a Moov account or reads one. The send
endpoint accepting a vendor payee link is a separate API change, not part of this migration or its
tooling.

Vendor status is its own table, not a `tenants` column: `public.tenants` is guarded by
`aws_tenants_member_column_guard` (SQL 102), which refuses a change to any column it does not list,
and is audited by the profile trigger. Keeping vendors out of `tenants` leaves that guard, its audit
and every `tenants` grant exactly as they are.

**The objects.**

- `public.vendor_tenants`: `tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE
  CASCADE`, `created_at timestamptz NOT NULL DEFAULT now()`, `created_by uuid`. Policy
  `aws_select_vendor_tenants` (`FOR SELECT TO authenticated USING (tenant_id IN (SELECT
  public.aws_user_tenant_ids()) OR public.is_platform_owner())`): the vendor's own members and the
  platform owner. Written only by `aws_platform_owner_set_tenant_vendor`.
- `public.tenant_vendor_payees`: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `tenant_id` (the
  paying organization) and `vendor_tenant_id` (the vendor), both `uuid NOT NULL REFERENCES
  public.tenants(id) ON DELETE CASCADE`, `partner_code_used text`, `added_by uuid`, `created_at
  timestamptz NOT NULL DEFAULT now()`, `removed_at timestamptz`, `removed_by uuid`, `CHECK
  (tenant_id <> vendor_tenant_id)` (`tenant_vendor_payees_not_self`). The partial unique index
  `tenant_vendor_payees_live_pair_key (tenant_id, vendor_tenant_id) WHERE removed_at IS NULL` allows
  one live link per pair (a removed link stays as history); `tenant_vendor_payees_vendor_idx
  (vendor_tenant_id)`. Policy `aws_select_tenant_vendor_payees` (the same expression): the paying
  organization's members and the platform owner; the vendor does not read which tenants added it.
  Written only by `aws_vendor_payee_add` / `aws_vendor_payee_remove`.
- `aws_vendor_payee_add(_tenant_id, _partner_code)`: a member of `_tenant_id` adds the vendor whose
  current Partner Code or Partner Code alias (`tenant_partner_code_aliases`) is the code. Refused
  unless the code names exactly one organization, that organization is a vendor with
  `subscription_status` `active`, and it is not the caller's own; a regular organization's code is
  answered like an unknown code (`vendor_not_found`). A live link for the pair is returned as it is
  (`replayed`).
- `aws_vendor_payee_remove(_tenant_id, _vendor_tenant_id)`: a member ends its live link
  (`removed_at`, `removed_by`).
- `aws_platform_owner_set_tenant_vendor(_tenant_id, _is_vendor)`: the platform owner marks an
  organization as a vendor or not. Turning it off keeps the payee links as history.

**Roles.** `checksops` (the API login) holds EXECUTE on the three functions and SELECT on both
tables; `authenticated` holds SELECT on both tables (row-level security decides which rows). No
role but the owner writes either table directly.

**Expected outcomes of the inspect.** `already_applied` false with `precondition_failures` `[]`, or
`already_applied` true (both tables, both policies and the three functions as intended: nothing to
apply; the inspect is recorded as the verified-live evidence and the pin stays `execute: false`).
Anything else (a precondition failure, such as a table or function of the same name in another
shape, a missing prerequisite, or a login that cannot read `tenants` or
`tenant_partner_code_aliases` past row security) stops and needs its own reviewed change.

**Status:** guarded tooling built; not applied anywhere. The staging pin is pending (no read-live yet); the production pin is pending.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql141` in `release-sql-specs.mjs`: `functions`, `policies` and `tables`, as SQL 96, SQL 98 and
SQL 118): each function's language, volatility, parallel safety, SECURITY DEFINER, result,
proconfig, body hash and EXECUTE ACL; each policy's command, roles, permissive flag and expression
hashes; each table's columns, constraints, indexes, RLS flags, policy and trigger lists and
non-owner ACL; or `absent`. Intended
`4d50013eb0b30808a2a13a97b4a1700b33a833a943bbad865627b77aaf836729`
(`releaseIntendedHash('sql141', file bytes)`, re-derived by
`aws/tests/release-sql141-executor.test.mjs` and read back on PostgreSQL 16 after one apply).

**Expected pre-state (both environments; not recorded anywhere yet, each pin records its own
environment's read).** Every object absent:

```
release sql141 v1
function public.aws_vendor_payee_add(uuid, text): absent
function public.aws_vendor_payee_remove(uuid, uuid): absent
function public.aws_platform_owner_set_tenant_vendor(uuid, boolean): absent
policy public.vendor_tenants aws_select_vendor_tenants: absent
policy public.tenant_vendor_payees aws_select_tenant_vendor_payees: absent
table public.vendor_tenants: absent
table public.tenant_vendor_payees: absent
```

`16522f0a99f22410a73e4a80e10e48a10a08162171345d72e0f72bc47338982f`, derived by
`aws/tests/release-sql141-executor.test.mjs` and read back from a PostgreSQL 16 database without
the objects. The value is not written into a pin before a run reads it.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`public.tenants`, `public.tenant_users`, `public.tenant_partner_code_aliases`
and their named columns, `auth.uid()`, `public.aws_user_tenant_ids()`, `public.is_platform_owner()`,
the roles `checksops` and `authenticated`: the file's own prerequisite block);
`definer_can_write_relations` for `public.tenants` and `public.tenant_partner_code_aliases` (the login
owns them with no FORCE ROW LEVEL SECURITY, or is a superuser or BYPASSRLS: the file's own
`sql141_definer_cannot_read` rule, since `aws_vendor_payee_add` reads both past row security);
`created_tables_absent_or_intended`; `functions_owned_by_login`, `function_results_match` and
`function_acl_replaceable` for a function that already exists. No predecessor.

Post-conditions: the intended fingerprint; the two tables and three functions owned by the login;
everything else in schema `public` (and the functions of `auth`) unchanged, the new objects
excepted. The tools roll back otherwise.

## Order

No predecessor and no order. No Lambda or SPA change goes with it: the send-endpoint change that
pays a vendor through a payee link, and any API route that calls the three functions, are separate
reviewed changes. No later migration replaces these objects.

## Steps

1. Staging: the staging executor must carry SQL 141 first (executor package refresh through the
   guarded staging executor `inspect` then `deploy` mode, its own reviewed run). Then run the
   guarded staging SQL executor with `read-live` for `sql141-permanent-vendor-payees`. Expected:
   `already_applied` false, `precondition_failures` `[]`, `live_definition_sha256` `16522f0a…`
   (above). If it reports `already_applied` true, record the run as the staging evidence (nothing to
   apply). If it reports `prerequisites_missing` other than `[]`, `precondition_failures` other than
   `[]` or another pre-state, stop. Otherwise record `LIVE_DEFINITION_SHA256` in the staging pin
   (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in a reviewed
   change, `apply` with the owner's approval of that run, then `read-live` again (expected
   `already_applied` true).
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql141 … --phase inspect`,
   or the tool's `--inspect`); record `production_inspect`. If `already_applied` is true, the
   reviewed change records it as verified live and leaves `execute: false`. Otherwise copy
   `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs in
   `staging_acceptance`, and set an owner-approved `authorization` and `execute: true`, in one
   reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql141 --approval-scope sql141 … --phase inspect`, then the owner-named
   `--phase apply` with the owner's words (authorization phrase `APPLY_PERMANENT_VENDOR_PAYEES`).
4. Record the apply and retire the pin (`execute: false`).
