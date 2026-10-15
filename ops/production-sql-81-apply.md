# Production SQL 81 (Check Alt production depositor registration writer)

| | |
|---|---|
| File | `aws/workflows/sql/81_checkalt_production_register.sql` (source sha256 `88aafdac…`, staging pin commit `e13efe663`) |
| Pin | `ops/deployment-guard/sql81-checkalt-production-register-production-apply.json` |
| Tool | `scripts/deployment-guard/sql81-checkalt-production-apply.mjs` (lib `scripts/deployment-guard/lib/sql81-checkalt-production-apply.mjs`) |
| Test | `aws/tests/sql81-checkalt-production-apply.test.mjs` |
| Staging | guarded staging SQL executor, migration `sql81-checkalt-depositor-register` (test `aws/tests/sql81-checkalt-depositor-register-executor.test.mjs`) |

**Status:** applied to production on 2026-10-15 (SSM `6c0422a9-5712-4f15-bb83-54565b0d35fb`,
workstream `prod-sql81-checkalt-register-20261015`, main `787007faf`: `e12fdf2f…` →
`36623cce…`). The pin records the run in `applied` and is `execute: false` again, so
evaluate and apply refuse; a re-apply needs a new reviewed pin change.

## What the apply changes in production (plain words)

In one transaction, one new function and nothing else:

1. **New function** `public.aws_register_checkalt_tenant_account(uuid, jsonb)`: the
   only writer of a tenant's production Check Alt depositor identity (`sso_user_id`,
   `deposit_account_number`, first/last name, email, `enabled`, `registered_at` and a
   masked `last_register_payload`). Only the platform owner (`public.is_platform_owner()`)
   may call it successfully; tenant users, platform admins and staff are refused. It
   validates every field (account number 5 to 17 digits, payload without the full
   number), never touches `auto_approve_*` (SQL 80 owns those), and returns the account
   number as last four only. SECURITY DEFINER with `search_path=public,
   row_security=off`, owned by the login that runs the apply (`checksops_admin`).
2. **Comment:** the SQL 81 comment.
3. **EXECUTE grants:** PUBLIC's default EXECUTE is revoked; the owner, `checksops`
   and `authenticated` can execute it:
   `{checksops_admin=X/checksops_admin,checksops=X/checksops_admin,authenticated=X/checksops_admin}`.
   The API (`aws/functions/api/providers/production/checkalt-register.mjs`) calls it as
   `checksops`.

Nothing else changes. `public.checkalt_tenant_accounts`' ACL stays byte-identical
(`{checksops_admin=arwdDxtm/checksops_admin,checksops=arwd/checksops_admin}`); SQL 81
grants no table privilege. No table, column, policy, trigger, role, default privilege,
other function in `public` or `auth`, or schema ACL changes.

## Pin

| | fingerprint | state |
|---|---|---|
| expected pre-state | `e12fdf2fe609d474a9cc215c018cce922cc2a63edfd18f7b5988ce21d1903f37` | function absent; no function named `aws_register_checkalt_tenant_account` in any schema |
| intended post-state | `36623ccebd920a9c6316da7f787ad99126e474656877e01b5854e099ce661225` | SQL 81 body (`d1f781ed…`), SQL 81 comment (`e48465b4…`), SECURITY DEFINER, reviewed config, owned by the executor role, EXECUTE for checksops and authenticated only |
| staging (for comparison) | `e12fdf2f…` → `36623cce…` | the same: the function is new in both |

Both are the staging executor's own fingerprint (`readCheckaltRegisterState` /
`checkaltRegisterStateText` in `aws/write-path/guarded-sql-executor/index.mjs` and
`scripts/deployment-guard/lib/sql-executor-auth.mjs`; the owner's own ACL entry is not
part of it, so the post-state equals staging's). They are code-derived and re-read from
PostgreSQL 16 fixtures of the staging and production pre-states. The production fixture
(table owned by `checksops_admin`, `checksops` arwd, function absent) runs on
PostgreSQL 16 and, with `SQL81_PG18_BIN` set, on PostgreSQL 18. (PostgreSQL 16 has no
MAINTAIN privilege, so the 16 fixture pins the `arwdDxt` spelling of the owner's table
entry.) Independently of the constant, the apply compares the live `pg_get_functiondef`
with the definition reconstructed from the pinned file's own body
(`sql81ReviewedFunctiondef`), and rolls back if they differ.

The pin's table owner and ACL are the values the SQL 80 production apply read and left
unchanged on 2026-10-15 (SSM `b3221877-8d75-44e7-b76c-ae9420e2d73c`). No SQL 81
production inspect has run yet; step 1 must confirm them.

## Production rules (instead of the staging handler's)

The staging handler requires that neither `checksops` nor `authenticated` can INSERT or
UPDATE `checkalt_tenant_accounts`; production grants `checksops` arwd, so the staging
handler is unchanged and this tool carries production rules.

**Before (refused otherwise):** the connected login (`current_user` and `session_user`)
is the pinned function owner `checksops_admin`; no function named
`aws_register_checkalt_tenant_account` in any schema; the roles `checksops` and
`authenticated`, the tables `checkalt_tenant_accounts` and `tenants`, every column the
body writes, a plain unique index on `tenant_id` and `public.is_platform_owner()` exist;
table ACL and owner byte-equal to the pinned ones; the only non-owner table INSERT and
UPDATE are `checksops`' without grant option; no grant option on any table entry; no
column-level INSERT or UPDATE grant; `authenticated` cannot INSERT or UPDATE any column by
any route (`has_any_column_privilege`); `authenticated` is not a member of `checksops`
nor of the owner role (recursive, INHERIT FALSE grants included); the live fingerprint
equals the pin's and the manifest's.

**After (rolled back otherwise):** the intended fingerprint; exactly one function of that
name; the live definition equals the one reconstructed from the pinned file; the SQL 81
comment; SECURITY DEFINER with the reviewed config; owned by the login, which is the
pinned owner; non-owner EXECUTE exactly `authenticated` and `checksops`, no PUBLIC, no
grant option, `proacl` equal to the pin's `intended_post_state.function_acl`; table ACL,
owner and entries byte-identical to before; every "before" table rule still holds; and
the unrelated catalog snapshot (relations and their ACLs, columns, constraints, policies,
triggers, every other function in `public`, every function in `auth`, roles and
memberships, default privileges, the schema ACL) unchanged.

## Where it runs

Only on the SQL53 runner `i-0c35557c4e5385406` in `vpc-09f2268778966ce97`, from the
reviewed main source staged by `.github/workflows/sql53-temporary-transfer.yml`. Never
from GitHub-hosted runners or Lambda. Set
`AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com`.
Same production RDS (`checksops-production`), pinned host and `checksops_admin` secret
as SQL 72 and SQL 80; the tool proves the endpoint is the production RDS.

## Steps (each needs owner approval)

0. **Staging:** run the guarded staging SQL executor with migration
   `sql81-checkalt-depositor-register`: `read-live` first (expect
   `live_definition_sha256` `e12fdf2f…`, `exists` false, `overload_count` 0,
   `required_columns_present` true, `table_insert_granted` / `table_update_granted`
   false, `apply_preconditions_met` true), then `apply` (`e12fdf2f…` → `36623cce…`),
   then `read-live` again (`already_applied` true).
1. **Inspect (read-only):**
   `node scripts/deployment-guard/sql81-checkalt-production-apply.mjs --inspect`
   runs in `BEGIN READ ONLY … ROLLBACK` and only SELECTs. It prints `current_user`,
   `session_user`, `function_present`, the readable `function_acl` /
   `function_acl_entries` (empty before), `table_acl`, `table_acl_entries` (with
   grantor), `table_owner`, `table_write_entries`, `column_write_entries`,
   `authenticated_can_write_table`, `authenticated_member_of_checksops`, `owner_roles`,
   `authenticated_member_of_owner`, the staging `state`, `live_definition_sha256`,
   `live_matches_expected`, `precondition_failures`, `already_applied` and
   `apply_preconditions_met`. Proceed only when `apply_preconditions_met` is true
   (`live_definition_sha256` `e12fdf2f…`, `function_present` false). The one-shot
   refuses a pin with `execute: false`, so this first inspect is the tool's own.
   If anything differs, **stop**: a different pre-state needs its own reviewed pin change.
2. **Pin change (reviewed PR):** record the inspect in `production_inspect` (date, SSM
   command id, the values it printed, `status` no longer pending), the staging apply run
   in `staging_acceptance` (`ok: true`, `reference`), set `execute: true` and record the
   approval in `authorization`. Merge to main and stage main on the runner.
3. **Run:** preferably the one-shot (`ops/production-sql-one-shot.md`) with
   `--migration sql81 --approval-scope sql81`, `--phase inspect` then, for the approved
   run, `--phase apply`; it runs steps 4 to 8 below as one invocation. By hand instead:
4. **Contracts:** run `aws/tests/claim-ledger-accepted-contract.test.mjs`,
   `aws/tests/tenant-security-compliance.test.mjs` and `aws/tests/api-write.test.mjs`
   on the same source and record them as `contract_results` in the manifest.
5. **Manifest** (`sql-apply`, `production`, `production-sql`): the pin's `filename`,
   `migration_id`, `source_sha256`, `expected_live_definition_sha256`,
   `intended_replacement_sha256`; `live_definition_sha256` = `"<live hash from step 1>"`;
   `preflight_live_fingerprint` = `production_fingerprint` =
   `immediately_before_fingerprint` = `{ "sql": "<live hash from step 1>" }`; the pin's
   `staging_acceptance`; `approval` for this workstream; `authorization_phrase`
   `CREATE_CHECKALT_PRODUCTION_REGISTER_WRITER`; a new `one_use_id`;
   `owned_components` = `["aws/workflows/sql/81_checkalt_production_register.sql"]`.
6. **Lease and receipt** on the same host:
   `node scripts/deployment-guard/preflight.mjs --acquire-lease --receipt --input <manifest>`.
7. **Apply:**
   `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1 CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT=<receipt> node scripts/deployment-guard/sql81-checkalt-production-apply.mjs --apply --input <manifest>`.
   One transaction, `lock_timeout` 5s, advisory locks `sql81_checkalt_production_register`
   and `sql81_checkalt_production_register_production`. If the tool reports the COMMIT
   outcome as unknown, run step 1 before anything else.
8. **Verify:** re-run step 1: `already_applied` true, `live_definition_sha256`
   `36623cce…`, `function_owner` `checksops_admin`, `function_acl` as in "What the apply
   changes" above, `table_acl` unchanged.
9. **Record and retire:** a reviewed change records the evidence in the pin and sets
   `execute` back to `false`.

## Rollback (a separate owner-approved operation)

`DROP FUNCTION public.aws_register_checkalt_tenant_account(uuid, jsonb);` as
`checksops_admin`. Rows already written to `checkalt_tenant_accounts` stay. Without the
function the production register API refuses before calling Check Alt
(`register_writer_missing`), as it does before SQL 81.
