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

**Status:** applied to staging (wave 45) and to production (2026-11-11); the production pin is retired
(`execute: false`).

**Staging read-live (2026-11-11).** Run 42945948226 (job 130278663761, main `6d19dad33`, after executor deploy run
42945571224, inspect run 42945146098), under the owner's words "apply SQL 152 in staging": `already_applied` false,
`precondition_failures` `[]`, `prerequisites_missing` `[]`, `definer_writes` `check_billing_events` `ok true`. Live
`99c391367eaf941dae2a89cf78d72ae87fff5559d2fc3c26ad7acc691f1a4a5e`: everything absent (SQL 120 applied), equal to the derived pre-state; intended `6cf7d044…`. Recorded in the
staging pin (`expected_live_definition_sha256`, `execute: true`, wave 45) under the owner's words of 2026-11-11, "record
the SQL 152 staging pin and merge it when green". The staging apply is a separate run after this pin is merged and the
executor is redeployed carrying it, on the owner's words "apply SQL 152 in staging". The production pin stays pending:
a read-only production inspect decides production's pre-state.

**Staging executor refreshed for the pin (2026-11-11).** The staging pin (wave 45, PR #1762) merged as
`34e4d6983c37b47c06fdfd633d97880ec0a61112`. Inspect run 43004433326 found the live executor at
`FJ474P+p2chkkq3XerWtY1De6apzeuYAA83Qq1515mw=`, with only `lib/sql-executor-auth.mjs` superseded. Deploy run 43004839952
updated `checksops-staging-guarded-sql-executor` to `EkfZ5s51spdj4LsXDhjT7DJsnUUmZ5/SPhplnpjZ6Wk=` (revision
`8b1f98cc-3e9c-4abe-9c67-f1a8b611a30e`), `errors` `[]`.

**Staging apply (2026-11-11).** Apply run 43005316840 (job 130471228593, main `34e4d6983`, workstream
`github-staging-sql-43005316840`, `expected_live_definition_sha256` `99c391367eaf941dae2a89cf78d72ae87fff5559d2fc3c26ad7acc691f1a4a5e`) under the owner's words "apply SQL 152 in
staging": success. The receipt prints `result` `applied`, `before_hash` `99c39136…`, `after_hash`
`6cf7d044d2db1e3e14f44815a573348b4180345d8fecc67079a95d480378ffce`; every object in state `intended`. Read-live run
43005694458 (job 130472501828): `already_applied` true, `live_definition_sha256` `6cf7d044…` equal to the intended hash,
`precondition_failures` `[]`, `prerequisites_missing` `[]`. The owner gave the run approval "apply SQL 152 in staging";
no separate staging acceptance statement was given. There is no separate staging record PR for SQL 152: these staging
runs are recorded here and in the production pin's `staging_acceptance` by the production pin PR.

**Production inspect (2026-11-11).** Read-only `--inspect` through SSM
`15087959-5dfe-463d-950a-267eb2039905` on `i-0c35557c4e5385406` (under the owner's words "Yes if that is next", answering
whether to run the read-only production check; runner started 10:49:10Z, command sent 10:49:50Z, Success 10:49:54Z,
runner stopped 10:50:27Z), main `9bbe1d2a1` (tarball sha256
`cf7f2f6761277b065bdeb4e8fd94bc16e38cf8d85d756867bbea116e5cb442ec`, staged by `sql53-temporary-transfer.yml` run
43006547022, migration source `b646207d…` == pin), `read_only` true: live `99c391367eaf941dae2a89cf78d72ae87fff5559d2fc3c26ad7acc691f1a4a5e` (everything absent, the
derived pre-state), no predecessor, `prerequisites_missing` `[]`, `already_applied` false, `live_matches_expected` false,
`precondition_failures` `[]`, `apply_preconditions_met` false, `definer_writes` `check_billing_events` ok, `errors` `[]`.
Production's pre-state equals staging's (read-live run 42945948226), so the staging apply took the path production will.
Recorded in the production pin with the staging apply (run 43005316840) as its staging acceptance and `execute: true`
under the owner's words "record the SQL 152 production pin". The owner merges the pin change; the apply runs only after
that merge is on main and staged, under the owner's words for that run.

**Production apply (2026-11-11).** After the pin change (#1763, on the staging apply run 43005316840; merged to main as
`b5a354925` on the owner's words "merge it when green and apply SQL 152 in production"), transfer run 43009615137 staged
main `b5a354925` (tarball sha256 `8a6588ad8b8cd90c50c610be63ed4e9316aaab1975031499643b9e9208ebdd29`). The runner
`i-0c35557c4e5385406` was started at 11:16:43Z; three AWS-managed SSM commands were already in progress on it
(`AWS-ConfigureAWSPackage`, `AmazonInspector2-ConfigureInspectorSsmPlugin`,
`AmazonInspector2-ConfigureInspectorSsmPluginLinux`); they were reported to the owner, who answered "Proceed". Under the
owner's words "merge it when green and apply SQL 152 in production" (passed verbatim), a one-shot `--phase inspect` (SSM
`bd06cdd2-a497-47a5-b35a-e87f3c1b09de`, run `468607d9-8ea0-486d-944d-823cefbb6891`, nothing written) read live
`99c39136…` (the pinned pre-state, `live_matches_expected` true, `precondition_failures` `[]`); then one-shot
`--phase apply` run `02469480-67b5-4d0c-b451-12b1ad103907` through SSM `cae61362-0534-417e-b45c-a8d6175ce3a2`, workstream
`prod-sql152-invoice-and-failed-deposit-fees-20261111`, one_use_id `sql152-prod-a441e0c6-5be7-468e-b45a-5ea23bd1ba89`:
contracts 4/4, 6/6 and 43/43; all 11 steps ok; manifest `8b3a1570…`; receipt `99c39136…` →
`6cf7d044d2db1e3e14f44815a573348b4180345d8fecc67079a95d480378ffce` (intended), result `applied`, unrelated catalog
`63f88a7f…`; post-apply inspect `already_applied` true, `precondition_failures` `[]`, `prerequisites_missing` `[]`, the
table, the five functions (EXECUTE for the owner only), the two triggers, the index and the four columns `intended`,
`definer_writes` `check_billing_events` ok. The runner was stopped at 11:18:09Z. The run's JSON did **not** arrive whole:
the SSM output is capped at 24000 characters and was cut inside the printed `applied.receipt`. The top-level `details`
arrived whole, so the record takes `receipt` and `post_apply_inspect` from `details.apply_result` and
`details.post_apply_inspect`; the rest of the printed `applied` object and anything printed after it (the run's
`not_observed_by_this_run`, warnings, errors) were not observed. `tenant-fee-invoice-email.mjs` (sql_before SQL 152) is
not deployed by this record. Production acceptance had not been reported by the owner when this record was written; this
record does not claim it.

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
