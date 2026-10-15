# Production SQL 80 (Check Alt Auto-Deposit save for tenant operators)

| | |
|---|---|
| File | `aws/workflows/sql/80_checkalt_member_auto_deposit.sql` (source sha256 `3ca77bf4…`, staging pin commit `4a7c1053f`) |
| Pin | `ops/deployment-guard/sql80-checkalt-member-auto-deposit-production-apply.json` |
| Tool | `scripts/deployment-guard/sql80-checkalt-production-apply.mjs` (lib `scripts/deployment-guard/lib/sql80-checkalt-production-apply.mjs`) |
| Test | `aws/tests/sql80-checkalt-production-apply.test.mjs` |

**Status:** applied 2026-10-15. The pin's `execute` is back to `false`, so it is no longer a
standing authorization; a re-apply needs a new reviewed pin change. The evidence is in the
pin's `applied` and `production_evidence`:

- **Approval:** the owner approved the pin values (dce5b131 → 5ad9a81c) and the read-only
  production inspect on 2026-10-15, and approved this one apply run on 2026-10-15 with
  "approve applying SQL 80 to production".
- **Run:** main `60772dbf72c7bb912fc6210f50ddcecd26fde433` on `i-0c35557c4e5385406`,
  workstream `prod-sql80-checkalt-member-auto-deposit-20261015`, `one_use_id`
  `sql80-prod-e527ba94-d5b0-45f5-bd2c-2fbb96f7d7cd`.
- **Pre-apply inspect** (SSM `93c5591a-2af2-4a41-9790-fad6b58f5afc`): live `dce5b131…`,
  `apply_preconditions_met` true, `owner_roles` `["checksops_admin"]`,
  `authenticated_member_of_owner` false.
- **Contracts:** claim-ledger 4/4 and tenant-isolation 6/6 on the runner (same SSM);
  financial-write-protections (`aws/tests/api-write.test.mjs`) 36/36 on the operator's clean
  checkout of the same commit (see the note under step 2).
- **Receipt, evaluate, apply and verify** (SSM `b3221877-8d75-44e7-b76c-ae9420e2d73c`):
  `result` applied, `before_hash` `dce5b13151f4b6c6fe7660e0ef9576d4a80e80ad66cfcffbad6d880ad8a07d65`,
  `after_hash` `5ad9a81cfc01ba8affc165b42986c1a6e7ce87c5f61df6a5ebcac293e00fa0db`;
  function ACL `{=X/checksops_admin,checksops_admin=X/checksops_admin,checksops=X/checksops_admin}`
  → `{checksops_admin=X/checksops_admin,checksops=X/checksops_admin,authenticated=X/checksops_admin}`;
  table ACL unchanged (`{checksops_admin=arwdDxtm/checksops_admin,checksops=arwd/checksops_admin}`);
  unrelated catalog `2f83e42f8e1f3dabbe389bd59263089b61d26cfe3833179fd72773bc51f82c22`
  unchanged (relations 855, columns 3407, constraints 2112, policies 362, functions 1273,
  triggers 173, roles 29, default privileges 0, schema 1); staging acceptance run
  `38723636938`. An earlier SSM `64fb1530-ab13-415f-b998-cb6ba3e757d9` issued a receipt via
  preflight and then stopped before evaluate on an operator script parsing error; nothing
  was applied by it. That same unspent receipt and manifest were then used by
  `b3221877…`, which spent the receipt once.
- **Post-apply inspect** (same SSM `b3221877…`): live `5ad9a81c…`, `already_applied` true,
  `function_states` definition intended / comment intended, `authenticated_member_of_owner`
  false.

Before the apply, the reviewed change that set `execute: true` recorded the
`staging_acceptance` (`ok: true`, reference
`https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38723636938`: guarded staging
SQL executor apply of `sql80-checkalt-member-auto-deposit`, run #39 on main `ba2047117`,
staging `3ef657f4…` → `5ad9a81c…`, `acl_sha256` `5e51925f…` unchanged; read-live run
`38723779280` (#40) confirmed `already_applied`) and `production_inspect.latest` (SSM
`da23b804-07c0-4c93-b686-cb8b0bb36de5`, main `43377df1a`: live `dce5b131…` = expected,
`apply_preconditions_met` true).

## What the apply changes in production (plain words)

Written before the apply; "today" below means the pre-apply state. On
`public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb)` only, in one transaction:

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
(recursive); `authenticated` is not a member of the function's or the table's owner
role (the pin's inspected `function_owner`/`table_owner`, `checksops_admin`), recursively
through `pg_auth_members`, **INHERIT FALSE and SET FALSE grants included** (such a
membership is invisible to `has_any_column_privilege` but still reaches the owner, e.g.
by `SET ROLE`); the roles, tables and helper functions the body calls exist; the live
fingerprint equals the pin's and the manifest's. The staging pre-state is refused.
The membership flags sit beside the fingerprint (in the production-only detail, never
hashed), so `expected_live_definition_sha256` and `intended_replacement_sha256` are
unchanged by the owner-membership rule.

**After (rolled back otherwise):** the intended fingerprint; the live definition equals
the one reconstructed from the pinned file; the SQL 80 comment; non-owner EXECUTE
exactly `authenticated` and `checksops`, no PUBLIC, no grant option, `proacl` equal to
the pin's `intended_post_state.function_acl`; same owner; table ACL, owner and entries
byte-identical to before; every "before" table rule still holds; and the unrelated
catalog snapshot (relations and their ACLs, columns, constraints, policies, triggers,
every other function in `public`, every function in `auth`, roles and memberships,
default privileges, the schema ACL) unchanged.

## PostgreSQL 18 caveat

Production runs PostgreSQL 18.3; the default test fixture runs on PostgreSQL 16. The
fingerprints and the reviewed `pg_get_functiondef` text were re-derived on 18.3 only with
`SQL80_PG18_BIN` set (it passed for this change with the embedded 18.3 binaries, the
owner-membership refusals included), not in CI. `pg_get_functiondef` output can differ
between major versions. That is safe: the apply compares the live
`pg_get_functiondef` after SQL 80 with the definition reconstructed from the pinned file
(`sql80ReviewedFunctiondef`, sha256 `97c5bddc…`) inside the transaction, and **rolls
back** (`UNRELATED_MUTATION`, `definition_is_reviewed_sql80` in `failed`) if they differ.
Production is then unchanged (still `dce5b131…`); stop and fix the reconstruction in a
reviewed change, never by editing the pin's hashes by hand.

## Where it runs

Only on the SQL53 runner `i-0c35557c4e5385406` in `vpc-09f2268778966ce97`, from the
reviewed main source staged by `.github/workflows/sql53-temporary-transfer.yml`. Never
from GitHub-hosted runners or Lambda. Set
`AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com`.
Same production RDS (`checksops-production`), pinned host and `checksops_admin` secret
as SQL 72; the tool proves the endpoint is the production RDS.

## Steps (each needs owner approval)

These steps are kept as the record of how the 2026-10-15 apply ran. The committed pin is
retired (`execute: false`), so step 6 (apply) now refuses without connecting
(`GUARD_APPLY_FORBIDDEN` even with a receipt that owns the file, and the receipt is not
spent); any re-run needs a new reviewed pin change first.

Run on `i-0c35557c4e5385406` from a checkout of reviewed main that contains the
execute-authorized pin (staged by `.github/workflows/sql53-temporary-transfer.yml`), with
`AWS_ENDPOINT_URL_SECRETS_MANAGER` set as above. `<main sha>` is that checkout's full
commit.

1. **Inspect (read-only):**
   `node scripts/deployment-guard/sql80-checkalt-production-apply.mjs --inspect`
   runs in `BEGIN READ ONLY … ROLLBACK` and only SELECTs. It prints the readable
   `function_acl`, `function_acl_entries` (with grantor), `function_owner`,
   `table_acl`, `table_acl_entries`, `table_owner`, `table_update_entries`,
   `column_update_entries`, `authenticated_can_update_table`,
   `authenticated_member_of_checksops`, `owner_roles`, `authenticated_member_of_owner`,
   `pin_execute`, the staging `state`, `live_definition_sha256`,
   `live_matches_expected`, `precondition_failures`, `already_applied` and
   `apply_preconditions_met`. Proceed only when `apply_preconditions_met` is true,
   `pin_execute` true, `live_definition_sha256` `dce5b131…`, `owner_roles`
   `["checksops_admin"]` and `authenticated_member_of_owner` false. If anything differs,
   **stop**: a different pre-state needs its own reviewed pin change.
2. **Contracts:** on the same checkout run
   `node --test aws/tests/claim-ledger-accepted-contract.test.mjs`,
   `node --test aws/tests/tenant-security-compliance.test.mjs` and
   `node --test aws/tests/api-write.test.mjs`, and record them as `contract_results`
   (`claim-ledger`, `tenant-isolation`, `financial-write-protections`, each
   `{ ok, test, evidence }`); preflight refuses `sql-apply` without them.
   The runner's package lacks `@aws-sdk/client-s3`, so `aws/tests/api-write.test.mjs`
   cannot load there; run it on a clean checkout of the same commit elsewhere (as on
   2026-10-15) and record that as its `evidence`.
3. **Manifest** (for example `sql80-manifest.json`, outside the repo):

   ```json
   {
     "workstream_id": "prod-sql80-checkalt-member-auto-deposit-<yyyymmdd>",
     "branch": "main",
     "commit": "<main sha>",
     "operator": "michaelcarletta-cmd",
     "target_environment": "production",
     "target_component": "production-sql",
     "deployment_type": "sql-apply",
     "owned_components": ["aws/workflows/sql/80_checkalt_member_auto_deposit.sql"],
     "filename": "aws/workflows/sql/80_checkalt_member_auto_deposit.sql",
     "migration_id": "80_checkalt_member_auto_deposit",
     "source_sha256": "3ca77bf4d3bfe0d09645bec2d8bf86517f60a0804935fe6aff68a61f92747352",
     "expected_live_definition_sha256": "dce5b13151f4b6c6fe7660e0ef9576d4a80e80ad66cfcffbad6d880ad8a07d65",
     "intended_replacement_sha256": "5ad9a81cfc01ba8affc165b42986c1a6e7ce87c5f61df6a5ebcac293e00fa0db",
     "live_definition_sha256": "<live hash from step 1>",
     "preflight_live_fingerprint": { "sql": "<live hash from step 1>" },
     "production_fingerprint": { "sql": "<live hash from step 1>" },
     "immediately_before_fingerprint": { "sql": "<live hash from step 1>" },
     "staging_acceptance": "<the pin's staging_acceptance object, verbatim>",
     "approval": {
       "approved": true,
       "workstream_id": "<same workstream_id>",
       "approved_by": "owner",
       "statement": "<the owner's run-time approval of this apply>"
     },
     "authorization_phrase": "REPLACE_CHECKALT_AUTO_DEPOSIT_SAVE",
     "one_use_id": "sql80-prod-<new uuid>",
     "build_timestamp": "<now, ISO 8601>",
     "contract_results": "<from step 2>"
   }
   ```

   The tool refuses unless `filename`, `migration_id`, `source_sha256`, both pinned
   hashes and `live_definition_sha256` equal the pin's, `staging_acceptance.reference`
   equals the pin's, `approval.workstream_id` is this workstream, the phrase is exact,
   `one_use_id` matches `^[A-Za-z0-9._:-]{8,128}$` and was never consumed, and the
   receipt owns the pinned file.
4. **Lease and receipt** on the same host:
   `node scripts/deployment-guard/preflight.mjs --acquire-lease --receipt --input sql80-manifest.json`
   (prints the receipt path; a staging receipt cannot authorize production).
5. **Evaluate (no connection):**
   `node scripts/deployment-guard/sql80-checkalt-production-apply.mjs --input sql80-manifest.json`
   must print `sql80_production_apply_allowed: true`.
6. **Apply:**
   `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1 CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT=<receipt> node scripts/deployment-guard/sql80-checkalt-production-apply.mjs --apply --input sql80-manifest.json`.
   The receipt is spent only after the execute, phrase, `one_use_id`, replay and
   receipt-ownership checks pass and the secret resolves. One transaction,
   `lock_timeout` 5s, advisory locks `sql80_checkalt_member_auto_deposit` and
   `sql80_checkalt_member_auto_deposit_production`; it re-reads every precondition
   (the owner-membership rule included) inside the transaction, runs the pinned file
   once and rolls back unless every postcondition holds, the live `pg_get_functiondef`
   equals the reconstructed SQL 80 definition, and the unrelated catalog snapshot is
   unchanged. If the tool reports the COMMIT outcome as unknown, run step 1 before
   anything else.
7. **Verify:** re-run step 1: `already_applied` true, `live_definition_sha256`
   `5ad9a81c…`, `function_acl` as in "after" above, `table_acl` unchanged,
   `authenticated_member_of_owner` false.
8. **Record and retire:** a reviewed change records the evidence (receipt, before/after
   hashes and ACLs) in the pin and sets `execute` back to `false`. Done for the 2026-10-15
   apply (see Status).

## Rollback (a separate owner-approved operation)

Re-run SQL 38's `CREATE OR REPLACE FUNCTION` statement only (as `checksops_admin`), which
restores the admin/owner-only body. Restoring the old grants is a separate decision: the
pre-apply state gave PUBLIC EXECUTE and no comment; it is not recommended to re-grant
PUBLIC. The API writer (`save_checkalt_tenant_auto_deposit` in
`aws/functions/api/workflow-rpc.mjs`) calls the function as `checksops`, which keeps
EXECUTE either way.
