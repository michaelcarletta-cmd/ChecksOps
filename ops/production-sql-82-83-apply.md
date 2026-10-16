# Production SQL 82 and SQL 83 (homeowner ledger view and signing capabilities)

| | SQL 82 | SQL 83 |
|---|---|---|
| File | `aws/workflows/sql/82_homeowner_ledger_view.sql` (source sha256 `1db68ee9…`) | `aws/workflows/sql/83_homeowner_signing_capabilities.sql` (source sha256 `8443a3e7…`) |
| Staging pin commit | `4b1fe50d1` (PR #989) | `4b1fe50d1` (PR #989) |
| Pin | `ops/deployment-guard/sql82-homeowner-ledger-view-production-apply.json` | `ops/deployment-guard/sql83-homeowner-signing-capabilities-production-apply.json` |
| Tool | `scripts/deployment-guard/sql82-homeowner-ledger-production-apply.mjs` | `scripts/deployment-guard/sql83-homeowner-signing-production-apply.mjs` |
| Lib | `scripts/deployment-guard/lib/sql82-homeowner-ledger-production-apply.mjs` | `scripts/deployment-guard/lib/sql83-homeowner-signing-production-apply.mjs` |
| Shared rules | `scripts/deployment-guard/lib/homeowner-sql-production-apply.mjs` | (same) |
| Staging | guarded staging SQL executor, migration `sql82-homeowner-ledger-view` | migration `sql83-homeowner-signing-capabilities` |
| Tests | `aws/tests/sql82-sql83-homeowner-production-apply.test.mjs`, `aws/tests/sql82-sql83-homeowner-executor.test.mjs` | (same) |

**Status:** not applied to staging or production. Both pre-states are recorded, from
read-only inspects only (nothing here is code-derived except the post-state):

- **Staging** (`AUTHORIZED_SQL82_HOMEOWNER_LEDGER_VIEW`,
  `AUTHORIZED_SQL83_HOMEOWNER_SIGNING_CAPABILITIES` in
  `scripts/deployment-guard/lib/sql-executor-auth.mjs`): guarded staging SQL executor
  read-live runs of 2026-10-16, run 48 (job 116757174929) for SQL 82 and run 49 (job
  116757504435) for SQL 83. SQL 82: Cursor SQL 73's ledger view
  (`raw_endorse_token_link` true). SQL 83: the three functions exist from Cursor SQL 74.
  Both: `precondition_failures` `[]`, `row_security_off_supported` true,
  `owner_is_executor` true, non-owner ACL `checksops` EXECUTE only.
- **Production** (`production_inspect` in each pin): `--inspect` of 2026-10-16, SSM command
  `f1430894-0783-46cf-bbab-e7137c10ece3`, source `eb540ee98`, as `checksops_admin`,
  `precondition_failures` `[]`. SQL 82: the ledger view exists (`other`), owned by
  `checksops_admin`, but its body is not Cursor SQL 73 (no raw endorse link) and its
  origin is not recorded. SQL 83: all three functions absent. Both: the legacy
  `aws_public_homeowner_ledger_remint_signer(text,uuid,text)` is present (report only).

The staging and production pre-states differ, so each is pinned separately. Production
apply is still refused: both production pins are `authorization: "pending"`,
`execute: false`, `staging_acceptance.ok: false` (`reference: null`), so production
evaluate and apply refuse with `PRODUCTION_APPROVAL_REQUIRED`. Staging apply now needs
the executor package that carries these pins (step 0, `mode: deploy`) and then
`mode: apply` with `expected_live_definition_sha256` set to the staging pin.

**Order:** SQL 82, then SQL 83. SQL 83 does not depend on SQL 82, and (as for SQL 81) the
tools have no predecessor check, so each pin has `predecessors: []` and the order is
procedural.

## What each apply changes (plain words)

**SQL 82**, in one transaction:

1. `CREATE OR REPLACE` of `public.aws_public_homeowner_ledger_by_token(text)` (same
   signature, `RETURNS jsonb`, parameter `p_token`): the public homeowner ledger view.
   Unlike Cursor's SQL 73 body, `pending_endorsements[].sign_url` is always `NULL` (no raw
   `'/endorse?token=' ||` link), name matches need two whole-word parts, and
   `pending_signatures` is `[]`. SECURITY DEFINER with `search_path=public`.
2. `REVOKE ALL … FROM PUBLIC`, `REVOKE ALL … FROM authenticated`,
   `GRANT EXECUTE … TO checksops`.

**SQL 83**, in one transaction, the same for three sibling doorways, each SECURITY
DEFINER with `search_path=public` and `row_security=off`:

- `public.aws_public_homeowner_ledger_endorse_capability(text, uuid)` (`p_token`, `p_endorsement_id`)
- `public.aws_public_homeowner_pending_signatures(text)` (`p_token`)
- `public.aws_public_homeowner_document_sign_capability(text, uuid)` (`p_token`, `p_signer_id`)

After either apply each function's ACL is exactly
`{checksops_admin=X/checksops_admin,checksops=X/checksops_admin}` in production. Nothing
else changes: no table, column, constraint, policy, trigger, role, default privilege,
schema ACL or other function in `public` or `auth`. The legacy
`aws_public_homeowner_ledger_remint_signer` is reported by the inspect and never dropped.

## Pins

| | SQL 82 | SQL 83 |
|---|---|---|
| expected pre-state, staging (read-live run 48 / 49) | `452f8f3d2411e0c3772fdf92c14e1b85785823dcb8d6567d01f1908dc9a8d783` | `e85f64fa17ff2146d1aa3a603c83580c8c369dd2b49d252dfc8fd45453f4a21f` |
| expected pre-state, production (`--inspect` 2026-10-16) | `9892d5ca12b426c303fdfdd4f92c9ef9a2a84ab94031989b09ee6c860a981229` | `c01704546922410e1f08088b39c69f02fbe004dcb919b12635d0908eb34e7936` |
| intended post-state | `04e41eedb372334169feb32bc65991a3ce99558b84e91b27e22a6501be641e37` | `78da421900f4e3d0af7110ee2b1a47f1498599a59a6dfa07953c59ad56b27163` |
| definition sha256 (pg_get_functiondef, PostgreSQL 16) | ledger view `962de3a5…` | endorse `066754e6…`, pending signatures `3b632929…`, document sign `a45f3bfc…` |
| authorization phrase | `REPLACE_HOMEOWNER_LEDGER_VIEW` | `REPLACE_HOMEOWNER_SIGNING_CAPABILITIES` |

The fingerprint is the staging executor's own (`readHomeownerState` /
`homeownerStateText` in `aws/write-path/guarded-sql-executor/index.mjs` and
`scripts/deployment-guard/lib/sql-executor-auth.mjs`): per function, present or absent,
the number of functions with its name in any schema, its arguments, result type,
definition sha256, SECURITY DEFINER, proconfig, whether the login owns it and every
non-owner ACL entry. The owner's own ACL entry is not part of it, so the post-state is the
same in staging and production. Both post-states are code-derived and re-read from
PostgreSQL 16 catalogs that start from the real Cursor SQL 73 / SQL 74 files
(`aws/tests/fixtures/`). Independently of the constants, the apply compares each live
`pg_get_functiondef` with the definition reconstructed from the pinned file's bodies
(`homeownerReviewedFunctiondefs`) and rolls back if they differ.

## Rules

**Before, staging and production (refused otherwise):** the roles `checksops` and
`authenticated`, every table and every column the bodies read exist; for each target
function either it is absent (no function of that name in any schema) or it is the only
function of that name, a plain function (not a procedure, not set-returning) with result
`jsonb`, the same parameter names, owned by the login, and with no ACL entry other than
`PUBLIC`, `authenticated` or `checksops` EXECUTE without grant option (anything else would
survive the REVOKEs); for SQL 83, each definer's owner (the current owner, or the login
for a new function) is superuser or BYPASSRLS, or owns every RLS table the bodies read
without FORCE RLS, because `row_security=off` errors otherwise
(`row_security_off_supported`); the live fingerprint equals the pin's and the manifest's.
The `row_security=off` check covers only the tables the function bodies read; triggers
on the tables they write (for example `check_endorsements`) are not inspected.
Production also requires the connected login (`current_user` and `session_user`) to be the
pinned owner `checksops_admin`, every existing target function to be owned by it, and
`authenticated` not to be a member of it (recursive, INHERIT FALSE grants included).

**After (rolled back otherwise):** the intended fingerprint; per function exactly one of
that name, the reviewed definition, SECURITY DEFINER, the reviewed config, owned by the
login, non-owner EXECUTE exactly `checksops` (no PUBLIC, no authenticated, no grant
option); in production `proacl` equal to the pin's `intended_post_state.function_acl`; and
the unrelated catalog snapshot (relations and their ACLs, columns, constraints, policies,
triggers, every other function in `public`, every function in `auth`, roles and
memberships, default privileges, the schema ACL) unchanged.

## What the inspect reports

Both the staging read-live (`homeowner_inspect`, without owner names) and the production
`--inspect` (with them) run in `BEGIN READ ONLY … ROLLBACK`, only SELECT (plus savepoints
for the counts), and print:

- per function (`functions.<name>`): `exists`, `overload_count`, `named_signatures`
  (every function of that name, any schema, with its result), `identity_arguments`,
  `arguments`, `argument_names`, `result`, `kind`, `returns_set`, `language`,
  `security_definer` (prosecdef), `config` (proconfig), `owner`, `owner_is_executor`,
  `owner_rolsuper`, `owner_rolbypassrls`, `proacl`, `acl_entries` (production also
  `acl_entries_with_grantor`), `definition_sha256` (hashSqlDefinition of
  pg_get_functiondef), `matches_migration` (already applied), `body_matches_migration`
  (function-def-lookup `functionDefsMatchExactly` against the reconstructed definition) and
  `raw_endorse_token_link` (the Cursor SQL 73 `'/endorse?token=' ||` pattern; SQL 82 also
  prints it as `ledger_view_raw_endorse_token_link`);
- `function_states` (`absent` / `intended` / `other` per function);
- `legacy_remint_signer` (`present`, `signatures`; report only);
- the login's `rolsuper` / `rolbypassrls`, and `row_security.<function>` (the effective
  owner, its `rolsuper` / `rolbypassrls`, `rls_tables_not_bypassed`) plus
  `row_security_off_supported`;
- `tables.<name>` (`present`, `rls_enabled`, `rls_forced`, owner) for
  `homeowner_ledger_tokens`, `check_endorsements`, `signature_requests`,
  `signature_signers`, `check_intake_items`, `claims` and every other table the file reads;
- `required_roles_present`, `required_tables_present`, `required_columns_present`,
  `missing_columns`;
- `status_constraints` (CHECK constraints on `status` / `payee_type` of
  `check_endorsements`, `signature_signers`, `signature_requests`: name, definition hash,
  allowed values; production also the definition);
- `status_counts` (aggregate counts only, no rows: `check_endorsements` by
  `payee_type` + `status`, `signature_signers` and `signature_requests` by `status`; read
  with `row_security=off`, so a login RLS would filter reports
  `row_security_would_filter` instead of partial counts);
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
SQL 72 to 81; the tool proves the endpoint is the production RDS. Never from
GitHub-hosted runners or Lambda.

## Steps (each needs owner approval)

0. **Staging executor package.** Run the guarded staging SQL executor with `mode: inspect`
   (any `migration`) to read the live executor `CodeSha256`, then `mode: deploy`,
   `approved_commit: <main sha>`, `expected_executor_code_sha256: <CodeSha256>` so the
   executor carries the SQL 82 / 83 files and handlers.
1. **Staging read-live (read-only)** (done 2026-10-16, runs 48 and 49): `mode: read-live`,
   `migration: sql82-homeowner-ledger-view`, `approved_commit: <main sha>`,
   `expected_executor_code_sha256` optional, `expected_live_definition_sha256` empty. Then
   the same with `migration: sql83-homeowner-signing-capabilities`. Expect
   `pin_executable` false, `precondition_failures` `[]`,
   `homeowner_inspect.functions.aws_public_homeowner_ledger_by_token.raw_endorse_token_link`
   true (Cursor SQL 73), the SQL 83 functions `exists` true or false (Cursor SQL 74),
   `row_security_off_supported` true. If `precondition_failures` is not empty (another
   signature, a non-jsonb result, other parameter names, another owner, an extra grantee,
   FORCE RLS), **stop**: that needs its own reviewed change.
2. **Staging pin change (reviewed PR)** (this change records both): set each staging pin's
   `expected_live_definition_sha256` to the read-live `live_definition_sha256`.
3. **Staging apply:** `mode: apply`, `migration: sql82-homeowner-ledger-view`,
   `approved_commit`, `expected_executor_code_sha256`, `expected_live_definition_sha256:
   <the recorded hash>` (pre → `04e41eed…`), then `read-live` (`already_applied` true);
   then the same for `sql83-homeowner-signing-capabilities` (pre → `78da4219…`).
4. **Transfer:** dispatch `.github/workflows/sql53-temporary-transfer.yml` on main and copy
   `TARBALL_SHA256` from its log.
5. **Production inspect (read-only)** (done 2026-10-16, SSM `f1430894…`), on the runner from the freshly extracted tree (see
   the SSM block in `ops/production-sql-one-shot.md`):
   `node scripts/deployment-guard/sql82-homeowner-ledger-production-apply.mjs --inspect`, then
   `node scripts/deployment-guard/sql83-homeowner-signing-production-apply.mjs --inspect`.
   The one-shot refuses a pin with `execute: false`, so this first inspect is the tool's
   own. Expect `pre_state_recorded` false, `apply_preconditions_met` false (nothing
   recorded yet) and `precondition_failures` `[]`. If `precondition_failures` is not
   empty, **stop**.
6. **Production pin change (reviewed PR, owner-merged).** Already recorded (this change):
   each inspect in `production_inspect` (date, SSM command id, source commit,
   `live_definition_sha256`, `function_states`, the functions' arguments / owner / proacl,
   `precondition_failures`, `apply_preconditions_met`, `status: "recorded"`) and
   `live_definition_sha256` copied into `expected_live_definition_sha256`. Still to do,
   after the staging apply and a fresh production `--inspect` that reports the same
   `live_definition_sha256` and `precondition_failures` `[]`: record the staging apply run
   in `staging_acceptance` (`ok: true`, `reference`), set `execute: true` and record the
   approval in `authorization` (it must start with `Owner approved` or `owner-approved`;
   `"pending"` refuses even with `execute: true`). Merge to main and stage it with step 4 again.
7. **Run** (one-shot, `ops/production-sql-one-shot.md`), SQL 82 first:
   `--migration sql82 --approval-scope sql82`, `--phase inspect`, then for the approved
   run `--phase apply`; then the same with `sql83`. The one-shot runs the inspect, the
   contracts, the manifest, `preflight.mjs --acquire-lease --receipt`, evaluate, apply and
   the post-apply inspect. By hand instead, per migration:
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
   - **Apply:** `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1 CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT=<receipt> node scripts/deployment-guard/sql82-homeowner-ledger-production-apply.mjs --apply --input <manifest>`
     (or `sql83-homeowner-signing-production-apply.mjs`). One transaction, `lock_timeout`
     5s, advisory locks `sqlNN_homeowner_functions` and
     `sqlNN_homeowner_functions_production`. If the tool reports the COMMIT outcome as
     unknown, run `--inspect` before anything else.
   - **Verify:** `--inspect` again: `already_applied` true, `live_definition_sha256` the
     intended hash, every function `matches_migration` true, `proacl` as above.
8. **Record and retire:** a reviewed change records the evidence in the pin and sets
   `execute` back to `false`.

## Rollback (a separate owner-approved operation)

There is no automatic rollback. To return to the previous body, re-run the previous
reviewed definition (for SQL 82, the recorded pre-state's source) as `checksops_admin`
through its own guarded change. Never drop the functions: the API calls them as
`checksops`.
