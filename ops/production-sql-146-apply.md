# Production SQL 146 (the Moov status catch-up locks its rows and writes a fee leg's status)

| key | file | what it does |
|---|---|---|
| `sql146` | `aws/workflows/sql/146_moov_status_catch_up_writes.sql` (sha256 `327ee73d4ce01a4b2050c98accb439588fcddb20ed2d645ca62922e13431bc8c`) | Refuses without the payment transfer and fee obligation schema (the columns the two functions read and write), `is_platform_owner()`, `auth.uid()`, SQL 91's `aws_moov_webhook_apply_active()` and role `checksops` (`55000 sql146_prerequisite_missing`), or when the applying login could not lock or write `payment_transfers` and `tenant_maintenance_payments` as a DEFINER owner past RLS (`55000 sql146_definer_cannot_write`). Then `CREATE OR REPLACE` of the new `aws_moov_catch_up_lock_rows(text, text, uuid[])` and `aws_moov_apply_collection_leg_status(text, text, bigint, text, text, text, timestamptz)` (both `plpgsql`, `VOLATILE`, `SECURITY DEFINER`, `search_path = public, pg_temp`, `RETURNS jsonb`), `REVOKE ALL ... FROM PUBLIC` (and from `anon`, `authenticated`, `service_role` where they exist) and `GRANT EXECUTE ... TO checksops` on both. No other statement. |

**Why.** The Moov status catch-up (`aws/functions/api/providers/moov-status-catch-up.mjs`,
`ops/moov-status-catch-up.md`) runs as one reviewed platform-owner actor (`request.app_user_id`,
`is_platform_owner()`). Production 2026-11-07: the read-only plan, run 42395703811
(`production-moov-status-catch-up.yml`, phase plan), listed 9 candidates, 6 to apply, manifest
`236f3dd28e0e108219f75e566acbac4bb60a80ddfb8e673b1df0c6422c8b2331`. The apply, run 42395949680 (owner
approved verbatim), re-planned to the same manifest, then the first transfer (5768ab44, a `send_wallet`
leg) refused with `catch_up_state_changed_since_plan`, `found {legs: {}, obligations: {}}`, rolled back;
`productionRecordsMutated` false. Nothing was written.

Root cause, reproduced on PostgreSQL 16 with the repository's policies, SQL 90's membership-only
helpers and production's live `tenant_maintenance_payments` policies
(`aws/tests/sql146-moov-status-catch-up-writes-pg.test.mjs`): the plan reads through the SELECT
policies, which admit the platform owner (`aws_is_cross_tenant_reader()`). The apply locks with
`SELECT ... FOR UPDATE`; PostgreSQL applies the UPDATE policies' USING clause to a locking SELECT and
drops the rows it refuses. `payment_transfers`' permissive UPDATE policies are membership-only since
SQL 90 (production 2026-10-19): `aws_write_payment_transfers` (`aws/rls/sql/24`,
`aws_can_write_tenant(tenant_id)`, membership) and SQL 72's `aws_member_update_payment_transfers`
(financial execution and membership). The platform owner is not a member of the tenants, so the lock
returns no row, with or without the money-write flag or the webhook apply context, while a member of
the tenant gets the row. (The first transfer has no obligation, so `obligations: {}` is expected there;
for the September fee the obligation lock is empty too, without the money-write flag, from SQL 136's
restrictive UPDATE gate.) Behind the lock two more statements would fail for the fee transfer
(b31c7752, `ach_debit` leg and Freedom's 2026-09 obligation): the settlement code's
`UPDATE public.payment_transfers` of the fee leg finds no row for the owner (no error), and its
`payment_event_log` INSERT is refused (`42501`; the INSERT policies are a member's (SQL 72), the
onboarding writer's and the webhook apply context's (SQL 91)), which aborts the transaction. Owner
2026-11-07: "build the catch-up update fix".

**The live webhook.** The SQL 109 writer the webhook (and the catch-up) uses for `wallet_funding`,
`send_wallet` and `send_bank` legs is SECURITY DEFINER and applies with no user (reproduced): the lock
cause does not reach it. The webhook's fee-collection settlement (`applyCollectionV2ProviderCompletion`
with no user) sees no `payment_transfers` or `tenant_maintenance_payments` row and answers
`no_billing_occurrence`, writing nothing: a separate gap (no user at all, not the membership-only UPDATE
policies), not changed here. Production has received no `transfer.*` webhook so far.

**What it changes.** Two new SECURITY DEFINER functions instead of a policy (an UPDATE policy for the
platform owner would let its session update any `payment_transfers` row of any tenant; SQL 90 keeps
platform-owner writes only where a listed duty needs them, through narrow DEFINER functions, as SQL 98,
102, 117, 118 and 145 do):

- `aws_moov_catch_up_lock_rows(_environment, _provider_transfer_id, _obligation_ids uuid[])`: only in the
  Moov webhook apply context (`aws_moov_webhook_apply_active()`, else `42501
  moov_catch_up_webhook_apply_required`) and only for the platform owner (`auth.uid()` and
  `is_platform_owner()`, else `42501 moov_catch_up_forbidden`); environment `production` or `sandbox`, a
  transfer id, at most 50 obligation ids (`22023 moov_catch_up_invalid`). Locks, in id order, `FOR
  UPDATE`, the transfer's `payment_transfers` rows (provider `moov`, that environment) and the named
  `tenant_maintenance_payments` rows, and returns `{legs: {id: status}, obligations: {id: status}}`.
  Writes nothing.
- `aws_moov_apply_collection_leg_status(_environment, _provider_transfer_id, _amount_cents, _status,
  _provider_status, _reason, _completed_at)`: only in the webhook apply context (`42501
  moov_collection_leg_webhook_apply_required`); with a signed-in user only the platform owner (`42501
  moov_collection_leg_forbidden`), with no user (the webhook route) the context alone; status `settled`,
  `failed` or `returned`, amount > 0 (`22023 moov_collection_leg_invalid`). The one `payment_transfers`
  row with that transfer id and environment, `FOR UPDATE`: `unknown_transfer`, `not_owned` (a SQL 109 leg,
  or not a tenant-collection-v2 leg) and `amount_mismatch` (Moov's confirmed amount differs) write
  nothing; otherwise never backwards (ranks submitted 1, pending 2, settled / completed 3, failed /
  canceled 4, returned / reversed 5): `applied`, `unchanged` or `stale`. On `applied` exactly
  `applyBillingProviderEvent`'s leg UPDATE: `status`, `provider_status`, `completed_at` (settled, kept
  when set), `failure_reason` (failed / returned), `updated_at`. No event row (the settlement code appends
  it), no money movement.

EXECUTE: revoked from `PUBLIC`, `anon`, `authenticated` and `service_role`; granted to `checksops`
(the API login). The owner keeps its own. No generic RPC route lists them (`data.mjs` `READ_RPCS`,
`workflow-rpc.mjs` `SAFE_WRITE_RPCS`).

The API change (`moov-status-catch-up.mjs`, not part of this file or its pins) sets the webhook apply
context, locks through the first function, runs the SQL 109 writer (which sets and clears the context
itself), sets the context again, writes a fee leg through the second function (only when the plan
predicted the leg changes and it is not a SQL 109 leg, with Moov's amount), runs the settlement code
(whose own UPDATE of the leg then finds no row, as before, and whose event row the SQL 91 webhook INSERT
policy admits), clears the context and checks the planned post-state. Plan binding, one transaction per
transfer and the stop on the first surprise are unchanged.

Not changed: no table, column, index, policy, RLS setting, table grant, trigger or row; no other
function (SQL 109's writer included). Tenant members' own writes are unchanged, and the owner's and a
non-member's direct UPDATEs are still filtered by RLS. Until SQL 146 is applied, the changed catch-up
refuses the first transfer (the lock function is absent, `42883`), rolls it back and stops; nothing is
written.

**Predecessor.** None in the release engine. SQL 91 must be applied first (its
`aws_moov_webhook_apply_active()` is a prerequisite; applied in production).

**Staging executor refreshed (2026-11-07).** Deploy run 42402669624 updated
`checksops-staging-guarded-sql-executor` to carry SQL 146 (inspect run 42402449898 read CodeSha256
`GEDJLmf19hpNpWdBJBrSWeUgZAwnZbdO898Rp7ErM0k=` before it, inspect run 42402878458
`EEc1vtaB6lKlkEXSe99icmontAnuPbZELXVbxZHn4Xg=` after it).

**Staging read-live (2026-11-07).** Run 42403055167 (job 128494797184, main `73610863c`, after executor deploy
run 42402669624): `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`,
`definer_writes` both `ok true`. Live `1ef789645da5ce865cbb095bea1eff6775a4bedc87251e8152f41a771e659c40`: both
functions absent, everything else in place, equal to the derived pre-state; intended `ef55e1fe…`. Recorded in the
staging pin (`expected_live_definition_sha256`, `execute: true`, wave 41) under the owner's words of 2026-11-07,
"record the SQL 146 staging pin". The staging apply is a separate run after this pin is merged and the executor is
redeployed carrying it, on the owner's words for that run, "apply SQL 146 in staging". The production pin stays
pending: a read-only production inspect decides production's pre-state.

**Staging executor refreshed for the pin (2026-11-07).** The staging pin (wave 41, PR #1693) merged as
`9772e808e6852ed0a05bdf43f7ceb54a2d23305c`. Inspect run 42405045010 (main `9772e808e`) found the live executor at
`EEc1vtaB6lKlkEXSe99icmontAnuPbZELXVbxZHn4Xg=`. Deploy run 42405240604 (`expected_executor_code_sha256`
`EEc1vtaB…` matched) updated `checksops-staging-guarded-sql-executor`; inspect run 42405445608 read it at
`lrvFKRHsbRwmEfAW0kgwr0rKEKOz7pp0MvZCVE7IVXo=`. Read-live run 42405651492 (executor `lrvFKRHs…`): `already_applied`
false, `precondition_failures` `[]`, live `1ef78964…`, equal to the pin.

**Staging apply (2026-11-07).** Apply run 42405866540 (job 128503304198, 2026-11-07T19:24:27Z, main `9772e808e`,
workstream `github-staging-sql-42405866540`, pin commit `9229c8f9e`, `expected_live_definition_sha256`
`1ef789645da5ce865cbb095bea1eff6775a4bedc87251e8152f41a771e659c40`) under the owner's words "apply SQL 146 in
staging": success. The receipt prints `result` `applied`, `before_hash` `1ef78964…`, `after_hash`
`ef55e1feace25188bff4890393be472deac6cdfe64e06951e53279f12641488b`; both functions in state `intended`, their EXECUTE
ACL `checksops` and the owner, `definer_writes` ok on both relations. Read-live run 42406066179 (executor
`lrvFKRHs…`): `already_applied` true, `live_definition_sha256` `ef55e1fe…` equal to the intended hash,
`precondition_failures` `[]`. Staging acceptance: the owner on 2026-11-07, "SQL 146 accepted in staging". There is no
separate staging record PR for SQL 146: these staging runs are recorded here and in the production pin's
`staging_acceptance` by the production pin PR. The staging pin keeps `execute: true`. The API change that calls the
functions (`providers/moov-status-catch-up.mjs`) is not part of this pin.

**Production inspect (2026-11-07).** Read-only `--inspect` through SSM
`df96f4d3-ef1c-4a02-9684-19bfaac45101` on `i-0c35557c4e5385406` (under the owner's words "run the read-only SQL 146
production inspect"; runner started 19:10:21Z, stopped 19:10:48Z), main `73610863c` (tarball sha256
`b0972af991125891631b907fa7bad83103c713d743b16001ccef96c01c09fa7f`, staged by `sql53-temporary-transfer.yml` run
42404785035, migration source `327ee73d…` == pin), connected as `checksops_admin`: both functions `absent`, their
EXECUTE ACLs empty, `definer_writes` ok on both relations (`payment_transfers`, `tenant_maintenance_payments`);
`counts` null (the spec has none); every prerequisite present; `predecessors` `{}`, `successors_applied` `[]`; live
`1ef789645da5ce865cbb095bea1eff6775a4bedc87251e8152f41a771e659c40`, `already_applied` false,
`precondition_failures` `[]`. Production's pre-state equals staging's (read-live runs 42403055167 and 42405651492),
so the staging apply took the path production will
(`aws/tests/sql146-moov-status-catch-up-writes-pg.test.mjs`). Recorded in the production pin with the
staging apply (run 42405866540) as its staging acceptance and `execute: true` under the owner's words "record the
SQL 146 production pin"; the owner's words so far name the staging steps, the staging acceptance, the inspect and
this pin, not the production apply. The owner merges the pin change; the apply still needs
the owner's words for that run ("apply SQL 146 in production") and runs only after that merge is on main and staged.

**Production apply (2026-11-07).** After the pin change (#1694, merged to main as `83d649ebd` on the owner's words
"merge 1694"), transfer run 42407947861 staged main `83d649ebd` (tarball sha256
`7ae1335f6ee9e7bcd83559953e447a330ef0e7e135eabe9f5a3c3a29871c22a7`). Under the owner's words
"apply SQL 146 in production" (passed verbatim), a one-shot `--phase inspect` (SSM
`66c50e8c-d812-4583-b276-4e4a176558ea`, run `1d09509b-dcd9-4741-abcb-db5de221f6fb`, nothing written) read live
`1ef78964…` (the pinned pre-state, `live_matches_expected` true, `apply_preconditions_met` true,
`precondition_failures` `[]`, both functions absent, `definer_writes` ok on both relations);
then one-shot `--phase apply` run `f405fe8f-6b4c-4a15-86e6-b4de25e013f1` through SSM
`63e932ed-022b-4286-b900-220d09b2733a`, workstream `prod-sql146-moov-status-catch-up-writes-20261107`,
one_use_id `sql146-prod-25d04563-c33f-49fa-a9b5-21d3db7316e5`: its own inspect step read the same pre-state; contracts
4/4, 6/6 and 43/43; all 11 steps ok; manifest `aa11c442…`; receipt `1ef78964…` →
`ef55e1feace25188bff4890393be472deac6cdfe64e06951e53279f12641488b` (intended), result `applied`, unrelated
catalog `8b21e277…` (policies 479, functions 1361); post-apply inspect `already_applied` true,
`precondition_failures` `[]`: both functions `aws_moov_catch_up_lock_rows(...)` and
`aws_moov_apply_collection_leg_status(...)` `intended`, their EXECUTE ACL `checksops` and the owner, `definer_writes`
ok on both relations, `counts` null, `prerequisites_missing` `[]`. The run's JSON arrived whole (22002 characters of
SSM output, under the 24000-character limit; read back read-only from SSM get-command-invocation). The runner
`i-0c35557c4e5385406` was started for this work at 19:49:13Z and stopped at 19:50:07Z. The API change that calls the
functions (`providers/moov-status-catch-up.mjs`, REPLACE `502995f6…` → `6083f54b…`) is not part of this pin and is not
deployed by this record: the overlay plan now records SQL 146 verified live, so that member's guarded production apply
passes its SQL gate, and it still needs its own read-only inspect and the owner's words
"DEPLOY providers/moov-status-catch-up.mjs TO PRODUCTION". Production acceptance had not been reported by the owner
when this record was written; this record does not claim it.

**Status:** applied to staging (wave 41) and to production (2026-11-07); the production pin is retired
(`execute: false`).

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql146` in `release-sql-specs.mjs`). Intended
`ef55e1feace25188bff4890393be472deac6cdfe64e06951e53279f12641488b`:

```
release sql146 v1
function public.aws_moov_catch_up_lock_rows(text, text, uuid[]): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public, pg_temp prosrc=aa2a9073652ff77d6b5ffe6c054b28bce6cd93975b19d885c0b519dd22f293fa acl=checksops EXECUTE;owner EXECUTE
function public.aws_moov_apply_collection_leg_status(text, text, bigint, text, text, text, timestamp with time zone): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public, pg_temp prosrc=118ec5c5c9f77a1d8effd18c93ce32366f15a755536359c0dfd9be3be3993af8 acl=checksops EXECUTE;owner EXECUTE
```

**Expected pre-state (both environments).** Both functions absent, everything else in place:

```
release sql146 v1
function public.aws_moov_catch_up_lock_rows(text, text, uuid[]): absent
function public.aws_moov_apply_collection_leg_status(text, text, bigint, text, text, text, timestamp with time zone): absent
```

That is `1ef789645da5ce865cbb095bea1eff6775a4bedc87251e8152f41a771e659c40`, derived by
`aws/tests/release-sql146-executor.test.mjs`. Each pin records its own environment's read; neither
value is written into a pin before a run reads it. A pre-state other than this one is not by itself a
stop, but its per-function report and ACL must be read and explained before it is recorded.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`payment_transfers` with the thirteen columns the functions read or write,
`tenant_maintenance_payments` (`id`, `status`), `is_platform_owner()`, `aws_moov_webhook_apply_active()`,
`auth.uid()`, role `checksops`); `definer_can_write_relations` on both relations (the applying login owns
each without `FORCE ROW LEVEL SECURITY`, or is a superuser or `BYPASSRLS`: a DEFINER lock or update
filtered by RLS would find no row, as the catch-up's own statements do today); and, where a function
already exists (a re-run), `functions_owned_by_login`, `function_results_match` (the `jsonb` result) and
`function_acl_replaceable` (no EXECUTE grant outside `checksops` and the owner, which the file keeps, and
`PUBLIC`, `anon`, `authenticated` and `service_role`, which it revokes).

Post-conditions: the intended fingerprint; both functions owned by the login; everything else in schema
`public` unchanged. The tools roll back otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 146 first (executor package refresh through the
   guarded staging executor `deploy` mode, its own reviewed run). Then run the guarded staging SQL
   executor with `read-live` for `sql146-moov-status-catch-up-writes`. Expected: `already_applied`
   false, `precondition_failures` `[]`, `definer_writes` both `ok true`, `live_definition_sha256`
   `1ef78964…` (above). If it reports `prerequisites_missing` other than `[]` or `precondition_failures`
   other than `[]`, stop. Otherwise record `LIVE_DEFINITION_SHA256` in the staging pin
   (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in a reviewed
   change, `apply`, then `read-live` again.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql146 … --phase inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging runs in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql146 --approval-scope sql146 … --phase apply` with the owner's words
   (authorization phrase `APPLY_MOOV_STATUS_CATCH_UP_WRITES`).
4. Record the apply and retire the pin (`execute: false`).
5. Only then deploy the API change (`providers/moov-status-catch-up.mjs` REPLACE, the guarded
   production API overlay, staging first, held behind SQL 146 in
   `ops/deployment-guard/production-api-overlay-plan.json`).
6. Then a new read-only catch-up plan (the old manifest is not reused), and an apply only on the owner's
   words for that plan's manifest.
