# Production SQL 77, 78 and 79 (check stakeholder writes)

Three migrations, applied to production **in this order**, one run each:

| Migration | File | What it does | Pin |
|---|---|---|---|
| `sql77` | `aws/workflows/sql/77_check_stakeholders_write_grant.sql` | `GRANT SELECT, INSERT, DELETE ON public.check_stakeholders TO checksops, authenticated` | `ops/deployment-guard/sql77-check-stakeholders-grant-production-apply.json` |
| `sql78` | `aws/workflows/sql/78_check_partner_stakeholder_removals.sql` | creates `public.check_partner_stakeholder_removals` (composite FK to `shared_checks`, indexes, RLS, two policies, grants) | `ops/deployment-guard/sql78-check-partner-stakeholder-removals-production-apply.json` |
| `sql79` | `aws/workflows/sql/79_member_stakeholder_writes.sql` | four `aws_member_*` INSERT/DELETE policies on those two tables | `ops/deployment-guard/sql79-member-stakeholder-writes-production-apply.json` |

**Status:** SQL 77 applied to production (2026-10-15) and retired; SQL 78
execute-authorized, not applied; SQL 79 pending.

- **SQL 77: applied 2026-10-15, retired** (`execute: false`). The pin's `authorization`
  now says it was applied and is no longer a standing authorization; a re-apply needs a
  new reviewed pin change. The owner approved the pin (8f2417b5 → 0cd3ab3f), the
  read-only inspects and that one run ("approve applying SQL 77 to production"). Evidence
  (pin `applied` and `production_evidence`):
  - Main `14027f993a54d34b2dec955a5a856bdf1f5fd4b5`, runner `i-0c35557c4e5385406`,
    workstream `prod-sql77-check-stakeholders-grant-20261015`, `one_use_id`
    `sql77-prod-97dff6e5-612c-4be1-abc2-7db4d38261fd`.
  - Pre-apply inspect and runner contracts, SSM `d6aaefb4-c337-4b85-865e-87e8b586d964`:
    live `8f2417b5…`, preconditions met, `table_owner` and `current_user`
    `checksops_admin`, `owner_roles` `["checksops_admin"]`,
    `authenticated_member_of_owner` false, `preserved_acl_sha256` `c40af23b…`,
    `table_acl` `{checksops_admin=arwdDxtm/checksops_admin,checksops=arwd/checksops_admin}`,
    the 12 `table_acl_entries` equal to the pin's `catalog_read`. Contracts:
    claim-ledger 4/4 and tenant-isolation 6/6 on the runner; financial-write-protections
    (`api-write.test.mjs`) 36/36 on the operator's clean checkout of the same commit (the
    runner's package lacks `@aws-sdk/client-s3`).
  - Receipt, evaluate, apply and verify, SSM `3f7ac222-30fb-40d4-9a06-e55b73b9ce5c`:
    result `applied`, before `8f2417b5…`, after `0cd3ab3f…`, `unrelated_catalog_sha256`
    `4aebe87f4c94c56b7d3133f2ce27a38f0328dcf36378b872c86267d428d0329c` (relations 855,
    columns 3407, constraints 2112, policies 362, functions 1274, triggers 173, roles 29,
    default_privileges 0, schema 1), staging acceptance run 38574715440. Post-apply
    inspect: live `0cd3ab3f…`, `already_applied` true, `table_acl`
    `{checksops_admin=arwdDxtm/checksops_admin,checksops=arwd/checksops_admin,authenticated=ard/checksops_admin}`,
    `preserved_acl_sha256` `c40af23b…` unchanged; `authenticated` SELECT/INSERT/DELETE
    granted, UPDATE absent; `checksops` unchanged (all four).
- **SQL 78: execute-authorized** (`execute: true`), not applied. The reviewed change that
  sets it records:
  - `authorization`: the owner approved the SQL 77 apply on 2026-10-15; the SQL 78 pin
    values (4031dea6 → 3d650a56) are unchanged from the reviewed pin and matched
    production's read-only inspect (SSM `3f7ac222-30fb-40d4-9a06-e55b73b9ce5c`);
    `execute: true` takes effect only when the owner reviews and merges that change. It
    does not itself run or approve a run: each apply still needs the owner's run-time
    approval for that workstream, a production-sql receipt owning the pinned file, the
    authorization phrase and a new `one_use_id`. **The owner has not yet approved a SQL 78
    run.**
  - `staging_acceptance` (unchanged, recorded earlier): `ok: true`, reference
    `https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38602758947` (guarded
    staging SQL executor apply run #31 on main `c6841346e`, 2026-10-14, staging
    `4031dea6…` (table absent) → `3d650a56…`). Production's pre-state is staging's (the
    table is absent in both), so the staging pins hold unchanged.
  - `production_inspect.latest`: the read-only inspect with this tool in SSM
    `3f7ac222-30fb-40d4-9a06-e55b73b9ce5c`, after the SQL 77 apply in the same command
    (main `14027f993`): live `4031dea6c0fbb70af1b17befa7ffb161fec40227cda080cd87c222dec674d269`
    = expected, `predecessors.sql77.applied` true, `apply_preconditions_met` true,
    `precondition_failures` `[]`. That run predates the SQL 78 owner checks below, so the
    step 1 inspect before the apply must show them passing.
  - `production_inspect.expected_table_owner`: `checksops_admin` (the login of the pinned
    secret; CREATE TABLE makes it the owner of the new table).
- **SQL 79:** `authorization: "pending"`, `execute: false`, unchanged. It needs its own
  reviewed execute change after SQL 78 is applied and its own read-only inspect.

After each apply, a follow-up reviewed change records the evidence in that pin and sets
`execute` back to `false`.

Tool: `scripts/deployment-guard/sql-member-stakeholder-production-apply.mjs --migration sql77|sql78|sql79`.

## Pins and staging acceptance

| | expected pre-state | intended post-state | staging apply |
|---|---|---|---|
| `sql77` | `8f2417b5…` (production: checksops SELECT/INSERT/UPDATE/DELETE, authenticated nothing) | `0cd3ab3f…` (checksops unchanged, all four; authenticated SELECT/INSERT/DELETE, no UPDATE) | run #26 [38574715440](https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38574715440) (staging `71465932…` → `e4d49ffa…`) |
| `sql78` | `4031dea6…` (table absent) | `3d650a56…` | run #31 [38602758947](https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38602758947) |
| `sql79` | `d9bc8921…` (reviewed policies only, pinned helper bodies) | `878d6441…` | run #34 [38612871864](https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38612871864) |

The hashes are the staging executor's own fingerprints
(`readStakeholderGrantState`, `readPartnerStakeholderRemovalsState`,
`readMemberStakeholderWritesState` in `aws/write-path/guarded-sql-executor/index.mjs`;
the tool loads that module from an isolated copy). SQL 78's and SQL 79's are the
staging pins in `scripts/deployment-guard/lib/sql-executor-auth.mjs`; SQL 77's are
production-specific (below). Production is expected to read
the same pre-state, but may not: for example SQL 79's fingerprint includes whether
the login that runs the file owns both tables, and SQL 77's includes the two
grantees' current privileges. If inspect reads a different live hash, **stop**: the
apply refuses, and a different pre-state needs its own reviewed pin change.

**SQL 77 production pin (2026-10-15).** That happened for SQL 77. The owner-approved
read-only inspect (SSM command `ca4ad39d`) read `8f2417b5…`: `checksops` already holds
SELECT, INSERT, UPDATE and DELETE on `public.check_stakeholders` (staging: SELECT only),
`authenticated` nothing; RLS, the reviewed write policy, no other write policy, no RLS
bypass, `tenant_guard_ok` all as expected; `preserved_acl_sha256` `c40af23b…`. It
reported `precondition_failures: ["update_not_granted"]`. The SQL 77 pin now expects
that state. The SQL file is unchanged (same `source_sha256`): re-granting
SELECT/INSERT/DELETE to `checksops` is a no-op, so `checksops` keeps all four
(UPDATE included, no REVOKE) and only `authenticated` gains SELECT/INSERT/DELETE. The
intended hash `0cd3ab3f…` is what `readStakeholderGrantState` reads after the file on
a PostgreSQL 16 fixture of the production pre-state, so it differs from staging's
`e4d49ffa…`; the staging acceptance reference is still run #26.

The production tool replaces the staging `update_not_granted` rule with a
production-only rule (the staging executor is unchanged). SQL 77 pre-apply: every
other staging condition (table, RLS, reviewed write policy, no other write policy,
no RLS bypass, `tenant_guard_ok`), `checksops` holds exactly the four privileges,
`authenticated` holds none, and the only non-owner UPDATE on either stakeholder table
is `checksops` on `check_stakeholders`, without grant option. Also refused, before and
after (SQL 77 and SQL 79): any grant option on any `checksops` entry on
`check_stakeholders` (e.g. `checksops=a*r*w*d*`); `authenticated` being a member of
`checksops`, directly or through other roles (`pg_auth_members`, recursive); and any
column-level UPDATE grant (`pg_attribute.attacl`) on either stakeholder table to anyone
but the table owner. SQL 77 pre-apply also requires `preserved_acl_sha256` to equal the
production inspect's `c40af23b…` (pin `production_inspect.preserved_acl_sha256`;
failure `preserved_acl_as_inspected`), so any other ACL entry on the table, such as
`PUBLIC` REFERENCES, stops it. Post-apply: the intended hash, `authenticated` exactly
SELECT/INSERT/DELETE, `checksops`' ACL entries (grantor and grant option included)
byte-identical, `preserved_acl_sha256` and the unrelated-catalog snapshot unchanged.
The staging pre-state (`71465932…`) is refused. These production-only reads are
schema-qualified through `pg_namespace` and never enter a fingerprint.

**SQL 77 owner checks (before and after; added with the execute change).** The live
owner of `public.check_stakeholders` must equal the pin's
`production_inspect.table_owner` (`checksops_admin`; failure `table_owner_as_inspected`);
`current_user` must equal that owner (`current_user_is_table_owner`), so the tool runs as
the role that granted `checksops`' entries and SQL 77's grants keep one grantor; and
`authenticated` must not be a member of that owner role (`authenticated_not_member_of_owner`),
walking `pg_auth_members` recursively and counting every grant, **INHERIT FALSE and SET
FALSE included**. A grant with SET TRUE is also caught by the staging reader's bypass check
(`grantee_does_not_bypass_rls`), but one with both INHERIT FALSE and SET FALSE is invisible
to `has_table_privilege` and `pg_has_role`, and only this walk refuses it (both are in the
PostgreSQL test). An unreadable
answer, a missing owner role or a pin without `table_owner` counts as a member. Post-apply
also requires the owner unchanged (`table_owner_unchanged`). The flags sit beside the
fingerprint (never hashed), so `8f2417b5…` and `0cd3ab3f…` are unchanged by these checks.
`--inspect` prints `table_owner`, `current_user`, `owner_roles`,
`authenticated_member_of_owner`, `table_acl` and `table_acl_entries` (every entry in plain
text, the owner's own included, as `<grantee> <PRIVILEGE> granted by <grantor>`).

**SQL 78 owner checks (added with the SQL 78 execute change).** SQL 78 creates
`public.check_partner_stakeholder_removals`, so the login that runs the file owns it, and
its GRANT is recorded with that login as grantor. Its staging rules (`table_absent`,
`prerequisites_ok`, `grantee_does_not_bypass_rls`, `default_acl_as_expected`; post:
the intended hash, `tenant_guard_ok`) had no owner or login check, so the production tool
adds, like SQL 77's: before, `current_user` must equal the pin's
`production_inspect.expected_table_owner` (`checksops_admin`;
`current_user_is_expected_owner`) and `authenticated` must not be a member of that role
(`authenticated_not_member_of_owner`, the same recursive `pg_auth_members` walk, INHERIT
FALSE and SET FALSE included; unreadable or missing counts as a member). After: the new
table's owner is that role (`table_owner_as_expected`) and is the login
(`current_user_is_table_owner`), `authenticated` is still not a member of it, the table's
non-owner ACL is exactly `authenticated` and `checksops` DELETE/INSERT/SELECT
`granted by checksops_admin`, no grant option (`grantee_entries_as_reviewed`), and nobody
holds a column-level UPDATE on it (`no_column_update_grants`; column ACLs are neither in
the fingerprint nor in the unrelated-catalog snapshot, which skips the new table). These
reads sit beside the fingerprint, so `4031dea6…` and `3d650a56…` are unchanged. `--inspect`
prints `table_owner` (null until the table exists), `current_user`, `owner_roles`,
`authenticated_member_of_owner`, `table_acl` and `table_acl_entries`.

SQL 78 and SQL 79 pins are unchanged: SQL 78's fingerprint covers only the new table
and SQL 79's covers RLS, policies, ownership and the helper functions, not ACLs, so
`d9bc8921…` → `878d6441…` holds in production too (reproduced on the same fixture).
But SQL 79's staging rule also refuses any UPDATE grant (`update_not_granted`, and
through it `tenant_guard_ok`), which `checksops`' kept UPDATE trips. Its production
variant checks every other part of `tenant_guard_ok` by name and accepts only that
one UPDATE (before and after); any other UPDATE on either table is refused.

## Where it runs

Only on the SQL53 runner `i-0c35557c4e5385406` in `vpc-09f2268778966ce97`, from the
reviewed main source staged by `.github/workflows/sql53-temporary-transfer.yml`.
Never from GitHub-hosted runners or Lambda. Set
`AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com`.
Same production RDS (`checksops-production`), pinned host and `checksops_admin`
secret as SQL 72; the tool still proves the endpoint is the production RDS.

## SQL 77 apply on the runner (done 2026-10-15; pin retired)

This is the procedure the 2026-10-15 run followed (evidence under **Status**). The SQL 77
pin is `execute: false` again, so the tool refuses to run it; a re-apply needs a new
reviewed pin change.


Run on `i-0c35557c4e5385406` from a checkout of reviewed main that contains the
execute-authorized SQL 77 pin (staged by `.github/workflows/sql53-temporary-transfer.yml`),
with `AWS_ENDPOINT_URL_SECRETS_MANAGER` set as above. `<main sha>` is that checkout's full
commit. The tool connects with the pinned `checksops_admin` secret.

1. **Inspect (read-only):**
   `node scripts/deployment-guard/sql-member-stakeholder-production-apply.mjs --migration sql77 --inspect`
   runs in `BEGIN READ ONLY … ROLLBACK` and only SELECTs. Proceed only when
   `pin_execute` true, `source_ok` true, `missing_dependencies` `[]`,
   `live_definition_sha256` `8f2417b5a97dd330185de62de29658c9a04a8b6d70672c0df7494834597ad57e`,
   `live_matches_expected` true, `already_applied` false, `precondition_failures` `[]`,
   `apply_preconditions_met` true, `table_owner` and `current_user` `checksops_admin`,
   `owner_roles` `["checksops_admin"]`, `authenticated_member_of_owner` false,
   `state.preserved_acl_sha256` `c40af23b…`, `table_acl`
   `{checksops_admin=arwdDxtm/checksops_admin,checksops=arwd/checksops_admin}` and
   `table_acl_entries` exactly the twelve lines in the pin's
   `production_inspect.catalog_read.table_acl_entries`. If anything differs, **stop**: a
   different pre-state needs its own reviewed pin change.
2. **Contracts:** on the same checkout run
   `node --test aws/tests/claim-ledger-accepted-contract.test.mjs` and
   `node --test aws/tests/tenant-security-compliance.test.mjs`; run
   `node --test aws/tests/api-write.test.mjs` on a **clean checkout of the same commit
   elsewhere** (the runner's package lacks `@aws-sdk/client-s3`, so `api-write.test.mjs`
   cannot load there, as for SQL 80 on 2026-10-15). Record them as `contract_results`
   (`claim-ledger`, `tenant-isolation`, `financial-write-protections`, each
   `{ ok, test, evidence }`, the api-write evidence naming the clean checkout); preflight
   refuses `sql-apply` without them.
3. **Manifest** (for example `sql77-manifest.json`, outside the repo):

   ```json
   {
     "workstream_id": "prod-sql77-check-stakeholders-grant-<yyyymmdd>",
     "branch": "main",
     "commit": "<main sha>",
     "operator": "michaelcarletta-cmd",
     "target_environment": "production",
     "target_component": "production-sql",
     "deployment_type": "sql-apply",
     "owned_components": ["aws/workflows/sql/77_check_stakeholders_write_grant.sql"],
     "filename": "aws/workflows/sql/77_check_stakeholders_write_grant.sql",
     "migration_id": "77_check_stakeholders_write_grant",
     "source_sha256": "ed7f1c809b8c66c63e60c4d3504b3cbcbf8088ad1336f418b72a26f528029ec1",
     "expected_live_definition_sha256": "8f2417b5a97dd330185de62de29658c9a04a8b6d70672c0df7494834597ad57e",
     "intended_replacement_sha256": "0cd3ab3fd41245ad9f35e882dc32bcb36cd9720132f63ad88728df655290ddac",
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
     "authorization_phrase": "GRANT_CHECK_STAKEHOLDERS_WRITE",
     "one_use_id": "sql77-prod-<new uuid>",
     "build_timestamp": "<now, ISO 8601>",
     "contract_results": "<from step 2>"
   }
   ```

   The tool refuses unless `filename`, `migration_id`, `source_sha256`,
   `expected_live_definition_sha256` and `live_definition_sha256` equal the pin's,
   `staging_acceptance.reference` equals the pin's (`…/actions/runs/38574715440`),
   `approval.workstream_id` is this workstream, the phrase is exactly
   `GRANT_CHECK_STAKEHOLDERS_WRITE`, `one_use_id` matches `^[A-Za-z0-9._:-]{8,128}$` and
   was never consumed, and the receipt owns the SQL 77 file (a receipt for another
   migration's file is `RECEIPT_MISMATCH`).
4. **Lease and receipt** on the same host:
   `node scripts/deployment-guard/preflight.mjs --acquire-lease --receipt --input sql77-manifest.json`
   (prints the receipt path; a staging receipt cannot authorize production).
5. **Evaluate (no connection):**
   `node scripts/deployment-guard/sql-member-stakeholder-production-apply.mjs --migration sql77 --input sql77-manifest.json`
   must print `member_stakeholder_production_apply_allowed: true`.
6. **Apply:**
   `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1 CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT=<receipt> node scripts/deployment-guard/sql-member-stakeholder-production-apply.mjs --migration sql77 --apply --input sql77-manifest.json`.
   The receipt is spent only after the guard, the receipt-ownership, execute, phrase,
   `one_use_id` and replay checks pass and the secret resolves. One transaction,
   `lock_timeout` 5s, advisory locks `sql77_79_member_stakeholder_production` and
   `sql77_check_stakeholders_grant`; it re-reads every precondition (the owner checks
   included) inside the transaction, runs the pinned file once and rolls back unless the
   after-state is `0cd3ab3f…`, every postcondition holds and the unrelated-catalog snapshot
   is unchanged. If the tool reports the COMMIT outcome as unknown, run step 1 before
   anything else.
7. **Verify:** re-run step 1: `already_applied` true, `live_definition_sha256`
   `0cd3ab3fd41245ad9f35e882dc32bcb36cd9720132f63ad88728df655290ddac`,
   `authenticated_member_of_owner` false, `table_acl_entries` = the twelve pre-apply lines
   plus `authenticated DELETE/INSERT/SELECT granted by checksops_admin` (expected
   `table_acl` `{checksops_admin=arwdDxtm/checksops_admin,checksops=arwd/checksops_admin,authenticated=ard/checksops_admin}`),
   `state.preserved_acl_sha256` still `c40af23b…`. Then
   `node scripts/deployment-guard/sql-member-stakeholder-production-apply.mjs --migration sql78 --inspect`
   must show `predecessors.sql77.applied` true.
8. **Record and retire:** a reviewed change records the evidence (receipt, before/after
   hashes, ACL entries, SSM ids) in the SQL 77 pin and sets its `execute` back to `false`.

## SQL 78 apply on the runner (execute-authorized; needs the owner's run-time approval)

Run on `i-0c35557c4e5385406` from a checkout of reviewed main that contains the
execute-authorized SQL 78 pin (staged by `.github/workflows/sql53-temporary-transfer.yml`),
with `AWS_ENDPOINT_URL_SECRETS_MANAGER` set as above. `<main sha>` is that checkout's full
commit. The tool connects with the pinned `checksops_admin` secret.

1. **Inspect (read-only):**
   `node scripts/deployment-guard/sql-member-stakeholder-production-apply.mjs --migration sql78 --inspect`
   runs in `BEGIN READ ONLY … ROLLBACK` and only SELECTs. Proceed only when
   `pin_execute` true, `source_ok` true, `missing_dependencies` `[]`,
   `predecessors.sql77.applied` true (live `0cd3ab3f…`), `live_definition_sha256`
   `4031dea6c0fbb70af1b17befa7ffb161fec40227cda080cd87c222dec674d269`,
   `live_matches_expected` true, `already_applied` false, `precondition_failures` `[]`,
   `apply_preconditions_met` true, `current_user` `checksops_admin`, `table_owner` null,
   `owner_roles` `["checksops_admin"]`, `authenticated_member_of_owner` false,
   `table_acl_entries` `[]`. If anything differs, **stop**: a different pre-state needs its
   own reviewed pin change.
2. **Contracts:** on the same checkout run
   `node --test aws/tests/claim-ledger-accepted-contract.test.mjs` and
   `node --test aws/tests/tenant-security-compliance.test.mjs`; run
   `node --test aws/tests/api-write.test.mjs` on a **clean checkout of the same commit
   elsewhere** (the runner's package lacks `@aws-sdk/client-s3`). Record them as
   `contract_results` (`claim-ledger`, `tenant-isolation`, `financial-write-protections`,
   each `{ ok, test, evidence }`, the api-write evidence naming the clean checkout);
   preflight refuses `sql-apply` without them.
3. **Manifest** (for example `sql78-manifest.json`, outside the repo):

   ```json
   {
     "workstream_id": "prod-sql78-check-partner-stakeholder-removals-<yyyymmdd>",
     "branch": "main",
     "commit": "<main sha>",
     "operator": "michaelcarletta-cmd",
     "target_environment": "production",
     "target_component": "production-sql",
     "deployment_type": "sql-apply",
     "owned_components": ["aws/workflows/sql/78_check_partner_stakeholder_removals.sql"],
     "filename": "aws/workflows/sql/78_check_partner_stakeholder_removals.sql",
     "migration_id": "78_check_partner_stakeholder_removals",
     "source_sha256": "d4a33174a546e0623f22397db93eb4c622214f6ff2336e65c110449162797420",
     "expected_live_definition_sha256": "4031dea6c0fbb70af1b17befa7ffb161fec40227cda080cd87c222dec674d269",
     "intended_replacement_sha256": "3d650a56a2fd8a4ccfaeaf795ac0de8c4d0b849a748c1769400397d62e92dd40",
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
     "authorization_phrase": "CREATE_CHECK_PARTNER_STAKEHOLDER_REMOVALS",
     "one_use_id": "sql78-prod-<new uuid>",
     "build_timestamp": "<now, ISO 8601>",
     "contract_results": "<from step 2>"
   }
   ```

   The tool refuses unless `filename`, `migration_id`, `source_sha256`,
   `expected_live_definition_sha256` and `live_definition_sha256` equal the pin's,
   `staging_acceptance.reference` equals the pin's (`…/actions/runs/38602758947`),
   `approval.workstream_id` is this workstream, the phrase is exactly
   `CREATE_CHECK_PARTNER_STAKEHOLDER_REMOVALS`, `one_use_id` matches
   `^[A-Za-z0-9._:-]{8,128}$` and was never consumed, and the receipt owns the SQL 78 file
   (a receipt for another migration's file is `RECEIPT_MISMATCH`).
4. **Lease and receipt** on the same host:
   `node scripts/deployment-guard/preflight.mjs --acquire-lease --receipt --input sql78-manifest.json`
   (prints the receipt path; a staging receipt cannot authorize production).
5. **Evaluate (no connection):**
   `node scripts/deployment-guard/sql-member-stakeholder-production-apply.mjs --migration sql78 --input sql78-manifest.json`
   must print `member_stakeholder_production_apply_allowed: true`.
6. **Apply:**
   `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1 CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT=<receipt> node scripts/deployment-guard/sql-member-stakeholder-production-apply.mjs --migration sql78 --apply --input sql78-manifest.json`.
   The receipt is spent only after the guard, the receipt-ownership, execute, phrase,
   `one_use_id` and replay checks pass and the secret resolves. One transaction,
   `lock_timeout` 5s, advisory locks `sql77_79_member_stakeholder_production` and
   `sql78_check_partner_stakeholder_removals`; it re-checks that SQL 77 is applied and
   every precondition (the owner checks included) inside the transaction, runs the pinned
   file once and rolls back unless the after-state is `3d650a56…`, every postcondition
   holds and the unrelated-catalog snapshot (everything in schema public but the new table)
   is unchanged. If the tool reports the COMMIT outcome as unknown, run step 1 before
   anything else.
7. **Verify:** re-run step 1: `already_applied` true, `live_definition_sha256`
   `3d650a56a2fd8a4ccfaeaf795ac0de8c4d0b849a748c1769400397d62e92dd40`, `table_owner` and
   `current_user` `checksops_admin`, `authenticated_member_of_owner` false, and
   `table_acl_entries` = the owner's own entries plus `authenticated` and `checksops`
   DELETE/INSERT/SELECT `granted by checksops_admin` (expected `table_acl`
   `{checksops_admin=arwdDxtm/checksops_admin,checksops=ard/checksops_admin,authenticated=ard/checksops_admin}`
   on a server with MAINTAIN). Then
   `node scripts/deployment-guard/sql-member-stakeholder-production-apply.mjs --migration sql79 --inspect`
   must show `predecessors.sql78.applied` true.
8. **Record and retire:** a reviewed change records the evidence (receipt, before/after
   hashes, ACL entries, SSM ids) in the SQL 78 pin and sets its `execute` back to `false`.

## Steps per migration (each needs owner approval; do 77, then 78, then 79)

1. **Inspect (read-only):**
   `node scripts/deployment-guard/sql-member-stakeholder-production-apply.mjs --migration sql77 --inspect`
   runs in `BEGIN READ ONLY … ROLLBACK`. It reports `dependencies` /
   `missing_dependencies` (by name, e.g. "primary key or unique constraint on
   public.shared_checks (check_id, source_tenant_id, target_tenant_id)"),
   `predecessors` (SQL 78 needs SQL 77 applied; SQL 79 needs 77 and 78),
   `live_definition_sha256`, `live_matches_expected`, `precondition_failures`,
   `already_applied` and `apply_preconditions_met`. Proceed only when
   `apply_preconditions_met` is true.
2. **Pin change (reviewed PR):** set that migration's `execute: true` and record the
   approval in `authorization`. Merge to main and stage main on the runner.
3. **Contracts:** run `aws/tests/claim-ledger-accepted-contract.test.mjs`,
   `aws/tests/tenant-security-compliance.test.mjs` and `aws/tests/api-write.test.mjs`
   on the same source and record them as `contract_results` in the manifest
   (preflight refuses `sql-apply` without them).
4. **Manifest** (`sql-apply`, `production`, `production-sql`): the pin's
   `filename`, `migration_id`, `source_sha256`, `expected_live_definition_sha256`;
   `live_definition_sha256` = `"<live hash from step 1>"`;
   `preflight_live_fingerprint` = `production_fingerprint` =
   `immediately_before_fingerprint` = `{ "sql": "<live hash from step 1>" }`;
   the pin's `staging_acceptance`; `approval` for this workstream; the pin's
   `authorization_phrase` (`GRANT_CHECK_STAKEHOLDERS_WRITE`,
   `CREATE_CHECK_PARTNER_STAKEHOLDER_REMOVALS` or
   `CREATE_MEMBER_STAKEHOLDER_WRITE_POLICIES`); a new `one_use_id`; and
   `owned_components` = `["<pin filename>"]` (the tool refuses a receipt that does
   not own that migration's file, so one receipt never covers another migration).
5. **Lease and receipt** on the same host:
   `node scripts/deployment-guard/preflight.mjs --acquire-lease --receipt --input <manifest>`.
6. **Apply:**
   `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1 CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT=<receipt> node scripts/deployment-guard/sql-member-stakeholder-production-apply.mjs --migration sql77 --apply --input <manifest>`.
   One transaction, `lock_timeout` 5s, advisory locks for the series and for the
   migration. It refuses if a dependency is missing, the migration is already in
   place, a predecessor is not applied, a staging pre-apply rule fails, or the live
   hash is not the pin's expected hash (and the manifest's). It rolls back unless the
   after-state is the pin's intended hash, the staging post-apply rules hold, and
   everything else in schema public (relations, columns, constraints, policies,
   functions, triggers, table ACLs, roles and memberships, default privileges, the
   schema ACL) is byte-identical. If the tool reports the COMMIT outcome as unknown,
   run step 1 before anything else.
7. **Verify:** re-run step 1; `already_applied` must be true. Then the next
   migration's inspect must show its predecessor as applied.
8. **Record and retire:** a reviewed change records the evidence in the pin and sets
   `execute` back to `false`.

## Rollback (each a separate owner-approved operation, in reverse order)

- SQL 79: `DROP POLICY` the four `aws_member_*` policies. Admin/staff writes keep working.
- SQL 78: `DROP TABLE public.check_partner_stakeholder_removals` (only after SQL 79 is
  rolled back and the API no longer writes it; recorded removals are lost).
- SQL 77: `REVOKE SELECT, INSERT, DELETE ON public.check_stakeholders FROM authenticated`,
  run **as the table owner** (the role SQL 77 recorded as grantor; a REVOKE by another
  role leaves the owner-granted entry in place). In production `checksops` already
  held all four privileges before SQL 77, so its privileges are not revoked
  (staging: `REVOKE INSERT, DELETE … FROM checksops` too). Then re-run the SQL 77
  inspect: `live_definition_sha256` must read `8f2417b5…` again (and
  `preserved_acl_sha256` `c40af23b…`).
