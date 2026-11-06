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

**Status:** staging pin execute-authorized (wave 39); not applied anywhere. The production pin is pending.

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
