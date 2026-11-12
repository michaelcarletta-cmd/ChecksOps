# Production SQL 153 (the flat $5 for a check's 2nd mortgage company)

| key | file | what it does |
|---|---|---|
| `sql153` | `aws/workflows/sql/153_second_mortgagee_fee.sql` (sha256 `57a87e37c153ee27c445cc188752fb493c41e92e144a81043d50e317a9150aec`, authored by `5ab496456`) | Refuses without its prerequisites (`55000 sql153_prerequisite_missing`); then (1) a live CHECK on `check_billing_events.event_type`, if any, rewritten from its live values plus `mortgage_ops_second_mortgagee` (**not modelled; the tooling requires none**), (2) the unique index `check_billing_events_one_second_mortgagee_per_check`, (3) two integer columns on `tenant_maintenance_payments`. |

**Why.** Owner 2026-11-10/11: "For 2 mortgage companies in check charge $5 for the additional mortgage company", "Flat
$5", "it should be an additional $5 if 2 mortgage companies are on check". Since SQL 148 a check made out to two
mortgage companies has two Mortgage Desk requests; the Mortgage Ops charge is one per check (SQL 84), so the 2nd
company's accept recorded nothing. SQL 153 (#1761) adds what the API needs to record a flat 500-cent
`mortgage_ops_second_mortgagee` event for the 2nd company's accept, once per check, and the invoice breakdown columns.
Owner 2026-11-11 for this tooling: "Option B" (model the index and the columns, and require that no `event_type` CHECK
exists, through one new engine precondition).

**What it does.**
- Step 1, **not modelled by the release engine.** If `check_billing_events` carries a CHECK on `event_type`, the file
  reads the values that live constraint holds at apply time and replaces it with those values plus
  `mortgage_ops_second_mortgagee` (a multi-column or unrecognised CHECK is refused,
  `55000 sql153_event_type_check_unrecognized`). That post-state depends on the live database, so no spec entry can fix
  it. The repository defines no such CHECK, so the tooling requires none: the read-only catalog count
  `event_type_checks` (every CHECK of `check_billing_events` whose columns include `event_type`, the file's own
  selection) must be `0` (precondition `no_event_type_check`), reported by read-live and inspect before any apply. On
  every database this tooling applies to, step 1 is therefore a no-op. A database with such a CHECK is a stop that
  needs its own reviewed change.
- Step 2: `check_billing_events_one_second_mortgagee_per_check`, unique on `(check_intake_item_id)` WHERE
  `event_type = 'mortgage_ops_second_mortgagee' AND status IS DISTINCT FROM 'voided' AND check_intake_item_id IS NOT
  NULL` (after refusing duplicates, `23505 sql153_duplicate_second_mortgagee_events`; a different index of that name is
  `55000 sql153_index_invalid`).
- Step 3: `tenant_maintenance_payments.mortgage_ops_second_mortgagee_count` and
  `mortgage_ops_second_mortgagee_amount_cents`, `integer NOT NULL DEFAULT 0`, no column grant.

Not changed: no function, trigger, policy, grant or row; SQL 84's and SQL 98's indexes; the 1st company's rates. The
`COMMENT ON` statements are not fingerprinted. No API, Lambda or SPA change is part of this pin: the API records the new
event only once the index exists, so the Lambda and this file may go live in either order, each through its own guarded
path.

**Order.** No predecessor. The file's header builds on SQL 84, SQL 98 and SQL 148 for the API behaviour the fee joins;
the file needs none of their objects (only its own prerequisites, which predate them). SQL 84's per-check index is not a
prerequisite: production satisfies SQL 84's gate with `check_billing_events_mortgage_ops_check_uidx`, not the fallback
name.

**Status:** applied to staging (wave 49) and to production (2026-11-12); the production pin is retired
(`execute: false`).

**Staging read-live (2026-11-11).** Run 43115484335 (job 130842257054, main `830cc142c`, the executor current at
`c6gk7wkTC53JMVUwDbybhUyFA0aMTppBC3HT5ImCxfU=` after deploy run 43113284610; the inspect run 43113078593 had found it not current),
under the owner's words "redeploy the staging SQL executor, then run the SQL 153 staging read-live": `already_applied`
false, `precondition_failures` `[]`, `prerequisites_missing` `[]`, `counts.event_type_checks` 0 (the `no_event_type_check`
precondition passes), the index `check_billing_events_one_second_mortgagee_per_check` and both
`tenant_maintenance_payments` columns `absent`. Live `b2bf6d325a5a50683acc8ecdaef39ec763b591f8db9f10e7d6fe02f9525cb0c3`, equal to the derived state; intended `376feae9…`.
The deploy run 43113284610 was another workstream's (SQL 156) from the same main commit; no second deploy was needed.
Recorded in the staging pin (`expected_live_definition_sha256`, `execute: true`, wave 49) under the owner's words of
2026-11-11, "record the SQL 153 staging pin" and "merge it when green". The staging apply is a separate run after this pin
is merged and the executor is redeployed carrying it, on the owner's words for that run. The production pin stays pending.

**Staging executor refreshed for the pin (2026-11-11).** The staging pin (wave 49, PR #1792) merged as
`acbb4c505d290c93ba0b213bd34a34f405c9a594`. Inspect run 43118569370 found the live executor at
`c6gk7wkTC53JMVUwDbybhUyFA0aMTppBC3HT5ImCxfU=`, with only `lib/sql-executor-auth.mjs` superseded. Deploy run 43118921219 updated
`checksops-staging-guarded-sql-executor` to `0idw/ztvop2oY03bUiFFf8uAdEBIjoC1lg+ZadYvPts=`, `errors` `[]`.

**Staging apply (2026-11-11).** Apply run 43119289402 (job 130855320219, main `acbb4c505`, workstream
`github-staging-sql-43119289402`, `expected_live_definition_sha256` `b2bf6d325a5a50683acc8ecdaef39ec763b591f8db9f10e7d6fe02f9525cb0c3`) under the owner's words "apply SQL 153 in
staging": success. The receipt prints `result` `applied`, `before_hash` `b2bf6d32…`, `after_hash`
`376feae9f0a6405c54dcb65f65e4119a967da4a34506b75ba1e65d98cad699ac`; the index and both columns `intended`. Read-live run 43119679139 (job
130856648244): `already_applied` true, `live_definition_sha256` `376feae9…` equal to the intended hash, `precondition_failures`
`[]`, `prerequisites_missing` `[]`, `counts.event_type_checks` 0. The owner gave the run approval "apply SQL 153 in staging"; no
separate staging acceptance statement was given. There is no separate staging record PR for SQL 153: these staging runs are
recorded here and in the production pin's `staging_acceptance` by the production pin PR.

**Production inspect (2026-11-11).** Read-only `--inspect` through SSM
`decbb3ce-3b38-49ec-ae6f-ea07d39de7ba` on `i-0c35557c4e5385406` (under the owner's words "the read-only SQL 153 production
inspect"; runner started by the owner 23:42:53Z, command ran 23:45:53Z to 23:45:57Z, Success, runner stopped by the owner
23:47:36Z), main `103060468` (tarball sha256 `501cd3dc3c1d5fb9c3cfff6d5dc11deae2690a4808227f41f94935372aef8268`, staged by
`sql53-temporary-transfer.yml` run 43121960735, migration source `57a87e37…` == pin), `read_only` true: live `b2bf6d325a5a50683acc8ecdaef39ec763b591f8db9f10e7d6fe02f9525cb0c3`
(the index and both columns absent, the derived pre-state), no predecessor, `prerequisites_missing` `[]`,
`counts.event_type_checks` 0, `already_applied` false, `live_matches_expected` false, `precondition_failures` `[]`,
`apply_preconditions_met` false, `errors` `[]`. Production's pre-state equals staging's (read-live run 43115484335), so the
staging apply took the path production will. Recorded in the production pin with the staging apply (run 43119289402) as its
staging acceptance and `execute: true` under the owner's words "record the SQL 153 production pin". The owner merges the pin
change; the apply runs only after that merge is on main and staged, under the owner's words for that run.

**Production apply (2026-11-12).** After the pin change (#1795, on the staging apply run 43119289402; merged to main as
`6e07b0e12` on the owner's words "merge it when green"), transfer run 43124761254 staged main `6e07b0e12` (tarball sha256
`85ae3788104387a50727efc5e2f0c8812a796ca24a869bda06e06b91f3325392`, the run's `TARBALL_SHA256` line, equal to the sidecar it
uploaded). The runner `i-0c35557c4e5385406` was started at 00:05:16Z. Under the owner's words "apply SQL 153 in production"
(passed verbatim), a one-shot `--phase inspect` (SSM `b959aa07-079f-4f20-bc5a-02f41c448a7a`, run
`fbcb872c-3745-4545-b815-e1711e9e6a76`, nothing written) read live `b2bf6d32…` (the pinned pre-state,
`live_matches_expected` true, `precondition_failures` `[]`, `event_type_checks` 0); then one-shot `--phase apply` run
`3b141a01-2675-404b-ae40-374927fa272a` through SSM `1051cd92-cbda-43ec-bf8d-e8905f22727a`, workstream
`prod-sql153-second-mortgagee-fee-20261112`, one_use_id `sql153-prod-5e0bfc05-c697-474c-8a9f-96077c325144`: contracts 4/4,
6/6 and 43/43; all 11 steps ok; manifest `e3a83d06…`; receipt `b2bf6d32…` →
`376feae9f0a6405c54dcb65f65e4119a967da4a34506b75ba1e65d98cad699ac` (intended), result `applied`, unrelated catalog
`96ce1f13…`; post-apply inspect `already_applied` true, `precondition_failures` `[]`, `prerequisites_missing` `[]`, both
`tenant_maintenance_payments` columns and the index `check_billing_events_one_second_mortgagee_per_check` `intended`. The
run's whole output arrived (19544 characters). The runner was stopped at 00:08:24Z ("User initiated"). The $5 accrual in
`mortgage-ops-usage.mjs` (Lambda rebuild) and the fee-schedule row on the website are not deployed by this record.
Production acceptance had not been reported by the owner when this record was written; this record does not claim it.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql153` in
`release-sql-specs.mjs`). Intended `376feae9f0a6405c54dcb65f65e4119a967da4a34506b75ba1e65d98cad699ac`:

```
release sql153 v1
column public.tenant_maintenance_payments.mortgage_ops_second_mortgagee_count: integer notnull=true default=5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9 acl=
column public.tenant_maintenance_payments.mortgage_ops_second_mortgagee_amount_cents: integer notnull=true default=5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9 acl=
index public.check_billing_events check_billing_events_one_second_mortgagee_per_check: 37b8de5e3eb57aa0e59e3fe4363aff2c3ac403ad482b28b01c56a290b545ce93
```

The index line hashes its collapsed `pg_get_indexdef`:

```
CREATE UNIQUE INDEX check_billing_events_one_second_mortgagee_per_check ON public.check_billing_events USING btree (check_intake_item_id) WHERE ((event_type = 'mortgage_ops_second_mortgagee'::text) AND (status IS DISTINCT FROM 'voided'::text) AND (check_intake_item_id IS NOT NULL))
```

The fingerprint does not cover step 1: no CHECK on `event_type` is required before (precondition) and, since step 1 is
then a no-op, none exists after; the post-apply snapshot of every other constraint in `public` must be unchanged.

**Expected pre-state (both environments).** The index and both columns absent:

```
release sql153 v1
column public.tenant_maintenance_payments.mortgage_ops_second_mortgagee_count: absent
column public.tenant_maintenance_payments.mortgage_ops_second_mortgagee_amount_cents: absent
index public.check_billing_events check_billing_events_one_second_mortgagee_per_check: absent
```

That is `b2bf6d325a5a50683acc8ecdaef39ec763b591f8db9f10e7d6fe02f9525cb0c3` (`releaseStateHash('sql153', {})`). Each pin records its own environment's read; neither value is written
into a pin before a run reads it. A pre-state other than this one is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present`; `no_event_type_check` (`counts.event_type_checks` must be `0`; an unreadable count fails
closed); `altered_relations_owned_by_login` on `check_billing_events` and `tenant_maintenance_payments`;
`added_indexes_absent_or_intended` and `added_columns_absent_or_intended`.

Post-conditions: the intended fingerprint; everything else in schema `public` unchanged (constraints included). The tools
roll back otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 153 and the engine's `no_event_type_check` first (executor package
   refresh through the guarded staging executor `deploy` mode, its own reviewed run). Then `read-live` for
   `sql153-second-mortgagee-fee`. Expected `already_applied` false, `precondition_failures` `[]`,
   `prerequisites_missing` `[]`, `counts.event_type_checks` `0`, live `b2bf6d32…`. Otherwise stop. Record
   `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`, owner-approved `authorization`,
   `execute: true`) in a reviewed change, `apply`, then `read-live` again.
2. Production: with the owner's OK for that read, the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql153 … --phase inspect`); record
   `production_inspect` (with `counts`), copy `live_definition_sha256` into `expected_live_definition_sha256`, record the
   staging runs in `staging_acceptance`, set an owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs --migration sql153
   --approval-scope sql153 … --phase apply` with the owner's words (authorization phrase
   `CHARGE_SECOND_MORTGAGEE_FEE`).
4. Record the apply and retire the pin (`execute: false`).
5. Then the API (the accrual and the invoice lines) through the guarded Lambda overlay path, with its own approval.

Rollback (not part of this pin; a reviewed step of its own if ever needed): drop the index and the two columns.
