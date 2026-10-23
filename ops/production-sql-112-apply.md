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

**Staging executor refreshed (2026-10-23).** Inspect run 39962715255 (main `c74e7264c`) found the
live executor at CodeSha256 `iqIKOKkH…` without SQL 112 (adds only
`sql/112_moov_invoice_table_grants.sql`, supersedes the three engine files, nothing dropped, no
collisions). Deploy run 39962977351 updated it to main's package (`7BwUlIAA…`).

**Staging read-live (2026-10-23).** Run 39963348904 (main `c74e7264c`): `checksops` holds `SELECT`
only on `moov_invoices` and on `moov_invoice_customers`; `authenticated` holds none of the pinned
lines; live `c606d5eda318a2336d5885b3675339ee98aed761c3aa620a7ced759b3c5eeb89`, `already_applied`
false, `precondition_failures` `[]`. Recorded in the staging pin (`expected_live_definition_sha256`,
`execute: true`, wave 13) under the owner's words of 2026-10-23, "applying SQL 112 for parity."

**Production inspect (2026-10-23).** Read-only `--inspect` through SSM
`a868258f-3cac-4fce-88a3-318be6133ca5` on `i-0c35557c4e5385406`, main `c74e7264c` (tarball sha256
`206ad6e30558855da82ef4713905046c8dd27bedc3e4fbca8f27ddffb647d868`, transfer run 39963652555, migration
source `497e23e9…` == pin): `checksops` already holds `SELECT`, `INSERT`, `UPDATE` and `DELETE` on
`moov_invoices` and `SELECT` and `INSERT` on `moov_invoice_customers` (plus `UPDATE` and `DELETE`
there, outside the fingerprint); `authenticated` holds none of the pinned lines. Live
`a61983121c4739f38084c66c6aaafcb67968b008526ff0c69459713280292acd`, `already_applied` false,
`precondition_failures` `[]`. So the invoice handler lacks no grant in production, and SQL 112 adds
only the `authenticated` lines there (as SQL 105 did on the payment tables). The owner chose to apply
it in both environments for parity; the production pin records this inspect in its own change after
the staging apply.

**Staging apply (2026-10-23).** After the staging pin change merged (#1189, main `784712e3f`),
inspect run 39966052661 found the executor without the new pin (`7BwUlIAA…`, supersedes
`lib/sql-executor-auth.mjs`); deploy run 39966318339 updated it (executor
`51tMc1XFEefi/QY53mzE16WAAlCZgCIJOMNNOWuR9K8=`). Read-live run 39966632712: live still `c606d5ed…`.
Apply run 39967007467: `applied`, `c606d5ed…` -> `7caba5ba…`, every pinned line held on both
tables, `other_write_grants` `[]`. Read-live run 39967300107: `already_applied` true.

**Production pin (2026-10-23).** Under the owner's words "applying SQL 112 for parity." the
production pin records the inspect above as its pre-state (`a6198312…`) and the staging apply run
39967007467 as owner-accepted substitute evidence (the pre-states differ: staging held `checksops
SELECT` only, production already holds every `checksops` line; both reach `7caba5ba…` from the same
bytes, and GRANT of a held privilege is a no-op), and sets `execute: true`. The owner reviews and
merges it; nothing is applied by it.

**Status:** applied to staging and to production (2026-10-23); the production pin is retired
(`execute: false` again; see "Production apply of SQL 112").

## Production apply of SQL 112 (2026-10-23)

The owner's statement of 2026-10-23 was "apply SQL 112 in production", passed verbatim (base64,
`--approval-statement-b64`). The one-shot cannot verify who said it, and the statement covered this
run only. `production-sql-one-shot.mjs --migration sql112 --approval-scope sql112` on
`i-0c35557c4e5385406`, operator `michaelcarletta-cmd`, workstream
`prod-sql112-moov-invoice-table-grants-20261023`, from main `4d2cf0c11` (tarball
`source-4d2cf0c119280c12a360400be657d6e43f2b7a64.tar.gz`, sha256 `49862a9b…`, transfer run
`39969627282`, `sql53-temporary-transfer.yml` dispatched on main after the #1190 merge; its package
job printed `TARBALL_SHA256 49862a9b106391ce61a04c4bec9040f3faf59fe0a6d935bf9df9bcb81e873d8f`, equal
to the uploaded `.sha256` sidecar).

- **Inspect phase:** SSM `a48aa853-2312-4b5f-a142-dcf06307d8e4` (2026-10-23T14:28:26Z), run_id
  `84dc3b92-6d90-4eda-b525-5f29b11270ed`, approval statement "applying SQL 112 for parity.": pin, source,
  inspect and contracts ok, nothing written; live `a6198312…` (live_matches_expected true),
  precondition_failures [].
- **Apply phase:** SSM `654fb07f-7c95-4828-ad95-7fce135f1d27` (2026-10-23T14:30:31Z to 14:30:49Z),
  run_id `3f3f7d9d-51df-458f-b9fe-49b4bc91f841`, one_use_id
  `sql112-prod-95240935-fac1-4d76-b727-7fd1f2f55bf4` (spent): every step ok (pin, source, inspect,
  contracts, manifest, source-recheck-before-preflight, preflight, evaluate,
  source-recheck-before-apply, apply (applied), post-apply-inspect); migration source `497e23e9…`
  (== pin); contracts claim-ledger 4/4, tenant-isolation 6/6, financial-write-protections 43/43;
  pre-apply inspect live `a6198312…`, predecessors `{}`, precondition_failures []; manifest
  `f8cc024e…`; receipt `a6198312…` -> `7caba5ba…`, result applied, unrelated catalog `9cf1140a…`
  (relations 890, columns 3535, constraints 2233, policies 404, functions 1320, indexes 654, triggers
  180, views 25, types 18, roles 29, role memberships 15); post-apply inspect live `7caba5ba…`,
  already_applied true, precondition_failures []. `moov_invoices` now grants `authenticated` and
  `checksops` SELECT, INSERT, UPDATE and DELETE; `moov_invoice_customers` grants both SELECT and
  INSERT (`checksops` UPDATE and DELETE there unchanged, `other_write_grants`).

No later read-only inspect was run. The pin is `execute: false` again; a re-apply needs a new
reviewed pin change. The release lock `moov-production-invoice` still lists the grants inspect as
its missing evidence; closing it is a separate reviewed lock change.

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
