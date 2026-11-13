# Production SQL 162 (a partner learns which shared checks the sharing organization paid from by a send to someone else)

| key | file | what it does |
|---|---|---|
| `sql162` | `aws/workflows/sql/162_shared_check_source_sends.sql` (sha256 `5bfbe41150ef652ade8405f9e8c0733ac32dae04776e489d188f7ae9c39d0179`, authored by `9bb825a47`) | Refuses without its prerequisites (`55000 sql162_prerequisite_missing`) or unless the applying login can read `payment_transfers` and `shared_checks` past RLS (`55000 sql162_definer_cannot_reach`); then one new SECURITY DEFINER function, EXECUTE `checksops` and the owner only. |

**Why.** A send from the Funds tab (`aws/functions/api/providers/production/moov-send.mjs`) writes its
`payment_transfers` legs under the sender's `tenant_id` and leaves the check's `check_stage` alone. A check the sender
shares with a partner is the same `check_intake_items` row on both sides, so after such a send it is still `deposited`
for the partner. When the send pays the partner, the partner reads the leg through `get_tenant_incoming_transfers`
(SQL 144) and the check moves from its Deposited tab to Funds Received (#1833). When the send pays someone else (a
homeowner, a contractor, a mortgage company), the partner can read nothing about it: `aws_select_payment_transfers`
shows a member only its own `tenant_id`, and SQL 144 returns only legs addressed to the caller. The check stays under
the partner's Deposited although its funds were paid out. Owner 2026-11-12: "If you pay from a shared check using Send
from the Funds tab ... It should not send the partner check back to deposited"; asked which case is still open, "Sends
to someone other than the partner"; and "Yes for 1, 2, and run the inspect".

**What it does.**
- `get_shared_check_source_sends(uuid)` (plpgsql, STABLE, RETURNS TABLE): for the caller's organization
  (`aws_can_access_tenant(_tenant_id)`, the rule the API's RPC gate applies; anyone else is `42501
  shared_check_source_sends_forbidden`), one row per check and sharing organization for the checks actively shared
  with it (`shared_checks`: `target_tenant_id` the caller's organization, another `source_tenant_id`, `revoked_at IS
  NULL`) from which the sharing organization has a `payment_transfers` leg (`leg_role` `send_wallet` or `send_bank`;
  `status` `submitted`, `pending`, `processing` or `completed`) whose `destination_tenant_id` is not the caller's
  organization (an outside payee, `NULL`, included). Newest first, at most 5000.
- Columns: `check_id`, `source_tenant_id`, `last_sent_at` (the newest such leg's `created_at`). Never an amount, a
  payee, a destination, a status or a transfer id: the partner learns that the sharing organization paid out of a
  check it already reads, and when.
- Returned, failed, canceled, draft, ready, submitting and unknown legs do not count: that money did not leave, or
  came back.

Not changed: no existing function is replaced (`get_tenant_incoming_transfers` and `get_tenant_funds_received` keep
their bodies and ACLs); no table, column, policy, table grant, trigger or row. The db-readonly-validate trigger count is
not affected. No API, Lambda or SPA change is part of this pin: the API (`get_shared_check_source_sends` in
`aws/functions/api/data.mjs` `READ_RPCS` with the tenant gate) and the Check Command Center (such a check leaves the
partner's Deposited) ship afterwards through their own guarded paths.

**Status:** applied to staging (wave 53, 2026-11-13); production pin execute-authorized (owner-approved pin change of 2026-11-13,
"open the SQL 162 production pin PR"); not applied to production. The production apply still needs the owner's words for that run.

**Staging apply (2026-11-13).** After the staging pin (#1846) and executor deploy run 43338712621 (main `e4be20cc1`): read-live
run 43339473672 `eb3a2901…` (`matches_pinned_expected` true), apply run 43340146045 under the owner's words "apply SQL 162 in
staging" (receipt `eb3a2901…` → `77d36f63…`, result `applied`), read-live run 43340822402 `already_applied` true, EXECUTE
`checksops` and the owner.

**Production inspect (2026-11-13).** Read-only, under the owner's words "run the SQL 162 production inspect": transfer run
43342136278 staged main `e4be20cc1` (tarball `7e16d80c…`, the SQL 162 file on the runner `5bfbe411…` == the pin), SSM
`f8429f5d-5729-4a0e-980c-26a50f17dd20` on the runner (started 01:10:16Z, stopped 01:11:16Z): live `eb3a2901…` (the function
absent), `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`, `definer_writes` ok on both relations.

**Staging read-live (2026-11-13).** Run 43334326464 (main `d555e2977`, after executor inspect run 43332967295 and executor deploy
run 43333551422 (executor CodeSha256 `N2/NmXvZ…` -> `H1/nDiud…`)), under the owner's words "run the SQL 162 staging read":
`already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`; `get_shared_check_source_sends(uuid)`
absent; `payment_transfers` and `shared_checks` reachable by the definer. Live
`eb3a290173a156be3757f03c0217b4548bffe713f582cdc6f32b676e91317e4f`, equal to the derived pre-state; intended `77d36f63…`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 53) on the owner's words "open the SQL 162 staging pin PR". The
staging apply is a separate run after this pin is merged and the executor is redeployed carrying it, on the owner's words for
that run. The production pin stays pending.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql162` in
`release-sql-specs.mjs`). Intended `77d36f6375b21c5e383896c88b5e9eccccb9f7bb9d06801921575e14a8ae41ca`:

```
release sql162 v1
function public.get_shared_check_source_sends(uuid): lang=plpgsql vol=s parallel=u secdef=true result=TABLE(check_id uuid, source_tenant_id uuid, last_sent_at timestamp with time zone) config=search_path=public, pg_temp prosrc=9cb31719d1c2b0dd50df4a24253147b77e08d8943d5a680a3b4326f53845247d acl=checksops EXECUTE;owner EXECUTE
```

**Expected pre-state (both environments).** The function absent:

```
release sql162 v1
function public.get_shared_check_source_sends(uuid): absent
```

That is `eb3a290173a156be3757f03c0217b4548bffe713f582cdc6f32b676e91317e4f` (`releaseStateHash('sql162', {})`). Each pin records its own environment's read; neither value is written
into a pin before a run reads it. A pre-state other than this one is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present`; `function_acl_replaceable`, `functions_owned_by_login` and `function_results_match` (where
present); `definer_can_write_relations` on `payment_transfers` and `shared_checks` (the DEFINER function must reach
both past RLS as their owner; a read filtered by RLS would show the partner nothing).

Post-conditions: the intended fingerprint; everything else in schema `public` unchanged. The tools roll back otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 162 first (executor package refresh through the guarded staging executor
   `deploy` mode, its own reviewed run). Then `read-live` for `sql162-shared-check-source-sends`. Expected
   `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`, live `eb3a2901…`. Otherwise stop.
   Record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`, owner-approved `authorization`,
   `execute: true`) in a reviewed change, `apply`, then `read-live` again.
2. Production: with the owner's OK for that read, the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql162 … --phase inspect`); record
   `production_inspect`, copy `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs in
   `staging_acceptance`, set an owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs --migration sql162
   --approval-scope sql162 … --phase apply` with the owner's words (authorization phrase
   `SHOW_PARTNERS_SHARED_CHECK_SOURCE_SENDS`).
4. Record the apply and retire the pin (`execute: false`).
5. Then the API (the read RPC list) and the Check Command Center through the guarded Lambda overlay and SPA paths, each
   with its own approval.

Rollback (not part of this pin; a reviewed step of its own if ever needed): drop the function.
