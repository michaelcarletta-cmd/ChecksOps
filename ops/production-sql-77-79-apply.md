# Production SQL 77, 78 and 79 (check stakeholder writes)

Three migrations, applied to production **in this order**, one run each:

| Migration | File | What it does | Pin |
|---|---|---|---|
| `sql77` | `aws/workflows/sql/77_check_stakeholders_write_grant.sql` | `GRANT SELECT, INSERT, DELETE ON public.check_stakeholders TO checksops, authenticated` | `ops/deployment-guard/sql77-check-stakeholders-grant-production-apply.json` |
| `sql78` | `aws/workflows/sql/78_check_partner_stakeholder_removals.sql` | creates `public.check_partner_stakeholder_removals` (composite FK to `shared_checks`, indexes, RLS, two policies, grants) | `ops/deployment-guard/sql78-check-partner-stakeholder-removals-production-apply.json` |
| `sql79` | `aws/workflows/sql/79_member_stakeholder_writes.sql` | four `aws_member_*` INSERT/DELETE policies on those two tables | `ops/deployment-guard/sql79-member-stakeholder-writes-production-apply.json` |

**Status:** not applied to production. All three pins are `authorization: "pending"`,
`execute: false`. The owner flips `execute` (and records the approval in
`authorization`) in a separate reviewed change **per migration**, after that
migration's read-only inspect below, the same way SQL 72 was done. After each apply,
a follow-up change records the evidence and sets `execute` back to `false`.

Tool: `scripts/deployment-guard/sql-member-stakeholder-production-apply.mjs --migration sql77|sql78|sql79`.

## Pins and staging acceptance

| | expected pre-state | intended post-state | staging apply |
|---|---|---|---|
| `sql77` | `71465932…` (checksops SELECT only, authenticated nothing) | `e4d49ffa…` (both SELECT/INSERT/DELETE, no UPDATE) | run #26 [38574715440](https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38574715440) |
| `sql78` | `4031dea6…` (table absent) | `3d650a56…` | run #31 [38602758947](https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38602758947) |
| `sql79` | `d9bc8921…` (reviewed policies only, pinned helper bodies) | `878d6441…` | run #34 [38612871864](https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38612871864) |

The hashes are the staging executor's own fingerprints
(`readStakeholderGrantState`, `readPartnerStakeholderRemovalsState`,
`readMemberStakeholderWritesState` in `aws/write-path/guarded-sql-executor/index.mjs`;
the tool loads that module from an isolated copy). They are the staging pins in
`scripts/deployment-guard/lib/sql-executor-auth.mjs`. Production is expected to read
the same pre-state, but may not: for example SQL 79's fingerprint includes whether
the login that runs the file owns both tables, and SQL 77's includes the two
grantees' current privileges. If inspect reads a different live hash, **stop**: the
apply refuses, and a different pre-state needs its own reviewed pin change.

## Where it runs

Only on the SQL53 runner `i-0c35557c4e5385406` in `vpc-09f2268778966ce97`, from the
reviewed main source staged by `.github/workflows/sql53-temporary-transfer.yml`.
Never from GitHub-hosted runners or Lambda. Set
`AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com`.
Same production RDS (`checksops-production`), pinned host and `checksops_admin`
secret as SQL 72; the tool still proves the endpoint is the production RDS.

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
- SQL 77: `REVOKE INSERT, DELETE ON public.check_stakeholders FROM checksops, authenticated`
  and `REVOKE SELECT … FROM authenticated` (checksops keeps SELECT).
