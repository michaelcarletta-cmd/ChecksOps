# Production SQL 77, 78 and 79 (check stakeholder writes)

Three migrations, applied to production **in this order**, one run each:

| Migration | File | What it does | Pin |
|---|---|---|---|
| `sql77` | `aws/workflows/sql/77_check_stakeholders_write_grant.sql` | `GRANT SELECT, INSERT, DELETE ON public.check_stakeholders TO checksops, authenticated` | `ops/deployment-guard/sql77-check-stakeholders-grant-production-apply.json` |
| `sql78` | `aws/workflows/sql/78_check_partner_stakeholder_removals.sql` | creates `public.check_partner_stakeholder_removals` (composite FK to `shared_checks`, indexes, RLS, two policies, grants) | `ops/deployment-guard/sql78-check-partner-stakeholder-removals-production-apply.json` |
| `sql79` | `aws/workflows/sql/79_member_stakeholder_writes.sql` | four `aws_member_*` INSERT/DELETE policies on those two tables | `ops/deployment-guard/sql79-member-stakeholder-writes-production-apply.json` |

**Status:** not applied to production.

- **SQL 77: execute-authorized** (`execute: true`), not applied. The reviewed change that
  set it recorded:
  - `authorization`: the owner's approval on 2026-10-15 of the SQL 77 production pin
    (8f2417b5 → 0cd3ab3f) and the read-only production inspects; `execute: true` takes
    effect only when the owner reviews and merges that change. It does not itself run or
    approve a run: each apply still needs the owner's run-time approval for that
    workstream (the manifest's `approval`), a production-sql receipt owning the pinned
    file, the authorization phrase and a new `one_use_id`.
  - `staging_acceptance` (unchanged, recorded earlier): `ok: true`, reference
    `https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38574715440` (guarded
    staging SQL executor apply run #26 on main `06dcdd9ae`, pin commit `b70fadfb`,
    staging `71465932…` → `e4d49ffa…`, result applied).
  - `production_inspect.latest`: the read-only inspect with this tool, SSM command
    `84e1d7c3-ccb6-44b2-bfb1-04eaee7307a6` (2026-10-15, main `4404e1af8`): live
    `8f2417b5…` = expected, `apply_preconditions_met` true, `precondition_failures` `[]`,
    `preserved_acl_sha256` `c40af23b…`, `checksops`' four entries all granted by
    `checksops_admin`, `checksops_grant_option` false, `column_update_entries` `[]`,
    `authenticated_member_of_checksops` false. That run predates the owner checks below,
    so the step 1 inspect before the apply must show them passing.
  - `production_inspect.catalog_read`: read-only catalog read, SSM command
    `316cfa35-489e-42d1-9957-3bb4b73c8923` (2026-10-15, main `60772dbf7`, connected as
    `checksops_admin`): `public.check_stakeholders` owner `checksops_admin`, RLS on, ACL
    `{checksops_admin=arwdDxtm/checksops_admin,checksops=arwd/checksops_admin}`. Full
    entries: `checksops` DELETE/INSERT/SELECT/UPDATE granted by `checksops_admin`;
    `checksops_admin` DELETE/INSERT/MAINTAIN/REFERENCES/SELECT/TRIGGER/TRUNCATE/UPDATE
    granted by `checksops_admin`. So the preserved ACL `c40af23b…` covers only the
    owner's own entries; no other grantee holds any privilege.
    `public.check_partner_stakeholder_removals` does not exist yet (SQL 78 creates it).
    Memberships: `checksops` is a member of `authenticated`; `checksops_admin` is a
    member of `rds_superuser`; no role is superuser or BYPASSRLS.
  - The apply runs as `checksops_admin`, which owns the table and granted `checksops`'
    entries. So SQL 77's GRANTs to `checksops` are byte-identical no-ops, and only
    `authenticated` gains SELECT/INSERT/DELETE (granted by `checksops_admin`).
- **SQL 78 and SQL 79:** `authorization: "pending"`, `execute: false`, unchanged. Each
  needs its own reviewed execute change after SQL 77 (and, for SQL 79, SQL 78) is
  applied and its own read-only inspect.

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

## SQL 77 apply on the runner (execute-authorized; needs the owner's run-time approval)

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
