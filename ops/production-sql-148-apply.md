# Production SQL 148 (a 2nd mortgagee while the 1st request is open, and the two requests linked)

| key | file | what it does |
|---|---|---|
| `sql148` | `aws/workflows/sql/148_second_mortgagee_link.sql` (sha256 `f87ea6d7b9284b86abf4fdd1aea8e219cdf51329b6a24ac73dc5cebcd64999c5`) | Refuses without `public.mortgage_handling_requests` and its seven columns the file names, SQL 90's `aws_can_write_tenant(uuid)`, `auth.uid()` and role `checksops` (`55000 sql148_prerequisite_missing`), or when the applying login does not own the table without `FORCE ROW LEVEL SECURITY` and is neither a superuser nor `BYPASSRLS` (`55000 sql148_definer_cannot_write`). Then redefines the unique index `mortgage_handling_requests_one_open_per_check` in place (`DROP INDEX` + `CREATE UNIQUE INDEX`, same name; refused for any live definition other than the Supabase one or its own, `55000 sql148_unexpected_index`, and while another unique index keys the table on `check_intake_item_id` alone, `55000 sql148_other_per_check_unique`), `CREATE OR REPLACE` of the new `aws_link_second_mortgagee(uuid, uuid)` (`plpgsql`, `VOLATILE`, `SECURITY DEFINER`, `search_path = public, pg_temp`, `RETURNS jsonb`), `REVOKE ALL ... FROM PUBLIC` (and from `anon`, `authenticated`, `service_role` where they exist) and `GRANT EXECUTE ... TO checksops`. No other statement. |

**Why.** Owner 2026-11-10: "build the second-mortgagee fix". A check made out to two mortgage
companies is endorsed by the 1st, then by the 2nd. Send to Mortgage Desk
(`src/components/loss-draft/SendToMortgageDeskButton.tsx`) offers "Add 2nd mortgagee" while the 1st
request is open; on AWS two things stopped it:

- the 2nd INSERT was refused while the 1st request was open (`23505`, "Request already open"): the
  unique index `public.mortgage_handling_requests_one_open_per_check` (Supabase migration
  `20260715110727`, carried by the database copy) allows one `requested` / `in_progress` request per
  check;
- the screen's UPDATE of the 1st request to `endorsement_order 1` / `total_mortgagees 2` was refused: no
  tenant UPDATE policy and no UPDATE grant on those columns (SQL 100), and the API refuses them on update
  (`aws/functions/api/write-check-workflow.mjs` `MORTGAGE_REQUEST_INSERT_ONLY`).

PR #1742 added the file, the API RPC (`aws/functions/api/workflow-rpc.mjs` `SAFE_WRITE_RPCS`,
`link_second_mortgagee`) and the screen's change. Owner 2026-11-10 for this tooling: "build the SQL 148
tooling and merge it when green".

**What it changes.**

1. `public.mortgage_handling_requests_one_open_per_check`, same name, from the Supabase definition

   ```
   CREATE UNIQUE INDEX mortgage_handling_requests_one_open_per_check ON public.mortgage_handling_requests USING btree (check_intake_item_id) WHERE (status = ANY (ARRAY['requested'::text, 'in_progress'::text]))
   ```

   to

   ```
   CREATE UNIQUE INDEX mortgage_handling_requests_one_open_per_check ON public.mortgage_handling_requests USING btree (check_intake_item_id, COALESCE(endorsement_order, 1)) WHERE (status = ANY (ARRAY['requested'::text, 'in_progress'::text]))
   ```

   A check still has at most one open request for its 1st mortgagee (an unordered request counts as the
   1st, as before) and now at most one for its 2nd. The Supabase index already allows at most one open
   request per check, so no row can violate the new one when it replaces it.
2. `aws_link_second_mortgagee(_first_request_id, _second_request_id)`: only for a signed-in user
   (`42501 mortgagee_link_forbidden`); two different ids (`22023 mortgagee_link_invalid: request ids`);
   both requests locked `FOR UPDATE` in id order, each existing and of a tenant the caller is a member of
   (SQL 90's `aws_can_write_tenant`, membership only; `P0002 mortgagee_link_request_not_found`, the same
   answer for another tenant's request); same tenant and check; neither cancelled; the 1st without a
   predecessor, order `NULL` or 1 and total `NULL` or 2; the 2nd with order `NULL` or 2, total `NULL` or 2
   and predecessor `NULL` or the 1st (`22023 mortgagee_link_invalid: ...`); no other live request of the
   check already in 2nd place (`23505 mortgagee_link_conflict`). Then the 1st is set to 1 of 2 and the 2nd
   to 2 of 2 with the 1st as predecessor, each only where it differs; a repeat changes nothing.

EXECUTE: revoked from `PUBLIC`, `anon`, `authenticated` and `service_role`; granted to `checksops`
(the API login). The owner keeps its own. Only the API's `link_second_mortgagee` RPC calls it.

Not changed: no table, column, policy, RLS setting, table or column grant, trigger or row; no other
function or index. Tenants still cannot UPDATE the order columns directly. Until SQL 148 is applied in an
environment, the 2nd mortgagee's request is refused there while the 1st is open, as today.

**Predecessor.** None in the release engine. SQL 90 must be applied first (its membership-only
`aws_can_write_tenant(uuid)` is a prerequisite; applied in production).

**Staging executor refreshed (2026-11-10).** Deploy run 42900220555 updated
`checksops-staging-guarded-sql-executor` to carry SQL 148 (inspect run 42899819090 read CodeSha256
`TWeOpTCGp4xsaakiGe65SIpa5fpL3ursGTvwHTyZJdM=` before it, inspect run 42900666063
`mLwFCDaJmUr71PVRz6KXULEhEJtK0iDLvgf/oTvTI8E=` after it).

**Staging read-live (2026-11-10).** Run 42901109448 (job 130126993947, main `952c4139e`, after executor deploy
run 42900220555): `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`,
`definer_writes` all `ok true`, `other_per_check_unique_indexes` 0, `index_definitions` the index at
`supabase_20260715110727`. Live `508588e6cd7d48ca74411aba8e0220842e0490bde69a881d362966f77e54d862`: the function absent and the index at the
Supabase definition, everything else in place, equal to the derived pre-state; intended `0ea9b78f…`. Recorded in
the staging pin (`expected_live_definition_sha256`, `execute: true`, wave 43) under the owner's words of
2026-11-10, "record the SQL 148 staging pin and merge it when green". The staging apply is a separate run after
this pin is merged and the executor is redeployed carrying it, on the owner's words for that run, "apply SQL 148
in staging". The production pin stays pending: a read-only production inspect decides production's pre-state.

**Staging executor refreshed for the pin (2026-11-10).** The staging pin (wave 43, PR #1746) merged as
`7f7ae312a0a68ad8e1bfd99db3a579a91de7744b`. Inspect run 42904287736 (main `7f7ae312a`) found the live executor at
`mLwFCDaJmUr71PVRz6KXULEhEJtK0iDLvgf/oTvTI8E=`. Deploy run 42904644950 (`expected_executor_code_sha256`
`mLwFCDaJ…` matched) updated `checksops-staging-guarded-sql-executor`; inspect run 42905116795 read it at
`X2Z+6Nkj0qI3pYc/jY7/YZVKBGu5+YjdN3wr6NA1hho=`. Read-live run 42905486022 (executor `X2Z+6Nkj…`): `already_applied`
false, `precondition_failures` `[]`, live `508588e6…`, equal to the pin.

**Staging apply (2026-11-10).** Apply run 42905846810 (job 130143491289, main `7f7ae312a`, workstream
`github-staging-sql-42905846810`, pin commit `ac6567f2a`, `expected_live_definition_sha256`
`508588e6cd7d48ca74411aba8e0220842e0490bde69a881d362966f77e54d862`) under the owner's words "apply SQL 148 in
staging": success. The receipt prints `result` `applied`, `before_hash` `508588e6…`, `after_hash`
`0ea9b78f674241215a46bbcfd5452ade00d472416b51cefdcd423258b525127b`; the function in state `intended`, its EXECUTE
ACL `checksops` and the owner, `index_definitions` `intended`, `definer_writes` ok, `prerequisites_missing` `[]`.
Read-live run 42906285342 (job 130145005929, executor `X2Z+6Nkj…`): `already_applied` true, `live_definition_sha256`
`0ea9b78f…` equal to the intended hash, `precondition_failures` `[]`, `index_definitions` `intended`,
`other_per_check_unique_indexes` 0. Staging acceptance: the owner on 2026-11-10, "SQL 148 accepted in staging",
given before the staging apply ran and taken as an acceptance only because the apply ended exactly at the intended
fingerprint with no precondition failure, as it did. There is no separate staging record PR for SQL 148: these
staging runs are recorded here and in the production pin's `staging_acceptance` by the production pin PR. The
staging pin keeps `execute: true`. The API change that calls the function (`workflow-rpc.mjs`) and the SPA change are
not part of this pin.

**Production inspect (2026-11-10).** Read-only `--inspect` through SSM
`3fc740fd-06b8-4bdb-be60-3042a406c25e` on `i-0c35557c4e5385406` (under the owner's words "run the read-only SQL 148
production inspect"; command sent 21:06:49Z, Success 21:07:00Z, runner stopped 21:07:16Z), main `952c4139e` (tarball
sha256 `332e1b48c238a0b517b83e77bd0549cbc06940829b04c406e9af263abeff86de`, staged by `sql53-temporary-transfer.yml`
run 42901557628, migration source `f87ea6d7…` == pin), `read_only` true: live
`508588e6cd7d48ca74411aba8e0220842e0490bde69a881d362966f77e54d862` (the function absent and the index at the Supabase
definition, the derived pre-state), `index_definitions` `supabase_20260715110727`, `other_per_check_unique_indexes`
0, `definer_writes` ok, `already_applied` false, `live_matches_expected` false, `precondition_failures` `[]`,
`apply_preconditions_met` false, `errors` `[]`. `precondition_failures` `[]` means every production precondition
passed: the pinned `checksops_admin` login, `prerequisites_present` (`prerequisites_missing` `[]`),
`predecessors_applied`, `successors_not_applied`, `replaced_indexes_replaceable`, `no_other_per_check_unique_index`
and `definer_can_write_relations`. Production's pre-state equals staging's (read-live runs 42901109448 and
42905486022), so the staging apply took the path production will. Recorded in the production pin with the staging
apply (run 42905846810) as its staging acceptance and `execute: true` under the owner's words "record the SQL 148
production pin". The owner merges the pin change; the apply runs only after that merge is on main and staged, under
the owner's words for that run ("apply SQL 148 in production").

**Status:** applied in staging (wave 43, 2026-11-10); staging acceptance: owner ("SQL 148 accepted in staging"); production pin execute-authorized; not applied to production

## The index in the release engine

SQL 148 is the first release migration that redefines an existing index in place. The engine's index
entry (spec `indexes`, SQL 98) fingerprints an index as absent or the hash of its collapsed
`pg_get_indexdef`, and accepted only absent or the file's own definition. SQL 148's entry adds
`replaces`: the Supabase definition, labelled `supabase_20260715110727`. Then:

- the fingerprint line of the index is the hash of whichever definition is live, so the pre-state (the
  Supabase definition) and the post-state (SQL 148's) differ, and any other definition is a third state;
- `replaced_indexes_replaceable`: the index must be live as the Supabase definition or as SQL 148's own;
  absent or any other definition refuses (both databases carry the Supabase index; the file's duplicate
  check for an absent index would need a row count the tooling does not take);
- `no_other_per_check_unique_index`: the catalog count `other_per_check_unique_indexes` (valid unique
  indexes keying the table on `check_intake_item_id` alone, other than this one; the file's own query) must
  be 0;
- the inspect reports which definition is live, by label only, in `release_sql_inspect.index_definitions`
  (`supabase_20260715110727`, `intended`, `absent` or `other`);
- the unrelated-catalog snapshot skips this index by name (its OID and definition change), as for SQL 98.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql148` in `release-sql-specs.mjs`). Intended
`0ea9b78f674241215a46bbcfd5452ade00d472416b51cefdcd423258b525127b`:

```
release sql148 v1
function public.aws_link_second_mortgagee(uuid, uuid): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public, pg_temp prosrc=9967698c772775379419b4dafdc4d867f98262a2619e5c97a4c5ff6aaff3bdfc acl=checksops EXECUTE;owner EXECUTE
index public.mortgage_handling_requests mortgage_handling_requests_one_open_per_check: 25884fbc63bf71001874ef73de77d9253f38c0736c20c9d8e85d2a2964643c33
```

`25884fbc…` is sha256 of SQL 148's index definition above.

**Expected pre-state (both environments).** The function absent and the index at the Supabase
definition, everything else in place (`releaseReplacedPreState('sql148')`):

```
release sql148 v1
function public.aws_link_second_mortgagee(uuid, uuid): absent
index public.mortgage_handling_requests mortgage_handling_requests_one_open_per_check: 5f2ee29b2813fba0fded4ade314f0b860d88e1c32c60c2a00161e8f1da0019f5
```

That is `508588e6cd7d48ca74411aba8e0220842e0490bde69a881d362966f77e54d862` (`5f2ee29b…` is sha256 of
the Supabase definition), derived and observed on PostgreSQL 16 by
`aws/tests/release-sql148-executor.test.mjs`. Each pin records its own environment's read; neither value
is written into a pin before a run reads it. A pre-state other than this one is not by itself a stop, but
its per-object report (`index_definitions`, `functions`, `function_acl`) must be read and explained
before it is recorded; an index reported `absent` or `other` is refused by the tooling.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the table with the seven columns, `aws_can_write_tenant(uuid)`, `auth.uid()`,
role `checksops`); `replaced_indexes_replaceable`; `no_other_per_check_unique_index`;
`definer_can_write_relations` on `public.mortgage_handling_requests` (the applying login owns it without
`FORCE ROW LEVEL SECURITY`, or is a superuser or `BYPASSRLS`); and, where the function already exists (a
re-run), `functions_owned_by_login`, `function_results_match` (the `jsonb` result) and
`function_acl_replaceable` (no EXECUTE grant outside `checksops` and the owner, which the file keeps, and
`PUBLIC`, `anon`, `authenticated` and `service_role`, which it revokes).

Post-conditions: the intended fingerprint (the function and SQL 148's index); the function owned by the
login; everything else in schema `public` unchanged. The tools roll back otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 148 first (executor package refresh through the
   guarded staging executor `deploy` mode, its own reviewed run). Then run the guarded staging SQL
   executor with `read-live` for `sql148-second-mortgagee-link`. Expected: `already_applied` false,
   `precondition_failures` `[]`, `index_definitions` `supabase_20260715110727`,
   `counts.other_per_check_unique_indexes` 0, `definer_writes` `ok true`, `live_definition_sha256`
   `508588e6…` (above). If it reports `prerequisites_missing` other than `[]` or `precondition_failures`
   other than `[]`, stop. Otherwise record `LIVE_DEFINITION_SHA256` in the staging pin
   (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in a reviewed
   change, `apply`, then `read-live` again.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql148 … --phase inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging runs in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql148 --approval-scope sql148 … --phase apply` with the owner's words
   (authorization phrase `APPLY_SECOND_MORTGAGEE_LINK`).
4. Record the apply and retire the pin (`execute: false`).
5. Only then deploy the API change (`workflow-rpc.mjs` REPLACE through the guarded production API
   overlay, staging first, held behind SQL 148 in `ops/deployment-guard/production-api-overlay-plan.json`)
   and the SPA change through the guarded SPA path.
