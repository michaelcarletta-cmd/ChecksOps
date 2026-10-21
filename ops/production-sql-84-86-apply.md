# Production SQL 84, 85 and 86 (Mortgage Ops Return to Queue, Adjust, owner-only compensation)

| | SQL 84 | SQL 85 | SQL 86 |
|---|---|---|---|
| File | `aws/workflows/sql/84_mortgage_return_to_queue.sql` (source sha256 `0b6fe69b…`) | `aws/workflows/sql/85_mortgage_compensation_adjust.sql` (`4cc77457…`) | `aws/workflows/sql/86_mortgage_compensation_owner_only.sql` (`1449df1f…`) |
| Staging pin commit | `6dd5acca3` (PR #992) | `6dd5acca3` | `6dd5acca3` |
| Pin | `ops/deployment-guard/sql84-mortgage-return-to-queue-production-apply.json` | `ops/deployment-guard/sql85-mortgage-compensation-adjust-production-apply.json` | `ops/deployment-guard/sql86-mortgage-compensation-owner-only-production-apply.json` |
| Tool | `scripts/deployment-guard/sql84-mortgage-return-to-queue-production-apply.mjs` | `scripts/deployment-guard/sql85-mortgage-compensation-adjust-production-apply.mjs` | `scripts/deployment-guard/sql86-mortgage-compensation-owner-only-production-apply.mjs` |
| Lib | `scripts/deployment-guard/lib/sql84-mortgage-return-to-queue-production-apply.mjs` | `…/lib/sql85-mortgage-compensation-adjust-production-apply.mjs` | `…/lib/sql86-mortgage-compensation-owner-only-production-apply.mjs` |
| Shared rules | `scripts/deployment-guard/lib/mortgage-sql-production-apply.mjs` | (same) | (same) |
| Staging | guarded staging SQL executor, migration `sql84-mortgage-return-to-queue` | `sql85-mortgage-compensation-adjust` | `sql86-mortgage-compensation-owner-only` |
| Tests | `aws/tests/sql84-sql86-mortgage-production-apply.test.mjs`, `aws/tests/sql84-sql86-mortgage-executor.test.mjs` | (same) | (same) |

**Status (2026-10-21):** verified live in production; all three pins are `execute: false`
again. The read-only production `--inspect` of 2026-10-21 (SSM
`ab678be8-7fd3-4f7d-a6d0-ed905cfed9aa`, runner `i-0c35557c4e5385406`, main `69dbe9b01`)
reports `already_applied` true for each (SQL 84 live `ff920f54…`, SQL 85 `051e8228…`,
SQL 86 `fb7e8229…`, each equal to `intended_replacement_sha256`; `precondition_failures` []).
SQL 85's apply is recorded: the 2026-10-16 one-shot (SSM `da16269a-0aee-4196-87c4-90c554178be6`,
workstream `prod-sql84-86-mortgage-20261016`, main `079d19356`, one_use_id
`sql85-prod-2b18a6da-7903-43b1-9e29-83cd47e58b3d`, `7d5e766c…` -> `051e8228…`). SQL 84's and
SQL 86's original apply runs are not recorded in the repository. Each pin's `applied` record
(result `verified_live`) holds this evidence; a re-apply needs a new reviewed pin change.

**Earlier status:** applied to staging (2026-10-16, guarded staging SQL executor apply runs 63, 64
and 65); not applied to production. All three production pins are execute-authorized
(step 6) and wait for the owner's review and merge, then the one-shot run (step 7). All
pre-states are recorded, from read-only inspects only (nothing here is code-derived except
the post-state):

- **Staging** (`AUTHORIZED_SQL84_MORTGAGE_RETURN_TO_QUEUE`,
  `AUTHORIZED_SQL85_MORTGAGE_COMPENSATION_ADJUST`,
  `AUTHORIZED_SQL86_MORTGAGE_COMPENSATION_OWNER_ONLY` in
  `scripts/deployment-guard/lib/sql-executor-auth.mjs`): guarded staging SQL executor
  read-live runs of 2026-10-16 on main `2e500dad1` (executor deploy run 57, run id
  38891814825): run 58 (38892001098) for SQL 84, run 59 (38892111590) for SQL 85, run 60
  (38892218991) for SQL 86. All three: `precondition_failures` `[]`.
- **Production** (`production_inspect` in each pin): `--inspect` of 2026-10-16 on runner
  `i-0c35557c4e5385406`, SSM command `0bd3e2c7-6b9d-4596-a36d-1ba516d73c9d`, source
  `2e500dad1`, as `checksops_admin`, read-only, `precondition_failures` `[]`.

Staging and production read the same pre-state for each migration (owner names are not
part of the fingerprint):

- **SQL 84:** `return_mortgage_handling_request_to_queue` is Cursor SQL 48's
  (`cursor_original`, `9f6811a7…`), `p_request_id uuid, p_reason text`, `RETURNS
  public.mortgage_handling_requests`, SECURITY DEFINER, `search_path=public`,
  `row_security=off`, owned by `checksops_admin`, EXECUTE for `PUBLIC`, `authenticated` and
  `checksops`. `per_check_unique_present` true (`check_billing_events_mortgage_ops_check_uidx`,
  staging predicate, valid), so GATE 0 creates no index; `fallback_index_name_taken` false;
  `billing_duplicates` 0 groups, 0 extra events. The audit table is present, with the
  policy `aws_select_mortgage_ops_request_audit` using
  `aws_can_admin_mortgage_agent_compensation()`.
- **SQL 85:** the six-argument function absent; the five-argument one is Cursor SQL 49's
  (`cursor_original`, `e05bce27…`), same ACL as SQL 84's. `idempotency_key` absent;
  `batch_actions_outside_check` 0.
- **SQL 86:** all four SQL 47 functions `ledger_original` (helper `ea033ce8…`,
  reconciliation `edd48e82…`, earn `ffdc445e…`, trigger `ca557bd5…`); the first three
  EXECUTE for `PUBLIC`, `authenticated` and `checksops`, the trigger function for `PUBLIC`.
  `earn_owner`: same owner `checksops_admin`, not superuser, member of neither `checksops`
  nor `authenticated`, `earn_owner_safe` true.

**Staging acceptance** (recorded in each production pin's `staging_acceptance`), all on
main `97b981b9d` with the executor package `CodeSha256`
`wA29pCAXWeGwvQfHU1FWOGzA4yUm4xqjmhG4Sr2csZU=` (deploy run 62, `38894717631`):

- **SQL 84:** apply run 63,
  `https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38894893179`:
  `53a0fa9f…` -> `ff920f54…`, result applied. Read-live run 66 (`38895313068`):
  `already_applied` true, `precondition_failures` `[]`,
  `return_mortgage_handling_request_to_queue` intended, `matches_migration` and
  `body_matches_migration` true, EXECUTE `authenticated` and `checksops` only (PUBLIC
  revoked).
- **SQL 85:** apply run 64,
  `https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38895045712`:
  `7d5e766c…` -> `051e8228…`, result applied. Read-live run 67 (`38895440060`):
  `already_applied` true, `precondition_failures` `[]`, the six-argument
  `adjust_mortgage_agent_compensation` intended (`matches_migration` and
  `body_matches_migration` true, EXECUTE `authenticated` and `checksops` only), the
  five-argument Cursor SQL 49 function absent.
- **SQL 86:** apply run 65,
  `https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38895163945`:
  `c982ece2…` -> `fb7e8229…`, result applied. Read-live run 68 (`38895553584`):
  `already_applied` true, `precondition_failures` `[]`,
  `aws_can_admin_mortgage_agent_compensation` and
  `mortgage_agent_compensation_reconciliation` intended (`matches_migration` and
  `body_matches_migration` true), `earn_mortgage_agent_compensation` non-owner EXECUTE
  empty, `earn_owner_safe` true.

**Production pins:** `execute: false` since the 2026-10-21 record-and-retire change (it was `execute: true`); `authorization` records the owner's approval of
2026-10-16 ("Yes"; "approve the SQL 84-86 production unlock and apply"): production apply
of SQL 84, then SQL 85, then SQL 86, after the staging acceptance above. It takes effect
only when the owner reviews and merges that change, and it does not itself run or approve
a run: each apply still needs the owner's run-time approval for that workstream, a
production-sql receipt owning the pinned file, the authorization phrase and a new
`one_use_id`. `expected_live_definition_sha256` stays the recorded production pre-state
(`53a0fa9f…` / `7d5e766c…` / `c982ece2…`), and every post-state, source sha256 and rule is
unchanged. With a pending authorization, `execute: false` or no staging acceptance,
evaluate and apply refuse with `PRODUCTION_APPROVAL_REQUIRED` (or `GUARD_APPLY_FORBIDDEN`
for execute); the tests keep those refusals on explicit pending copies of the pins.

**Order:** SQL 84, then SQL 85, then SQL 86. None depends on another (each checks only
SQL 47), and (as for SQL 81 to 83) the tools have no predecessor check, so each pin has
`predecessors: []` and the order is procedural. All three need the Cursor SQL 47
compensation ledger: the inspect reports each file's own `sql47_prerequisite_missing`
list as `prerequisites`, and a missing object is the precondition
`sql47_prerequisites_present`.

## What each apply changes (plain words)

**SQL 84**, in one transaction:

1. GATE 0. If a valid unique index on `check_billing_events (check_intake_item_id)` with
   exactly the staging or the fallback predicate exists (staging's is
   `check_billing_events_mortgage_ops_check_uidx`), nothing. Otherwise it creates
   `check_billing_events_one_mortgage_ops_per_check`, after refusing if duplicate
   non-voided per-check Mortgage Ops events exist. An index, not a billing write.
2. `CREATE TABLE IF NOT EXISTS public.mortgage_ops_request_audit` and its
   `(mortgage_request_id, created_at DESC)` index.
3. `CREATE OR REPLACE` of `public.return_mortgage_handling_request_to_queue(uuid, text)`
   (`RETURNS public.mortgage_handling_requests`, platform owner only), SECURITY DEFINER with
   `search_path=public` and `row_security=off`. Replaces a Cursor SQL 48 body in place.
4. RLS on the audit table with one platform-owner SELECT policy, `GRANT SELECT` to
   `checksops, authenticated`; `REVOKE ALL … FROM PUBLIC` and `GRANT EXECUTE … TO checksops,
   authenticated` on the function.

**SQL 85**, in one transaction: `adjustment_reason` on entries, the parent index,
`idempotency_key` on batches and its adjust-only unique index, the action CHECK
recreated as `approve`/`pay`/`adjust`, `DROP FUNCTION IF EXISTS` of the five-argument
`adjust_mortgage_agent_compensation` (Cursor SQL 49), `CREATE OR REPLACE` of the
six-argument one (`RETURNS jsonb`, platform owner only, bounded, idempotent per key),
`REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO checksops, authenticated`.

**SQL 86**, in one transaction: `CREATE OR REPLACE` of
`public.aws_can_admin_mortgage_agent_compensation()` (now
`COALESCE(public.is_platform_owner(), false)`) and of
`public.mortgage_agent_compensation_reconciliation(text)` (same query, now plpgsql with a
`not_authorized` check first); both keep their signature, result, STABLE, SECURITY
DEFINER, `search_path` and `row_security`, and their ACLs. Then, behind the
`earn_owner_unsafe` guard, `REVOKE ALL` on `public.earn_mortgage_agent_compensation(uuid)`
from `PUBLIC`, `checksops` and `authenticated` and `GRANT EXECUTE` to its owner, so only
the SQL 47 completion trigger function (same owner, SECURITY DEFINER) can call it.

No file writes a row, a rate, a billing event or a payment. Nothing else changes: no
other table, column, constraint, index, policy, trigger, role, default privilege, schema
ACL or function in `public` or `auth`.

## Pins

| | SQL 84 | SQL 85 | SQL 86 |
|---|---|---|---|
| expected pre-state, staging (read-live runs 58 / 59 / 60) | `53a0fa9f2b9cb126b3852a8b0595504fb74947c46a5a8390d67b46d7d67ad496` | `7d5e766cf30a46e2925af225e9c2c19ee3cdb9a84ccf2685c23393f7cc06ee2d` | `c982ece2661a85293c2122c3aaf8226050d3c6670c436c94e34b870292289d0b` |
| expected pre-state, production (`--inspect` 2026-10-16) | `53a0fa9f…` (same as staging) | `7d5e766c…` (same) | `c982ece2…` (same) |
| intended post-state | `ff920f5453283e9ca550bb8a191905386832f44e2e35567522530b806cb0e983` | `051e82285f54c40b4af289956cf537e79123de5e5dad7e6b8d83dd528e778908` | `fb7e82291b146d0bf243dab1f607b2202b131c09cccac56e40de96c64542062f` |
| definition sha256 (pg_get_functiondef, PostgreSQL 16) | return to queue `51069c48…` | adjust (6 args) `a8fa66f0…` | helper `b5bc3c54…`, reconciliation `427f7072…` |
| labels the inspect recognises | Cursor SQL 48 body `9f6811a7…` (`cursor_original`) | Cursor SQL 49 five-argument body `e05bce27…` (`cursor_original`) | SQL 47 helper `ea033ce8…`, reconciliation `edd48e82…`, earn `ffdc445e…`, trigger `ca557bd5…` (`ledger_original`) |
| production ACL after | `{checksops_admin=X/checksops_admin,checksops=X/checksops_admin,authenticated=X/checksops_admin}` | (same) | earn: `{checksops_admin=X/checksops_admin}`; helper and reconciliation unchanged |
| authorization phrase | `APPLY_MORTGAGE_RETURN_TO_QUEUE` | `APPLY_MORTGAGE_COMPENSATION_ADJUST` | `APPLY_MORTGAGE_COMPENSATION_OWNER_ONLY` |

The fingerprint is the staging executor's own (`readMortgageState` /
`mortgageStateText` in `aws/write-path/guarded-sql-executor/index.mjs` and
`scripts/deployment-guard/lib/sql-executor-auth.mjs`). Per function: present or absent,
the number of functions with its name in any schema, its arguments, result type,
definition sha256, SECURITY DEFINER, proconfig, whether the login owns it, and its
non-owner ACL entries (not for SQL 86's two replaced functions, whose ACLs the apply
compares before and after instead; for SQL 86's earn function only its owner flag and
ACL; for its trigger function only whether it shares earn's owner). Plus, for SQL 84,
the audit table (columns, RLS, owner flag, non-owner grants, policies, indexes) and
whether a GATE 0 index is present (not its name); for SQL 85, the two columns' types,
the two indexes' definitions and the action CHECK. Owner names are never part of it, so
the post-state is the same in staging and production. All three post-states are
code-derived and re-read from PostgreSQL 16 catalogs that start from the real Cursor SQL
47 / 48 / 49 files (`aws/tests/fixtures/mortgage-agent-compensation/`), both with and
without the Cursor bodies. Independently of the constants, the apply compares each live
`pg_get_functiondef` with the definition reconstructed from the pinned file's bodies
(`mortgageReviewedFunctiondefs`) and rolls back if they differ.

## Rules

**Before, staging and production (refused otherwise):** the roles `checksops` and
`authenticated`, every SQL 47 object the file names, every table and column the bodies
read exist; each target function is absent (no other function of that name in any
schema) or the only one of its name (SQL 85: plus the five-argument one it drops), a plain
function with the same result, arguments and parameter names, owned by the login, with
no ACL entry other than `PUBLIC`, `authenticated` or `checksops` EXECUTE without grant
option.

- SQL 84: an existing `mortgage_ops_request_audit` must be owned by the login, have
  exactly the file's columns, no FORCE RLS, only SELECT grants to `checksops` /
  `authenticated`, no policy but `aws_select_mortgage_ops_request_audit` and only the
  file's indexes. With no GATE 0 index: the fallback index name is free, the login owns
  `check_billing_events`, and the duplicate count is readable and zero.
- SQL 85: the login owns entries and batches; an existing `adjustment_reason` /
  `idempotency_key` is `text`; an existing index of either name is the file's; no batch
  action is outside `approve`/`pay`/`adjust`; no duplicate adjust idempotency key.
- SQL 86: the earn function exists, is owned by the login, and has no ACL entry the file
  does not revoke; `earn_owner.earn_owner_safe` (the file's `earn_owner_unsafe` guard,
  predicted): earn and `tg_earn_mortgage_agent_compensation` share an owner, that owner is
  not `checksops` or `authenticated`, and it is superuser or a member of neither.

The live fingerprint must equal the pin's and the manifest's. Production also requires
the connected login (`current_user` and `session_user`) to be the pinned owner
`checksops_admin`, every existing function the file touches and every table it alters to
be owned by it, and `authenticated` not to be a member of it (recursive, INHERIT FALSE
grants included).

**After (rolled back otherwise):** the intended fingerprint; per target function exactly
one of that name, the reviewed definition, SECURITY DEFINER, the reviewed config, owned by
the login; SQL 84 / 85 EXECUTE exactly `checksops` and `authenticated` (no PUBLIC, no
grant option), SQL 85's five-argument function gone, SQL 84's GATE 0 index present; SQL
86's helper and reconciliation ACLs unchanged, earn's body unchanged and its EXECUTE
owner-only, the earn owner still safe; in production each ACL-setting function's
`proacl` equal (as a set of aclitems) to the pin's `intended_post_state.function_acl`;
and the unrelated catalog snapshot unchanged: everything in `public` (relations and ACLs,
columns, constraints, policies, triggers, other functions, roles and memberships,
default privileges, the schema ACL) except the file's new relations and the tables it
alters, plus the staging executor's finer snapshot, which re-reads those altered tables
except the one added column, index or constraint, plus every function in `auth`.

## What the inspect reports

Both the staging read-live (`mortgage_inspect`, without owner names, definition text,
index predicates or check ids) and the production `--inspect` (with them) run in
`BEGIN READ ONLY … ROLLBACK`, only SELECT (plus savepoints for the counts, read with
`row_security=off` so a login RLS would filter reports `row_security_would_filter`
instead of a partial count), and print:

- `prerequisites` (each SQL 47 object the file checks, `present`),
  `sql47_prerequisites_present`, `missing_prerequisites` (production);
- per function (`functions.<key>`): `role`, `exists`, `state` (`absent` / `intended` /
  `cursor_original` / `ledger_original` / `other`), `overload_count`, `named_signatures`
  (every function of that name, any schema, with its result and definition sha256),
  `identity_arguments`, `arguments`, `argument_names`, `result`, `kind`, `returns_set`,
  `language`, `security_definer`, `config`, `owner` (production), `owner_is_executor`,
  `owner_rolsuper`, `owner_rolbypassrls`, `owner_member_of_checksops`,
  `owner_member_of_authenticated`, `proacl` (production), `acl_entries` (production also
  `acl_entries_with_grantor`), `definition_sha256`, `matches_migration`,
  `body_matches_migration`;
- **SQL 84:** `audit_table` (present, owner, columns, RLS, grants, policies, indexes;
  staging: `columns_match` and per policy / index `matches_migration`),
  `per_check_unique_present`, `billing_per_check_indexes` (every unique index keyed on
  `check_intake_item_id` or naming a Mortgage Ops event type, or holding the fallback
  name: `name`, `valid`, `is_unique`, `key_columns`, `has_expressions`, `predicate`
  (production) / `predicate_sha256`, `predicate_kind` `staging` / `fallback` / `other`,
  `matches_gate0`), `fallback_index_name_taken`, `billing_duplicates` (`groups`,
  `extra_events`; production also up to 50 `check_ids`);
- **SQL 85:** the five- and six-argument functions as `adjust_mortgage_agent_compensation_five_arg`
  and `adjust_mortgage_agent_compensation`, `added_columns` (type or null, i.e.
  `idempotency_key` presence), the two `indexes`, the action CHECK (`constraints` in
  production, `action_check` in staging), `batch_actions_outside_check`,
  `duplicate_adjust_idempotency_keys`;
- **SQL 86:** in production the full `definition` text of
  `aws_can_admin_mortgage_agent_compensation` and `mortgage_agent_compensation_reconciliation`,
  `earn_owners` (for earn and the trigger function: `rolname`, `rolsuper`,
  `member_of_checksops`, `member_of_authenticated`, `proacl`), and in both
  `earn_owner` (`same_owner`, `owner_is_checksops_or_authenticated`, `owner_rolsuper`,
  the two memberships, `earn_owner_safe`);
- `tables.<name>` (`present`, `rls_enabled`, `rls_forced`, owner / `owner_is_login`),
  `required_roles_present`, `required_tables_present`, `required_columns_present`,
  `missing_columns`;
- `live_definition_sha256`, `expected_live_definition_sha256`, `pre_state_recorded`
  (production), `live_matches_expected`, `already_applied`, `precondition_failures` and
  `apply_preconditions_met`.

## Where it runs

Staging: only through `.github/workflows/guarded-staging-sql-executor.yml` (the VPC
executor Lambda). Production: only on the SQL53 runner `i-0c35557c4e5385406` in
`vpc-09f2268778966ce97`, from the reviewed main source staged by
`.github/workflows/sql53-temporary-transfer.yml`, with
`AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com`.
Same production RDS (`checksops-production`), pinned host and `checksops_admin` secret as
SQL 72 to 83: the tool reads the secret from the pinned ARN with the instance role (never a
flag, a file or an environment variable), proves the endpoint is the production RDS, and
connects with the repository's RDS CA bundle. Never from GitHub-hosted runners or Lambda.

## Steps (each needs owner approval)

0. **Staging executor package.** Run the guarded staging SQL executor with `mode: inspect`
   (any `migration`) to read the live executor `CodeSha256`, then `mode: deploy`,
   `approved_commit: <main sha>`, `expected_executor_code_sha256: <CodeSha256>` so the
   executor carries the SQL 84 / 85 / 86 files and handlers.
1. **Staging read-live (read-only)** (done 2026-10-16, runs 58, 59 and 60), one run per migration:

   ```bash
   gh workflow run guarded-staging-sql-executor.yml --ref main \
     -f mode=read-live -f migration=sql84-mortgage-return-to-queue -f approved_commit=<main sha>
   gh workflow run guarded-staging-sql-executor.yml --ref main \
     -f mode=read-live -f migration=sql85-mortgage-compensation-adjust -f approved_commit=<main sha>
   gh workflow run guarded-staging-sql-executor.yml --ref main \
     -f mode=read-live -f migration=sql86-mortgage-compensation-owner-only -f approved_commit=<main sha>
   ```

   (`expected_executor_code_sha256` optional, `expected_live_definition_sha256` empty.)
   Expect `pin_executable` false and `precondition_failures` `[]`; for SQL 84
   `functions.return_mortgage_handling_request_to_queue.state` `cursor_original` or
   `absent`, `per_check_unique_present` true (staging's index) and
   `billing_duplicates.groups` 0; for SQL 85 the five-argument function `cursor_original`
   or `absent`; for SQL 86 `earn_owner.earn_owner_safe` true. If `precondition_failures`
   is not empty, **stop**: that needs its own reviewed change.
2. **Staging pin change (reviewed PR)** (this change records all three): set each staging pin's
   `expected_live_definition_sha256` to the read-live `live_definition_sha256`.
3. **Staging apply** (done 2026-10-16: apply runs 63, 64 and 65, read-live runs 66, 67 and
   68; see Staging acceptance above), in order: `mode: apply`, `migration: sql84-mortgage-return-to-queue`,
   `approved_commit`, `expected_executor_code_sha256`, `expected_live_definition_sha256:
   <the recorded hash>` (pre → `ff920f54…`), then `read-live` (`already_applied` true); then
   the same for `sql85-mortgage-compensation-adjust` (pre → `051e8228…`) and
   `sql86-mortgage-compensation-owner-only` (pre → `fb7e8229…`).
4. **Transfer:** dispatch `.github/workflows/sql53-temporary-transfer.yml` on main and copy
   `TARBALL_SHA256` from its log.
5. **Production inspect (read-only)** (done 2026-10-16, SSM `0bd3e2c7…`), on the runner from the freshly extracted tree (the
   SSM block in `ops/production-sql-one-shot.md`, with its last command replaced):

   ```bash
   export AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com
   node scripts/deployment-guard/sql84-mortgage-return-to-queue-production-apply.mjs --inspect
   node scripts/deployment-guard/sql85-mortgage-compensation-adjust-production-apply.mjs --inspect
   node scripts/deployment-guard/sql86-mortgage-compensation-owner-only-production-apply.mjs --inspect
   ```

   The one-shot refuses a pin with `execute: false`, so this first inspect is the tool's
   own. Expect `pre_state_recorded` false, `apply_preconditions_met` false (nothing
   recorded yet) and `precondition_failures` `[]`. If `sql47_prerequisites_present` is
   false (SQL 47 not in production) or `precondition_failures` is not empty, **stop**.
6. **Production pin change (reviewed PR, owner-merged).** First change (done): each
   inspect in `production_inspect` (date, SSM command id, source commit,
   `live_definition_sha256`, `function_states`, the functions' arguments / owner / proacl,
   `precondition_failures`, `apply_preconditions_met`, `status: "recorded"`, no check ids)
   and `live_definition_sha256` copied into `expected_live_definition_sha256`. Second
   change (done 2026-10-16, after the staging apply runs 63, 64 and 65): the staging apply
   run recorded in `staging_acceptance` (`ok: true`, `reference`, `basis`), `execute: true`
   and the owner's approval in `authorization` (it must start with `Owner approved` or
   `owner-approved`; `"pending"` refuses even with `execute: true`). No fresh production
   `--inspect` was run for that change: the `--phase inspect` of step 7 is that fresh
   inspect, and it must report the same `live_definition_sha256` and
   `precondition_failures` `[]` (the one-shot and the tool refuse otherwise). Merge to main
   and stage it with step 4 again.
7. **Run** (one-shot, `ops/production-sql-one-shot.md`), SQL 84 first:
   `--migration sql84 --approval-scope sql84`, `--phase inspect`, then for the approved
   run `--phase apply`; then the same with `sql85`, then `sql86`. The one-shot runs the
   inspect, the contracts, the manifest, `preflight.mjs --acquire-lease --receipt`,
   evaluate, apply and the post-apply inspect. By hand instead, per migration:
   - **Contracts:** `aws/tests/claim-ledger-accepted-contract.test.mjs`,
     `aws/tests/tenant-security-compliance.test.mjs`, `aws/tests/api-write.test.mjs` on the
     same source, recorded as `contract_results`.
   - **Manifest** (`sql-apply`, `production`, `production-sql`): the pin's `filename`,
     `migration_id`, `source_sha256`, `expected_live_definition_sha256`,
     `intended_replacement_sha256`; `live_definition_sha256` and the three fingerprints
     `{ "sql": "<live hash>" }`; the pin's `staging_acceptance`; `approval` for this
     workstream; the pin's `authorization_phrase`; a new `one_use_id`; `owned_components`
     = `["<the pin's filename>"]`.
   - **Lease and receipt:** `node scripts/deployment-guard/preflight.mjs --acquire-lease --receipt --input <manifest>`.
   - **Apply:** `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1 CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT=<receipt> node scripts/deployment-guard/sql84-mortgage-return-to-queue-production-apply.mjs --apply --input <manifest>`
     (or the SQL 85 / 86 tool). One transaction, `lock_timeout` 5s, advisory locks
     `sqlNN_mortgage_objects` and `sqlNN_mortgage_objects_production`. If the tool reports
     the COMMIT outcome as unknown, run `--inspect` before anything else.
   - **Verify:** `--inspect` again: `already_applied` true, `live_definition_sha256` the
     intended hash, every target function `matches_migration` true, `proacl` as above.
8. **Record and retire:** a reviewed change records the evidence in the pin and sets
   `execute` back to `false`.

## Rollback (a separate owner-approved operation)

There is no automatic rollback. To return to a previous body, re-run the previous
reviewed definition as `checksops_admin` through its own guarded change. Never drop the
functions or the audit table: the API calls them as `checksops`, and the audit rows are
append-only history. SQL 86's earn revoke is undone only by re-granting EXECUTE in a
reviewed change; the completion trigger does not need it.
