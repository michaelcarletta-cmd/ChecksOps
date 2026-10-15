# Production SQL 80 (Check Alt Auto-Deposit save for tenant operators)

| | |
|---|---|
| File | `aws/workflows/sql/80_checkalt_member_auto_deposit.sql` (source sha256 `3ca77bf4…`, staging pin commit `4a7c1053f`) |
| Pin | `ops/deployment-guard/sql80-checkalt-member-auto-deposit-production-apply.json` |
| Tool | `scripts/deployment-guard/sql80-checkalt-production-apply.mjs` (lib `scripts/deployment-guard/lib/sql80-checkalt-production-apply.mjs`) |
| Test | `aws/tests/sql80-checkalt-production-apply.test.mjs` |

**Status:** not applied to production. The pin is `authorization: "pending"`,
`execute: false`, and its `staging_acceptance` is still pending (`reference: null`), so
evaluate and apply refuse with `PRODUCTION_APPROVAL_REQUIRED`. The owner records the
staging apply run of `sql80-checkalt-member-auto-deposit`, flips `execute` and records
the approval in `authorization` in one separate reviewed change, after the read-only
inspect below. After the apply, a follow-up change records the evidence and sets
`execute` back to `false`.

## What the apply changes in production (plain words)

On `public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb)` only, in one transaction:

1. **Function body:** SQL 38's body is replaced by SQL 80's. Tenant users with role
   owner, admin, manager or operator (not only admin/owner) and the platform owner may
   save `auto_approve_enabled` / `auto_approve_max_cents` for their own tenant; viewers
   and unknown roles are refused; `auto_approve_enabled` must be a JSON boolean and
   `auto_approve_max_cents` JSON null or a non-negative integer that fits the column.
   Still SECURITY DEFINER with `search_path=public, row_security=off`, still the same
   owner (`checksops_admin`), still only those two columns plus `updated_at`.
2. **Comment:** the function gets the SQL 80 comment (it has none in production today).
3. **EXECUTE grants (an intended tightening):** today PUBLIC and `checksops` can execute
   it and `authenticated` has no explicit grant. After: the owner, `checksops` and
   `authenticated` can execute it; **PUBLIC loses EXECUTE**. That is what SQL 38 meant
   (its REVOKE/GRANT never ran in production) and what staging already has.
   - before `{=X/checksops_admin,checksops_admin=X/checksops_admin,checksops=X/checksops_admin}`
   - after `{checksops_admin=X/checksops_admin,checksops=X/checksops_admin,authenticated=X/checksops_admin}`

Nothing else changes. `public.checkalt_tenant_accounts`' ACL stays byte-identical
(`{checksops_admin=arwdDxtm/checksops_admin,checksops=arwd/checksops_admin}`; SQL 80
neither grants nor revokes table privileges, so `checksops` keeps its existing arwd).
No table, column, policy, trigger, role, default privilege, other function in
`public` or `auth`, or schema ACL changes.

## Pin

| | fingerprint | state |
|---|---|---|
| expected pre-state | `dce5b13151f4b6c6fe7660e0ef9576d4a80e80ad66cfcffbad6d880ad8a07d65` | SQL 38 body (`b7989db7…`), no comment, EXECUTE for PUBLIC and checksops |
| intended post-state | `5ad9a81cfc01ba8affc165b42986c1a6e7ce87c5f61df6a5ebcac293e00fa0db` | SQL 80 body (`97c5bddc…`), SQL 80 comment, EXECUTE for checksops and authenticated |
| staging (for comparison) | `3ef657f4…` → `5ad9a81c…` | staging had SQL 38's comment and grants |

Both are the staging executor's own fingerprint (`readCheckaltAutoDepositState` /
`checkaltAutoDepositStateText` in `aws/write-path/guarded-sql-executor/index.mjs` and
`scripts/deployment-guard/lib/sql-executor-auth.mjs`; the owner's own ACL entry is not
part of it, so the post-state equals staging's). They are code-derived and re-read from a
PostgreSQL fixture of the production pre-state (SQL 38's CREATE only, then
`GRANT EXECUTE … TO PUBLIC` and `TO checksops`, no comment, table owned by
`checksops_admin` with `checksops` arwd). The fixture runs on PostgreSQL 16 and, with
`SQL80_PG18_BIN` set, on PostgreSQL 18.3 (production's version), where it reproduces the
inspected function and table ACLs byte for byte and `pg_get_functiondef` of SQL 80 hashes
to the same `97c5bddc…` as on 16. (PostgreSQL 16 has no MAINTAIN privilege, so the 16
fixture pins the `arwdDxt` spelling of the owner's table entry.) Independently of that
constant, the apply compares the live `pg_get_functiondef` with the definition
reconstructed from the pinned file's own body (`sql80ReviewedFunctiondef`), and rolls
back if they differ.

## Production rules (instead of the staging handler's)

The staging handler requires EXECUTE for checksops and authenticated only and no table
UPDATE for either; production has neither, so the staging handler is unchanged and this
tool carries production rules.

**Before (refused otherwise):** exactly one function named
`aws_save_checkalt_tenant_auto_deposit` in any schema; SECURITY DEFINER; config
`search_path=public, row_security=off`; owned by the session user and equal to the
inspected owner `checksops_admin`; the SQL 38 body; no comment; non-owner EXECUTE
entries exactly `PUBLIC` and `checksops`, no grant option, and `proacl` byte-equal to
the inspected string; table ACL and owner byte-equal to the inspected ones; the only
non-owner table UPDATE is `checksops` without grant option; no grant option on any
table entry; no column-level UPDATE grant; `authenticated` cannot UPDATE any column by
any route (`has_any_column_privilege`); `authenticated` is not a member of `checksops`
(recursive); the roles, tables and helper functions the body calls exist; the live
fingerprint equals the pin's and the manifest's. The staging pre-state is refused.

**After (rolled back otherwise):** the intended fingerprint; the live definition equals
the one reconstructed from the pinned file; the SQL 80 comment; non-owner EXECUTE
exactly `authenticated` and `checksops`, no PUBLIC, no grant option, `proacl` equal to
the pin's `intended_post_state.function_acl`; same owner; table ACL, owner and entries
byte-identical to before; every "before" table rule still holds; and the unrelated
catalog snapshot (relations and their ACLs, columns, constraints, policies, triggers,
every other function in `public`, every function in `auth`, roles and memberships,
default privileges, the schema ACL) unchanged.

## Where it runs

Only on the SQL53 runner `i-0c35557c4e5385406` in `vpc-09f2268778966ce97`, from the
reviewed main source staged by `.github/workflows/sql53-temporary-transfer.yml`. Never
from GitHub-hosted runners or Lambda. Set
`AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com`.
Same production RDS (`checksops-production`), pinned host and `checksops_admin` secret
as SQL 72; the tool proves the endpoint is the production RDS.

## Steps (each needs owner approval)

1. **Inspect (read-only):**
   `node scripts/deployment-guard/sql80-checkalt-production-apply.mjs --inspect`
   runs in `BEGIN READ ONLY … ROLLBACK` and only SELECTs. It prints the readable
   `function_acl`, `function_acl_entries` (with grantor), `function_owner`,
   `table_acl`, `table_acl_entries`, `table_owner`, `table_update_entries`,
   `column_update_entries`, `authenticated_can_update_table`,
   `authenticated_member_of_checksops`, the staging `state`, `live_definition_sha256`,
   `live_matches_expected`, `precondition_failures`, `already_applied` and
   `apply_preconditions_met`. Proceed only when `apply_preconditions_met` is true
   (`live_definition_sha256` `dce5b131…`). If anything differs, **stop**: a different
   pre-state needs its own reviewed pin change.
2. **Pin change (reviewed PR):** record the staging apply run in `staging_acceptance`
   (`ok: true`, `reference`), set `execute: true` and record the approval in
   `authorization`. Merge to main and stage main on the runner.
3. **Contracts:** run `aws/tests/claim-ledger-accepted-contract.test.mjs`,
   `aws/tests/tenant-security-compliance.test.mjs` and `aws/tests/api-write.test.mjs`
   on the same source and record them as `contract_results` in the manifest.
4. **Manifest** (`sql-apply`, `production`, `production-sql`): the pin's `filename`,
   `migration_id`, `source_sha256`, `expected_live_definition_sha256`,
   `intended_replacement_sha256`; `live_definition_sha256` = `"<live hash from step 1>"`;
   `preflight_live_fingerprint` = `production_fingerprint` =
   `immediately_before_fingerprint` = `{ "sql": "<live hash from step 1>" }`; the pin's
   `staging_acceptance`; `approval` for this workstream; `authorization_phrase`
   `REPLACE_CHECKALT_AUTO_DEPOSIT_SAVE`; a new `one_use_id`; `owned_components` =
   `["aws/workflows/sql/80_checkalt_member_auto_deposit.sql"]`.
5. **Lease and receipt** on the same host:
   `node scripts/deployment-guard/preflight.mjs --acquire-lease --receipt --input <manifest>`.
6. **Apply:**
   `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1 CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT=<receipt> node scripts/deployment-guard/sql80-checkalt-production-apply.mjs --apply --input <manifest>`.
   One transaction, `lock_timeout` 5s, advisory locks `sql80_checkalt_member_auto_deposit`
   and `sql80_checkalt_member_auto_deposit_production`. If the tool reports the COMMIT
   outcome as unknown, run step 1 before anything else.
7. **Verify:** re-run step 1: `already_applied` true, `live_definition_sha256`
   `5ad9a81c…`, `function_acl` as in "after" above, `table_acl` unchanged.
8. **Record and retire:** a reviewed change records the evidence in the pin and sets
   `execute` back to `false`.

## Rollback (a separate owner-approved operation)

Re-run SQL 38's `CREATE OR REPLACE FUNCTION` statement only (as `checksops_admin`), which
restores the admin/owner-only body. Restoring the old grants is a separate decision: the
pre-apply state gave PUBLIC EXECUTE and no comment; it is not recommended to re-grant
PUBLIC. The API writer (`save_checkalt_tenant_auto_deposit` in
`aws/functions/api/workflow-rpc.mjs`) calls the function as `checksops`, which keeps
EXECUTE either way.
