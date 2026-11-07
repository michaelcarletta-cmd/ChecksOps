# Production SQL 144 (an organization reads the payments sent into its wallet)

| key | file | what it does |
|---|---|---|
| `sql144` | `aws/workflows/sql/144_tenant_incoming_transfers.sql` (sha256 `9192e338ea4e54d2690e0ebde71754292394c52f1bac09c3af5fd3fb4b309865`) | Refuses without the payment transfer, tenant, check sharing and check schema and the access helpers (`55000 sql144_prerequisite_missing`) or when the applying login could not reach one of the five relations as a DEFINER owner past RLS (`55000 sql144_definer_cannot_reach`). Then `CREATE OR REPLACE` of the new `get_tenant_incoming_transfers(uuid)` (`plpgsql`, `STABLE`, `SECURITY DEFINER`, `search_path = public, pg_temp`, `RETURNS TABLE(...)`), `REVOKE ALL ... FROM PUBLIC` (and from `anon`, `authenticated`, `service_role` where they exist) and `GRANT EXECUTE ... TO checksops` on it. No other statement. |

**Why.** A send from the Funds tab (`aws/functions/api/providers/production/moov-send.mjs`) writes its
`payment_transfers` legs (`leg_role` `send_wallet` / `send_bank`) under the sender's `tenant_id`, with
`destination_tenant_id` = the partner organization it pays. The AWS select policy
`aws_select_payment_transfers` (`aws/rls/sql/12_final_select_policies.sql`) lets a member read only
rows whose `tenant_id` is their own; the Supabase-era policy "Members read own tenant transfers"
(supabase migration `20260727224957`) also let the payee organization read inbound rows, and that
clause was not carried over. Nothing is written under the recipient's `tenant_id` (no transfer, split,
ledger or claim payment row), so a partner that received money sees it nowhere: not in Recent Wallet
Activity, Funds Received or Payments & Financials. Read-only production facts 2026-11-06
(owner-approved read): Freedom Adjustment's send of 2026-11-06T19:06:01Z to Condition One (check
`a15dfd40`) is two legs, both `tenant_id` Freedom, `destination_tenant_id` Condition One, status
`submitted`; nothing exists under Condition One's `tenant_id`. Owner 2026-11-06: "yes build it, include
partner payments as income not tax."

**What it changes.** One new read function, `get_tenant_incoming_transfers(_tenant_id uuid)`, instead
of a select policy, so the recipient never reads the sender's row (`provider_metadata` carries the
sender's step-up id, facilitator, source payment methods and request hash):

- caller gate: `_tenant_id` present and `aws_can_access_tenant(_tenant_id)` (a member of that
  organization or a cross-tenant reader, the rule the API's RPC gate applies), else `42501
  incoming_transfers_forbidden`;
- rows: `payment_transfers` with `destination_tenant_id = _tenant_id`, `tenant_id <> _tenant_id`,
  `leg_role` `send_wallet` or `send_bank`, status `submitted`, `pending`, `processing`, `completed` or
  `returned` (a bounced payment shows as returned; `draft`, `ready`, `submitting`, `unknown`, `failed`
  and `canceled` legs never reached the recipient); newest first, at most 1000;
- columns: id, `amount_cents`, status, speed, environment, `leg_role`, `created_at`, `submitted_at`,
  `completed_at`, `check_id`, the sender's tenant id and name; never `provider_metadata`,
  description, payment method, wallet, idempotency or provider ids;
- check and claim context (check number, carrier, property address, funds type, check amount, claim
  id, detected claim number, payee line, claim number, policyholder name) only when the sender shares
  the check with `_tenant_id` (`shared_checks` row with `source_tenant_id` = the sender,
  `target_tenant_id = _tenant_id`, `revoked_at IS NULL`) or the caller is the platform owner;
  otherwise `NULL`.

EXECUTE: revoked from `PUBLIC`, `anon`, `authenticated` and `service_role`; granted to `checksops`
(the API login, `aws/functions/api/data.mjs` `READ_RPCS` with the tenant gate). The owner keeps its
own, as SQL 126 leaves the Supabase-era definer reads.

Not changed: no table, column, policy, RLS setting, table grant, trigger or row; no other function
(`get_tenant_funds_received` keeps its body and ACL). The sender's own reads are unchanged. No API,
Lambda or SPA change is part of this file or its pins: the API change that exposes the function
(`data.mjs`) and the website change that reads it tolerate its absence (the call fails, the screens
show what they show today) and go out through the guarded Lambda and SPA paths after SQL 144 is
applied in that environment.

**Predecessor.** None.

**Staging executor refreshed (2026-11-06).** Deploy run 42303787295 updated
`checksops-staging-guarded-sql-executor` to carry SQL 144.

**Staging read-live (2026-11-06).** Run 42304378701 (job 128189899238, main `b5912204f`, after executor deploy
run 42303787295): `already_applied` false, `precondition_failures` `[]`. Live
`428d394e88ce45840806f7a6c93ed63d40178c0376c8a70843197bf28dccb88e`: the function absent, everything else in
place, equal to the derived pre-state; intended `ac458869…`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 39) under the owner's words of 2026-11-06, "record the SQL
144 staging pin". The staging apply is a separate run after this pin is merged and the executor is redeployed
carrying it, on the owner's words for that run, "apply SQL 144 in staging". The production pin stays pending: a read-only production inspect decides
production's pre-state.

**Staging executor refreshed for the pin (2026-11-06).** The staging pin (wave 39, PR #1672) merged as
`b69e34cbf6182b4bb186dad278a8636c16182368`. Inspect run 42308138229 (main `b69e34cbf`) found the live executor at
`zEi7sZK4ieD6444PwQTyXSaTnbgqoMW4ny4hYf7mqNs=`. Deploy run 42308408155 (`expected_executor_code_sha256`
`zEi7sZK4…` matched) updated `checksops-staging-guarded-sql-executor`; inspect run 42308688967 read it at
`KrioYjGBZOUHgb5JuAvXaZQ50YidnBpvl0yjn8B5pHc=`. Read-live run 42308958516 (executor `KrioYjGB…`): `already_applied`
false, `precondition_failures` `[]`, live `428d394e…`, equal to the pin.

**Staging apply (2026-11-06).** Apply run 42309284075 (job 128206439607, 2026-11-06T23:04:01Z, main `b69e34cbf`,
workstream `github-staging-sql-42309284075`, pin commit `87c3e193b`, `expected_live_definition_sha256`
`428d394e88ce45840806f7a6c93ed63d40178c0376c8a70843197bf28dccb88e`) under the owner's words "apply SQL 144 in
staging": success. The receipt prints `result` `applied`, `before_hash` `428d394e…`, `after_hash`
`ac458869cda99ec85cb42e31f5ba80ced29cbf227a81058379e086b0ffb924c2`; the function in state `intended`, its EXECUTE
ACL `checksops` and the owner, `definer_writes` ok on all five relations. Read-live run 42309552553 (executor
`KrioYjGB…`): `already_applied` true, `live_definition_sha256` `ac458869…` equal to the intended hash,
`precondition_failures` `[]`. Staging acceptance: the owner on 2026-11-06, "SQL 144 accepted in staging". There
is no separate staging record PR for SQL 144: these staging runs are recorded here and in the production pin's
`staging_acceptance` by the production pin PR. The staging pin keeps `execute: true`. The API change that exposes
the function and the website change that reads it are not part of this pin.

**Production inspect (2026-11-06).** Read-only `--inspect` through SSM
`98a2ab2e-d8e0-4756-a6ab-142b0e7acf32` on `i-0c35557c4e5385406` (under the owner's words "run the read-only SQL 144
production inspect"; runner started 23:44:35Z, stopped 23:45:18Z), main `cf2d6d0cf` (tarball sha256
`be408a6dabb9d4ddc64be0437da3538611a8f3057966ba6b3c0ca2947e6b197e`, staged by `sql53-temporary-transfer.yml` run
42313753127, migration source `9192e338…` == pin), connected as `checksops_admin`: the function `absent`, its
EXECUTE ACL empty, `definer_writes` ok on all five relations (`payment_transfers`, `tenants`, `shared_checks`,
`check_intake_items`, `claims`); `counts` null (the spec has none); every prerequisite present; `predecessors`
`{}`, `successors_applied` `[]`; live `428d394e88ce45840806f7a6c93ed63d40178c0376c8a70843197bf28dccb88e`,
`already_applied` false, `precondition_failures` `[]`. Production's pre-state equals staging's (read-live runs
42304378701 and 42308958516), so the staging apply took the path production will
(`aws/tests/sql144-tenant-incoming-transfers-pg.test.mjs`). Recorded in the production pin with the staging apply
(run 42309284075) as its staging acceptance and `execute: true` under the owner's words "record the SQL 144
production pin"; the owner's words so far name the staging steps, the staging acceptance, the inspect and this pin,
not the production apply. The owner merges the pin change; the apply still needs the owner's words for that run
("apply SQL 144 in production") and runs only after that merge is on main and staged.

**Production apply (2026-11-07).** After the pin change (#1674, merged to main as `a3a4bbdf7` on the owner's words
"merge 1674"), transfer run 42315882342 staged main `a3a4bbdf7` (tarball sha256
`dd249ae5c824062b57cf17595f018cd1bc6b2b80dcbc6e4f66ba55c661f9db6e`). Under the owner's words
"apply SQL 144 in production" (passed verbatim), a one-shot `--phase inspect` (SSM
`2c4b80a8-81ea-4e0b-95d7-c5d78db18fe7`, run `dd8a2b8f-a837-44aa-90f3-d0971a67f540`, nothing written) read live `428d394e…` (the pinned pre-state,
`live_matches_expected` true, `apply_preconditions_met` true, `precondition_failures` `[]`, the function absent,
`definer_writes` ok on all five relations);
then one-shot `--phase apply` run `2c228f5d-61f1-4e91-9268-ea906d5cce3d` through SSM
`0f602899-55d7-4e1b-a842-4fae04f72013`, workstream `prod-sql144-tenant-incoming-transfers-20261107`, one_use_id
`sql144-prod-254be0ae-db3c-4fbe-bd20-dafba25bb7ef`: its own inspect step read the same pre-state; contracts 4/4,
6/6 and 43/43; all 11 steps ok; manifest `8775bb7d…`; receipt `428d394e…` →
`ac458869cda99ec85cb42e31f5ba80ced29cbf227a81058379e086b0ffb924c2` (intended), result `applied`, unrelated
catalog `34648775…` (policies 479, functions 1359); post-apply inspect `already_applied` true,
`precondition_failures` `[]`: the function `get_tenant_incoming_transfers(uuid)` `intended`, its EXECUTE ACL
`checksops` and the owner, `definer_writes` ok on all five relations, `counts` null, `prerequisites_missing` `[]`.
The run's JSON arrived whole (20832 characters of SSM output, under the 24000-character limit). The runner
`i-0c35557c4e5385406` was started for this work at 00:05:13Z and stopped at 00:06:07Z. The API change that exposes
the function and the website change that reads it are not part of this pin and are not deployed by this record.
Production acceptance had not been reported by the owner when this record was written; this record does not claim
it.

**Status:** applied to staging (wave 39) and to production (2026-11-07); the production pin is retired
(`execute: false`).

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql144` in `release-sql-specs.mjs`). Intended
`ac458869cda99ec85cb42e31f5ba80ced29cbf227a81058379e086b0ffb924c2`:

```
release sql144 v1
function public.get_tenant_incoming_transfers(uuid): lang=plpgsql vol=s parallel=u secdef=true result=TABLE(id uuid, amount_cents bigint, status text, speed text, environment text, leg_role text, created_at timestamp with time zone, submitted_at timestamp with time zone, completed_at timestamp with time zone, check_id uuid, sender_tenant_id uuid, sender_name text, check_number text, carrier_name text, property_address text, funds_type text, check_amount numeric, claim_id uuid, detected_claim_number text, payee_line text, claim_number text, policyholder_name text) config=search_path=public, pg_temp prosrc=8b7e6eea47e6e6bbcf251e825ff21e7bc2aeeb22970d8fab96d1718034ec995f acl=checksops EXECUTE;owner EXECUTE
```

**Expected pre-state (both environments).** The function absent, everything else in place:

```
release sql144 v1
function public.get_tenant_incoming_transfers(uuid): absent
```

That is `428d394e88ce45840806f7a6c93ed63d40178c0376c8a70843197bf28dccb88e`, derived by
`aws/tests/release-sql144-executor.test.mjs`. Each pin records its own environment's read; neither
value is written into a pin before a run reads it. A pre-state other than this one is not by itself a
stop, but its per-function report and ACL must be read and explained before it is recorded.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`payment_transfers` with the twelve columns the function reads, `tenants`
(`id`, `name`), `shared_checks` (`check_id`, `source_tenant_id`, `target_tenant_id`, `revoked_at`),
`check_intake_items` and `claims` with the check context columns, `aws_can_access_tenant(uuid)`,
`is_platform_owner()`, role `checksops`); `definer_can_write_relations` on all five relations (the
applying login owns each without `FORCE ROW LEVEL SECURITY`, or is a superuser or `BYPASSRLS`: a
DEFINER read filtered by RLS would show the recipient nothing); and, where the function already exists
(a re-run), `functions_owned_by_login`, `function_results_match` (the `TABLE` result) and
`function_acl_replaceable` (no EXECUTE grant outside `checksops` and the owner, which the file keeps,
and `PUBLIC`, `anon`, `authenticated` and `service_role`, which it revokes).

Post-conditions: the intended fingerprint; the function owned by the login; everything else in schema
`public` unchanged. The tools roll back otherwise.

## Steps

1. Staging: the staging executor must carry SQL 144 first (executor package refresh through the
   guarded staging executor `deploy` mode, its own reviewed run). Then run the guarded staging SQL
   executor with `read-live` for `sql144-tenant-incoming-transfers`. Expected: `already_applied`
   false, `precondition_failures` `[]`, `definer_writes` all `ok true`, `live_definition_sha256`
   `428d394e…` (above). If it reports `prerequisites_missing` other than `[]` or
   `precondition_failures` other than `[]`, stop. Otherwise record `LIVE_DEFINITION_SHA256` in the
   staging pin (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in
   a reviewed change, `apply`, then `read-live` again.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql144 … --phase inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging runs in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql144 --approval-scope sql144 … --phase apply` with the owner's words
   (authorization phrase `APPLY_TENANT_INCOMING_TRANSFERS`).
4. Record the apply and retire the pin (`execute: false`).
5. Only then deploy the API change (`data.mjs`, the guarded production API overlay) and the website
   change; until then the call fails and the recipient's screens behave as before SQL 144.
