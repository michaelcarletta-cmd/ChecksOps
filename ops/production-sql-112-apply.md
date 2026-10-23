# Production SQL 112 (the Moov invoice table grants)

| key | file | what it does |
|---|---|---|
| `sql112` | `aws/workflows/sql/112_moov_invoice_table_grants.sql` (sha256 `497e23e9b158d7d8287244b315ee1135cafb6fc955af05c0e1c60d0c5c44c7e4`) | `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.moov_invoices` and `GRANT SELECT, INSERT ON TABLE public.moov_invoice_customers`, each to `checksops` and to `authenticated`, each only when the role exists (a table that is absent is skipped with a NOTICE). Nothing else: no TRUNCATE, no PUBLIC or anon grant, no RLS or policy change. |

**Why.** The production invoice handler
(`aws/functions/api/providers/production/moov-invoice.mjs`, live since 2026-10-23 through the
guarded overlay runs 39955069311 and 39955539299, #1185 / #1186 / #1187) reads and writes
`public.moov_invoices` (list, create, send, void, status refresh, delete a draft: SELECT, INSERT,
UPDATE, DELETE) and reads and inserts `public.moov_invoice_customers` (the payer's Moov customer
account). In this repository the only grants on those two tables are the supabase migration's
(`20260819015105`: SELECT, INSERT, UPDATE, DELETE to `authenticated`, ALL to `service_role`);
nothing grants `checksops`. PostgreSQL checks table privileges before row-level security, so a
missing line refuses `checksops` before any policy is evaluated (SQL 104 and SQL 105 closed the
same gap on the payment tables). The owner sent an invoice from Payments on 2026-10-23, so
production holds at least the lines a send uses; whether every pinned line is held (DELETE of a
draft, UPDATE on void and status refresh, INSERT of a customer) is unknown until the read-only
inspect. The release lock `moov-production-invoice` lists this inspect as its one missing
evidence item.

**Expected outcomes of the inspect.** Either `already_applied` true (every pinned line held:
nothing to apply; the inspect is recorded as the verified-live evidence and the pin stays
`execute: false`), or `already_applied` false with `precondition_failures` `[]` (some line
missing: the guarded apply path below adds it). Anything else (a precondition failure, a missing
table or role) stops and needs its own reviewed change.

**Status:** pending. No staging read-live, no production inspect, nothing applied.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`table_privileges` in `release-sql-specs.mjs`): the SELECT, INSERT, UPDATE and DELETE grants of
`checksops` and `authenticated` on `moov_invoices` and their SELECT and INSERT grants on
`moov_invoice_customers`, or `absent` per table. Intended
`7caba5ba4a322d54a3c55ca712966da58cf4358c0db81f95c142dabfc916f315`:

```
release sql112 v1
privileges public.moov_invoices SELECT,INSERT,UPDATE,DELETE: authenticated DELETE;authenticated INSERT;authenticated SELECT;authenticated UPDATE;checksops DELETE;checksops INSERT;checksops SELECT;checksops UPDATE
privileges public.moov_invoice_customers SELECT,INSERT: authenticated INSERT;authenticated SELECT;checksops INSERT;checksops SELECT
```

Other privileges of those roles (`authenticated`'s UPDATE and DELETE on `moov_invoice_customers`
where supabase granted them, TRUNCATE, …) and every other role's grants (`service_role`'s) are
outside the fingerprint; the post-condition `other_table_privileges_unchanged` requires them
unchanged on each table.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the two tables, roles `checksops` and `authenticated`);
`altered_relations_owned_by_login` (the login owns the two tables, so its GRANTs take effect).
No predecessor. A table that already holds some or all of its pinned lines passes: the file only
adds the missing ones; all held is `already_applied` true.

Post-conditions: the intended fingerprint; `other_table_privileges_unchanged`; everything else in
schema `public` (and the functions of `auth`) unchanged, the two tables' ACLs excepted. The
tools roll back otherwise.

## Order

No predecessor and no order. The invoice handler is already live in production; SQL 112 only
closes whatever grant gap the inspect finds. No later migration revokes these grants.

## Steps

1. Staging: the staging executor must carry SQL 112 first (executor package refresh through
   `sql-executor-ensure.mjs` / the guarded staging executor `deploy` mode, its own reviewed run).
   Then run the guarded staging SQL executor with `read-live` for
   `sql112-moov-invoice-table-grants`. If it reports `already_applied` true, record the run as
   the staging evidence (nothing to apply). If it reports `already_applied` false and
   `precondition_failures` `[]`, record `LIVE_DEFINITION_SHA256` in the staging pin
   (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in a
   reviewed change, `apply` with the owner's approval of that run, then `read-live` again
   (expected `already_applied` true). Anything else: stop and record it in its own reviewed
   change.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/sql112-moov-invoice-table-grants-production-apply.mjs --inspect`,
   or the one-shot's `--phase inspect`); record `production_inspect`. If `already_applied` is
   true, the reviewed change records it as verified live and leaves `execute: false` (and the
   release lock's missing-evidence item can be closed). Otherwise copy `live_definition_sha256`
   into `expected_live_definition_sha256`, record the staging runs in `staging_acceptance`, and
   set an owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql112 --approval-scope sql112 … --phase inspect`, then the owner-named
   `--phase apply`.
4. Record the apply and retire the pin (`execute: false`).
