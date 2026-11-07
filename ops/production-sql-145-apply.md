# Production SQL 145 (the platform owner's fee collection records its leg)

| key | file | what it does |
|---|---|---|
| `sql145` | `aws/workflows/sql/145_platform_owner_billing_collection_leg.sql` (sha256 `ea57a69cf7f2000157898590c5bfbe5224ff1f135b599e82bb18018a8d22cc77`) | Refuses without the payment transfer and fee obligation schema (the columns the collection leg writes, the unique index `payment_transfers_idempotency_uniq`), `is_platform_owner()`, `auth.uid()`, SQL 136's `aws_money_write_allowed()` and role `checksops` (`55000 sql145_prerequisite_missing`), or when the applying login could not write `payment_transfers` or read `tenant_maintenance_payments` as a DEFINER owner past RLS (`55000 sql145_definer_cannot_write`). Then `CREATE OR REPLACE` of the new `aws_platform_owner_insert_billing_collection_leg(...)` (`plpgsql`, `VOLATILE`, `SECURITY DEFINER`, `search_path = public, pg_temp`, `RETURNS public.payment_transfers`), `REVOKE ALL ... FROM PUBLIC` (and from `anon`, `authenticated`, `service_role` where they exist) and `GRANT EXECUTE ... TO checksops` on it. No other statement. |

**Why.** The platform owner collects tenant fees manually from Tenant Management (SQL 98, owner
decision 2026-10-17). After Moov accepts a leg, the API (`aws/functions/api/tenant-collection-v2.mjs`,
`createPostgresCollectionStore` `putLeg`, savepoint `collection_insert_leg`) inserts the leg's
`payment_transfers` row with `tenant_id` = the billed tenant. Since SQL 90 (applied in production
2026-10-19) no permissive INSERT policy on `payment_transfers` admits the platform owner for a tenant
it is not a member of: `aws_write_payment_transfers` (`aws/rls/sql/24`) checks
`aws_can_write_tenant(tenant_id)`, which SQL 90 reduced to membership, and SQL 72's
`aws_member_insert_payment_transfers` checks `tenant_id IN (SELECT aws_user_tenant_ids())`. SQL 136's
restrictive `aws_money_write_gate_insert_payment_transfers` passes (the API sets the money-write flag
inside the savepoint). Production log (read-only), `/aws/lambda/checksops-production-prep-api`
2026-11-06T22:53:11Z: `billing_pull_statement_failed`, statement `collection_insert_leg`, sqlstate
`42501`, routine `ExecWithCheckOptions`, `new row violates row-level security policy for table
"payment_transfers"` (Freedom Adjustment's 2026-10 fee; the platform owner is not a member of
Freedom). The obligation was marked `submitted` with the Moov transfer id and the note `· leg_persist_failed ·
moov_idempotent_replay`; no `payment_transfers` row was written. Freedom's 2026-09 leg (2026-09-29,
before SQL 90) was written by the same statement under the pre-SQL 90 `aws_can_write_tenant`
(`aws/rls/sql/20`: the platform owner allowed). `aws/tests/sql145-platform-owner-billing-collection-leg-pg.test.mjs`
reproduces both on PostgreSQL 16. Owner 2026-11-07: "build the fee leg fix".

**What it changes.** One new SECURITY DEFINER writer instead of a policy (a permissive INSERT policy
for the platform owner would let its session insert any `payment_transfers` row for any tenant; SQL
90 keeps platform-owner writes only where a listed duty needs them, through narrow DEFINER functions
such as SQL 98's `aws_platform_owner_record_billing_audit`):
`aws_platform_owner_insert_billing_collection_leg(_tenant_id uuid, _environment text, _status text,
_idempotency_key text, _amount_cents bigint, _description text, _source_tenant_account_id text,
_wallet_id uuid, _leg_role text, _provider_transfer_id text, _provider_status text, _failure_reason
text, _provider_metadata jsonb)`, exactly the values the API's statement writes, in its order:

- caller: `auth.uid()` present and `is_platform_owner()`, else `42501
  billing_collection_leg_forbidden`; a server write path (`aws_money_write_allowed()`, SQL 136's
  one gate), else `42501 billing_collection_leg_not_server_write`;
- row: a tenant-collection-v2 leg: `leg_role` `wallet` or `ach_debit`; `provider_metadata` an object
  with `collection_contract` `tenant-collection-v2`, `leg_type` = `leg_role`, `billing_period`
  `YYYY-MM`; `idempotency_key` exactly `billing-<period>-<tenant_id>-wallet` or `-bank`; environment
  `production` or `sandbox`; status `due`, `submitted` or `settled`; `amount_cents > 0`; else `22023
  billing_collection_leg_invalid: ...`;
- obligation: `provider_metadata.obligation_id` is a `tenant_maintenance_payments` row of the same
  tenant and period, and `amount_cents` plus the tenant's other leg for the period (unless failed,
  returned, reversed or canceled) is at most its `amount_cents`, else `22023`;
- the API's INSERT (provider `moov`, `platform_fee_cents` 0, `net_amount_cents` = `amount_cents`,
  speed `standard`, `submitted_at` now) with its `ON CONFLICT (tenant_id, idempotency_key)` update of
  `provider_transfer_id`, `provider_status`, `status` and `updated_at`, only over the same kind of leg
  (`23505 billing_collection_leg_conflict` otherwise); returns the row.

EXECUTE: revoked from `PUBLIC`, `anon`, `authenticated` and `service_role`; granted to `checksops`
(the API login). The owner keeps its own. No generic RPC route lists it (`data.mjs` `READ_RPCS`,
`workflow-rpc.mjs` `SAFE_WRITE_RPCS`).

Not changed: no table, column, index, policy, RLS setting, table grant, trigger or row; no other
function. A tenant member's own writes (SQL 24 / SQL 72) are unchanged, and a non-member's direct
INSERT is still refused. No API, Lambda or SPA change is part of this file or its pins: the API change
(`tenant-collection-v2.mjs` calls the function in the `collection_insert_leg` savepoint) goes out
through the guarded Lambda path after SQL 145 is applied in that environment. Until then, or if the
API were live first, a platform-owner collection leg fails to save exactly as today (logged, rolled
back to its savepoint, obligation `submitted` with `leg_persist_failed`).

**Not covered.** The collector's later `UPDATE public.payment_transfers` of an existing leg
(savepoint `collection_update_leg`) is also refused to the platform owner by RLS: it updates no row
and keeps the existing one (no error). Leg status after submission is written by SQL 109's webhook
writer, which is unaffected.

**Predecessor.** None in the release engine. SQL 136 must be applied first (its
`aws_money_write_allowed()` is a prerequisite; production 2026-11-02).

**Staging executor refreshed (2026-11-07).** Deploy run 42330773622 updated
`checksops-staging-guarded-sql-executor` to carry SQL 145 (inspect run 42330595651 read CodeSha256
`KrioYjGBZOUHgb5JuAvXaZQ50YidnBpvl0yjn8B5pHc=` before it, inspect run 42330985103
`1IQ9upfm2JjUv9dq7jQi+AUcAGvKwr9EYHhBFe4LA94=` after it).

**Staging read-live (2026-11-07).** Run 42331198486 (job 128277868446, main `ddb8b1d50`, after executor deploy
run 42330773622): `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`,
`definer_writes` both `ok true`. Live `c622469dcfbfc0ad8f54c0bb038457b9eb3247a17ee0c855390ddc709ee1d594`: the
function absent, everything else in place, equal to the derived pre-state; intended `a44d93bd…`. Recorded in the
staging pin (`expected_live_definition_sha256`, `execute: true`, wave 40) under the owner's words of 2026-11-07,
"record the SQL 145 staging pin". The staging apply is a separate run after this pin is merged and the executor is
redeployed carrying it, on the owner's words for that run, "apply SQL 145 in staging". The production pin stays
pending: a read-only production inspect decides production's pre-state.

**Staging executor refreshed for the pin (2026-11-07).** The staging pin (wave 40, PR #1684) merged as
`b65d091a2925d046b3f160bbdbfc37ff4f8659af`. Inspect run 42333302061 (main `b65d091a2`) found the live executor at
`1IQ9upfm2JjUv9dq7jQi+AUcAGvKwr9EYHhBFe4LA94=`. Deploy run 42333499880 (`expected_executor_code_sha256`
`1IQ9upfm…` matched) updated `checksops-staging-guarded-sql-executor`; inspect run 42333743067 read it at
`GEDJLmf19hpNpWdBJBrSWeUgZAwnZbdO898Rp7ErM0k=`. Read-live run 42333924185 (executor `GEDJLmf1…`): `already_applied`
false, `precondition_failures` `[]`, live `c622469d…`, equal to the pin.

**Staging apply (2026-11-07).** Apply run 42334108246 (job 128287029859, 2026-11-07T03:27:40Z, main `b65d091a2`,
workstream `github-staging-sql-42334108246`, pin commit `e15aef7cc`, `expected_live_definition_sha256`
`c622469dcfbfc0ad8f54c0bb038457b9eb3247a17ee0c855390ddc709ee1d594`) under the owner's words "apply SQL 145 in
staging": success. The receipt prints `result` `applied`, `before_hash` `c622469d…`, `after_hash`
`a44d93bddc3a90149ec2eaa9279d4695193db8f5eb190463f239d7cb130f435a`; the function in state `intended`, its EXECUTE
ACL `checksops` and the owner, `definer_writes` ok on both relations. Read-live run 42334267158 (executor
`GEDJLmf1…`): `already_applied` true, `live_definition_sha256` `a44d93bd…` equal to the intended hash,
`precondition_failures` `[]`. Staging acceptance: the owner on 2026-11-07, "SQL 145 accepted in staging". There
is no separate staging record PR for SQL 145: these staging runs are recorded here and in the production pin's
`staging_acceptance` by the production pin PR. The staging pin keeps `execute: true`. The API change that calls
the function (`tenant-collection-v2.mjs`, savepoint `collection_insert_leg`) is not part of this pin.

**Production inspect (2026-11-07).** Read-only `--inspect` through SSM
`f359138f-4605-4b46-b4fa-cd807fbd3af6` on `i-0c35557c4e5385406` (under the owner's words "run the read-only SQL 145
production inspect"; runner started 03:19:27Z, stopped 03:20:14Z), main `b65d091a2` (tarball sha256
`12ac21a3f5af5c4801a06d7dfc7c8ea19edd1bfff34740c43c1bb7bb277dcc6e`, staged by `sql53-temporary-transfer.yml` run
42333377887, migration source `ea57a69c…` == pin), connected as `checksops_admin`: the function `absent`, its
EXECUTE ACL empty, `definer_writes` ok on both relations (`payment_transfers`, `tenant_maintenance_payments`);
`counts` null (the spec has none); every prerequisite present; `predecessors` `{}`, `successors_applied` `[]`; live
`c622469dcfbfc0ad8f54c0bb038457b9eb3247a17ee0c855390ddc709ee1d594`, `already_applied` false,
`precondition_failures` `[]`. Production's pre-state equals staging's (read-live runs 42331198486 and 42333924185),
so the staging apply took the path production will
(`aws/tests/sql145-platform-owner-billing-collection-leg-pg.test.mjs`). Recorded in the production pin with the
staging apply (run 42334108246) as its staging acceptance and `execute: true` under the owner's words "record the
SQL 145 production pin"; the owner's words so far name the staging steps, the staging acceptance, the inspect and
this pin, not the production apply. The owner merges the pin change; the apply still needs the owner's words for
that run ("apply SQL 145 in production") and runs only after that merge is on main and staged.

**Read-only fee obligation policy check (2026-11-07).** Before the apply, under the owner's words "yes, run the
read-only fee obligation policy check", a read-only catalog query (SSM `8a2063ee-4dbf-49fe-b35a-e3a767666621` on
`i-0c35557c4e5385406`, nothing written) read the production policies. `tenant_maintenance_payments` (row level
security on, not forced) has the permissive `aws_write_tenant_maintenance_payments` FOR ALL to `authenticated`, whose
USING and WITH CHECK allow `is_platform_owner()` (or the monthly billing job, or the provider webhook apply), plus the
restrictive `aws_money_write_gate_*` policies (`aws_money_write_allowed()`): the platform owner's obligation update on
a server write path is allowed. `payment_transfers`' permissive INSERT policies are membership-only
(`aws_write_payment_transfers` FOR ALL via `aws_can_write_tenant(tenant_id)`, and `aws_member_insert_payment_transfers`
via `aws_user_tenant_ids()`): the platform owner is not a member of the billed tenant, so the API's direct collection
leg INSERT is refused. That is the root cause SQL 145's SECURITY DEFINER writer addresses.

**Production apply (2026-11-07).** After the pin change (#1685, merged to main as `fda298fa3` on the owner's words
"merge 1685"), transfer run 42364538127 staged main `fda298fa3` (tarball sha256
`bf0cd2e1b166ef4398085bdc149f1a3c4f50628bc332285a04d0a76613f96725`). Under the owner's words
"apply SQL 145 in production" (passed verbatim), a one-shot `--phase inspect` (SSM
`a05bd401-5731-4e5e-88c2-1698529d496f`, run `bc75684f-874a-4327-a71c-1ff01752ac0d`, nothing written) read live
`c622469d…` (the pinned pre-state, `live_matches_expected` true, `apply_preconditions_met` true,
`precondition_failures` `[]`, the function absent, `definer_writes` ok on both relations);
then one-shot `--phase apply` run `8d17051e-163f-43c6-a2d7-0f174fb6c2dd` through SSM
`937dcbbd-13f5-4f27-8a27-c522bbd34813`, workstream `prod-sql145-platform-owner-billing-collection-leg-20261107`,
one_use_id `sql145-prod-4c3e24cf-8250-4e96-bf49-b8121ca5b8bd`: its own inspect step read the same pre-state; contracts
4/4, 6/6 and 43/43; all 11 steps ok; manifest `19a72725…`; receipt `c622469d…` →
`a44d93bddc3a90149ec2eaa9279d4695193db8f5eb190463f239d7cb130f435a` (intended), result `applied`, unrelated
catalog `fdf7d3cb…` (policies 479, functions 1360); post-apply inspect `already_applied` true,
`precondition_failures` `[]`: the function `aws_platform_owner_insert_billing_collection_leg(...)` `intended`, its
EXECUTE ACL `checksops` and the owner, `definer_writes` ok on both relations, `counts` null, `prerequisites_missing`
`[]`. The run's JSON arrived whole (20586 characters of SSM output, under the 24000-character limit; read back
read-only from SSM get-command-invocation). The runner `i-0c35557c4e5385406` was started for this work at 10:36:00Z
and stopped at 10:36:54Z. The API change that calls the function (`tenant-collection-v2.mjs`, REPLACE `45a78f0e…` →
`f22fd96b…`) is not part of this pin and is not deployed by this record: the overlay plan now records SQL 145 verified
live, so that member's guarded production apply passes its SQL gate, and it still needs its own read-only inspect and
the owner's words "DEPLOY tenant-collection-v2.mjs TO PRODUCTION". Production acceptance had not been reported by the
owner when this record was written; this record does not claim it.

**Status:** applied to staging (wave 40) and to production (2026-11-07); the production pin is retired
(`execute: false`).

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql145` in `release-sql-specs.mjs`). Intended
`a44d93bddc3a90149ec2eaa9279d4695193db8f5eb190463f239d7cb130f435a`:

```
release sql145 v1
function public.aws_platform_owner_insert_billing_collection_leg(uuid, text, text, text, bigint, text, text, uuid, text, text, text, text, jsonb): lang=plpgsql vol=v parallel=u secdef=true result=public.payment_transfers config=search_path=public, pg_temp prosrc=29e23b41bd80973e5e567e217e51afa7f96e4885e946f01e7a8705e0bc6af7b0 acl=checksops EXECUTE;owner EXECUTE
```

**Expected pre-state (both environments).** The function absent, everything else in place:

```
release sql145 v1
function public.aws_platform_owner_insert_billing_collection_leg(uuid, text, text, text, bigint, text, text, uuid, text, text, text, text, jsonb): absent
```

That is `c622469dcfbfc0ad8f54c0bb038457b9eb3247a17ee0c855390ddc709ee1d594`, derived by
`aws/tests/release-sql145-executor.test.mjs`. Each pin records its own environment's read; neither
value is written into a pin before a run reads it. A pre-state other than this one is not by itself a
stop, but its per-function report and ACL must be read and explained before it is recorded.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`payment_transfers` with the twenty columns the function writes or reads and
its unique index `payment_transfers_idempotency_uniq`, `tenant_maintenance_payments` (`id`,
`tenant_id`, `amount_cents`, `billing_period`), `is_platform_owner()`, `aws_money_write_allowed()`,
`auth.uid()`, role `checksops`); `definer_can_write_relations` on both relations (the applying login
owns each without `FORCE ROW LEVEL SECURITY`, or is a superuser or `BYPASSRLS`: a DEFINER insert
filtered by RLS would be refused as the API's is today); and, where the function already exists (a
re-run), `functions_owned_by_login`, `function_results_match` (the `public.payment_transfers` result)
and `function_acl_replaceable` (no EXECUTE grant outside `checksops` and the owner, which the file
keeps, and `PUBLIC`, `anon`, `authenticated` and `service_role`, which it revokes).

Post-conditions: the intended fingerprint; the function owned by the login; everything else in schema
`public` unchanged. The tools roll back otherwise.

## Steps

1. Staging: the staging executor must carry SQL 145 first (executor package refresh through the
   guarded staging executor `deploy` mode, its own reviewed run). Then run the guarded staging SQL
   executor with `read-live` for `sql145-platform-owner-billing-collection-leg`. Expected:
   `already_applied` false, `precondition_failures` `[]`, `definer_writes` both `ok true`,
   `live_definition_sha256` `c622469d…` (above). If it reports `prerequisites_missing` other than `[]`
   or `precondition_failures` other than `[]`, stop. Otherwise record `LIVE_DEFINITION_SHA256` in the
   staging pin (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in
   a reviewed change, `apply`, then `read-live` again.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql145 … --phase inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging runs in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql145 --approval-scope sql145 … --phase apply` with the owner's words
   (authorization phrase `APPLY_PLATFORM_OWNER_BILLING_COLLECTION_LEG`).
4. Record the apply and retire the pin (`execute: false`).
5. Only then deploy the API change (`tenant-collection-v2.mjs`, the guarded production API overlay,
   staging first); until then a platform-owner collection leg fails to save as it does today.
