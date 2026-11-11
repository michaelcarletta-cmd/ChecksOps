# Production SQL 152 (invoice fee and failed deposit fee usage events)

| key | file | what it does |
|---|---|---|
| `sql152` | `aws/workflows/sql/152_invoice_and_failed_deposit_fees.sql` (sha256 `b646207d09771e5b06f28702d1e442591282a434c5f4a9cdebfbb755384feeb8`) | Refuses without `check_billing_events` (with `source_kind`, `source_id`, `claim_id`, `event_type`), `checkalt_deposits`, `moov_invoices` (with `tenant_id`, `sent_at`, `claim_id`), `check_intake_items`, `tenant_maintenance_payments` and SQL 120's `aws_record_checkalt_billing_event()` (`55000 sql152_prerequisite_missing`). Then creates the one-row table `tenant_usage_fee_launch` (RLS on, every non-owner grant revoked, default-privilege grants included), five owner-only functions, the triggers `aws_moov_invoice_fee` on `moov_invoices` and `aws_checkalt_deposit_failed_fee` on `checkalt_deposits`, the partial unique index `check_billing_events_usage_source_uidx` and four integer columns on `tenant_maintenance_payments`. |

**Why.** The SaaS Subscription Agreement charges $0.30 per invoice sent (3.6) and $2.00 per failed deposit (3.7),
and nothing recorded either fee, so neither reached Settings -> Usage or the monthly invoice. Owner 2026-11-10:
"work on these fixes" (#1747 added SQL 149, the engine and SPA changes and the overlay plan entries). SQL 149
created `tenant_usage_fee_launch` and revoked only `PUBLIC`, so the table would have kept the grants the
database's default privileges give a new table: the defect that rolled back SQL 117's guarded staging apply (run
40434533070, `UNRELATED_MUTATION intended_state`), fixed by SQL 118. Found while building SQL 149's tooling,
before any run; owner 2026-11-11: "Yes" to SQL 152 (SQL 149 plus SQL 118's revoke block, #1758) and to this
tooling. SQL 149 is never applied and has no spec or pin.

**What it changes.**
- `tenant_usage_fee_launch` (singleton): `launched_at` is set once, at the first apply. Neither fee is charged
  for anything before it (no backfill). RLS on, no policy, no grant to anyone but the owner.
- `aws_invoice_fee_cents()` = 30 and `aws_failed_deposit_fee_cents()` = 200 (IMMUTABLE), `aws_usage_fee_launched_at()`
  (STABLE, SECURITY DEFINER), and the SECURITY DEFINER trigger functions `aws_record_invoice_fee()` and
  `aws_record_failed_deposit_fee()`, all EXECUTE for the owner only.
- `aws_moov_invoice_fee` (AFTER INSERT OR UPDATE OF sent_at ON moov_invoices): one `invoice_sent` event per invoice,
  when `sent_at` is first set and not before the launch.
- `aws_checkalt_deposit_failed_fee` (AFTER INSERT OR UPDATE OF status ON checkalt_deposits): one `failed_deposit`
  event per deposit that is rejected, errors, is a duplicate or is returned. SQL 120 still voids the check fee on
  rejected / error / duplicate.
- `check_billing_events_usage_source_uidx`: one fee per invoice and per deposit.
- `tenant_maintenance_payments`: `invoice_fee_count`, `invoice_fee_amount_cents`, `failed_deposit_count`,
  `failed_deposit_amount_cents` (integer NOT NULL DEFAULT 0, no column grant).

Not changed: no policy, no grant to any role, no existing function or trigger; no usage event is written by the
apply. The API members that read the new events (`tenant-fee-invoice-email.mjs`, held on SQL 152, and
`tenant-billing-engine.mjs`, held on SQL 151, which needs SQL 152) reach production only through the guarded
Lambda overlay, after this apply.

**Predecessor.** None (as SQL 120 for SQL 98): the prerequisites are the file's own, SQL 120's trigger function among
them. SQL 151 (the Starter Package) needs SQL 152 and must not be applied before it.

**Status:** not applied anywhere. The staging pin and the production pin are pending.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql152` in `release-sql-specs.mjs`). Intended
`6cf7d044d2db1e3e14f44815a573348b4180345d8fecc67079a95d480378ffce`:

```
release sql152 v1
function public.aws_usage_fee_launched_at(): lang=sql vol=s parallel=u secdef=true result=timestamp with time zone config=row_security=off;search_path=public prosrc=24f10c5b4e7761e09958aa4b671f5fc7b3727ca97047570eb847afe2a2889797 acl=owner EXECUTE
function public.aws_invoice_fee_cents(): lang=sql vol=i parallel=u secdef=false result=integer config=search_path=public prosrc=71ba1cffc0a8202d0fc3b4ffabccab12e1a267dd90a07c7c4f301db0806439a8 acl=owner EXECUTE
function public.aws_failed_deposit_fee_cents(): lang=sql vol=i parallel=u secdef=false result=integer config=search_path=public prosrc=94862cb5ee515029589c3630c35cf90ef732ba08d5f1d847e5ea41ffc1fa9be9 acl=owner EXECUTE
function public.aws_record_invoice_fee(): lang=plpgsql vol=v parallel=u secdef=true result=trigger config=row_security=off;search_path=public prosrc=922054d7028f92b359d37716e8586feb8bf40d1c2a2474f2a22a243f71f47fd6 acl=owner EXECUTE
function public.aws_record_failed_deposit_fee(): lang=plpgsql vol=v parallel=u secdef=true result=trigger config=row_security=off;search_path=public prosrc=eea19d68aade1628f5a6ef2adb70aa1c56d8e2c55ac24e6a335b0f0d8ac4dc32 acl=owner EXECUTE
table public.tenant_usage_fee_launch: kind=r rls=true forced=false
table public.tenant_usage_fee_launch column singleton: boolean notnull=true default=b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b acl=
table public.tenant_usage_fee_launch column launched_at: timestamp with time zone notnull=true default=28a4dae0461e17af56e979c2095abfbe0bfc45fe9ca8abf3144338a518a1bb8f acl=
table public.tenant_usage_fee_launch column note: text notnull=false default=- acl=
table public.tenant_usage_fee_launch constraint tenant_usage_fee_launch_pkey: d004b3efcdc4a0108ecbe83c93408f63eebecc563529a3941a4c59667835f25b validated=true
table public.tenant_usage_fee_launch constraint tenant_usage_fee_launch_singleton_check: 0a780c77dfabbc15def3d17957997d352de196c1233a0d25fccc97a40d2d6f41 validated=true
table public.tenant_usage_fee_launch index tenant_usage_fee_launch_pkey: 3e2f539be0e0418c92eeecf667c0bc4ab0b653e3aea355b9496fec798dd25ab0
table public.tenant_usage_fee_launch policies: 
table public.tenant_usage_fee_launch triggers: 
table public.tenant_usage_fee_launch acl: 
column public.tenant_maintenance_payments.invoice_fee_count: integer notnull=true default=5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9 acl=
column public.tenant_maintenance_payments.invoice_fee_amount_cents: integer notnull=true default=5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9 acl=
column public.tenant_maintenance_payments.failed_deposit_count: integer notnull=true default=5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9 acl=
column public.tenant_maintenance_payments.failed_deposit_amount_cents: integer notnull=true default=5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9 acl=
trigger public.moov_invoices aws_moov_invoice_fee: enabled=O def=a8e42c6afae42bd40e513052f01ebc693ad14b8cd8ca709775c29462729e2ea2
trigger public.checkalt_deposits aws_checkalt_deposit_failed_fee: enabled=O def=25dd0b020806a722588dcb64b0181f46d130210f03a50f04030fb9094def8387
index public.check_billing_events check_billing_events_usage_source_uidx: 6a9d21fbb8e1ce75fbb63623d923fd8ec60f5d79a9ed26dc4fb18fa2091ecfd1
```

**Expected pre-state (both environments).** None of SQL 152's objects present (SQL 120 applied):

```
release sql152 v1
function public.aws_usage_fee_launched_at(): absent
function public.aws_invoice_fee_cents(): absent
function public.aws_failed_deposit_fee_cents(): absent
function public.aws_record_invoice_fee(): absent
function public.aws_record_failed_deposit_fee(): absent
table public.tenant_usage_fee_launch: absent
column public.tenant_maintenance_payments.invoice_fee_count: absent
column public.tenant_maintenance_payments.invoice_fee_amount_cents: absent
column public.tenant_maintenance_payments.failed_deposit_count: absent
column public.tenant_maintenance_payments.failed_deposit_amount_cents: absent
trigger public.moov_invoices aws_moov_invoice_fee: absent
trigger public.checkalt_deposits aws_checkalt_deposit_failed_fee: absent
index public.check_billing_events check_billing_events_usage_source_uidx: absent
```

That is `99c391367eaf941dae2a89cf78d72ae87fff5559d2fc3c26ad7acc691f1a4a5e` (`releaseStateHash('sql152', {})`), read
back on PostgreSQL 16 by `aws/tests/release-sql152-executor.test.mjs`. Each pin records its own environment's read;
neither value is written into a pin before a run reads it. A pre-state other than this one is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present`; `altered_relations_owned_by_login` (`checkalt_deposits`, `moov_invoices`,
`check_billing_events`, `tenant_maintenance_payments` owned by the applying login); `definer_can_write_relations`
on `check_billing_events`; `created_tables_absent_or_intended`, `added_columns_absent_or_intended`,
`added_indexes_absent_or_intended`.

Post-conditions: the intended fingerprint (the new table with no grant to anyone, whatever the default privileges);
everything else in schema `public` unchanged. The tools roll back otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 152 first (executor package refresh through the guarded staging
   executor `deploy` mode, its own reviewed run). Then run the guarded staging SQL executor with `read-live` for
   `sql152-invoice-and-failed-deposit-fees`. Expected: `already_applied` false, `precondition_failures` `[]`,
   `prerequisites_missing` `[]`, `live_definition_sha256` `99c39136…` (above). Otherwise stop. Record
   `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`, owner-approved `authorization`,
   `execute: true`) in a reviewed change, `apply`, then `read-live` again.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql152 … --phase inspect`); record
   `production_inspect` and copy `live_definition_sha256` into `expected_live_definition_sha256`; record the
   staging runs in `staging_acceptance`; set an owner-approved `authorization` and `execute: true`, in one
   reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs --migration sql152
   --approval-scope sql152 … --phase apply` with the owner's words (authorization phrase
   `APPLY_INVOICE_AND_FAILED_DEPOSIT_FEES`).
4. Record the apply and retire the pin (`execute: false`); record SQL 152 live in the overlay plan and
   `staging-sql-live.json`.
5. Then `tenant-fee-invoice-email.mjs` through the guarded Lambda overlay, its own approval; the SQL 151 path follows.
