# Production Mortgage Desk access inspect (read-only)

`scripts/deployment-guard/mortgage-desk-access-production-inspect.mjs --inspect` reports
what is really live in production for the Mortgage Desk, without changing anything. Under
the repository's older RLS and grants (12, 24, SQL 50), a Mortgage Agent who is not a member
of the requesting tenant could not read, accept or update `mortgage_handling_requests`, while
the Desk was in use in production. This inspect shows the live policies, grants and helpers so
that drift can be seen, and records the ownership facts SQL 99 needs. The 2026-10-17 run (below)
confirmed the drift; SQL 100 now records the live access in the repository.

It is inspect-only. It has no pin, no `execute`, no apply, no `--input`, no receipt and no
one-shot entry. The configuration in
`ops/deployment-guard/mortgage-desk-access-production-inspect.json` names the same
production RDS and `checksops_admin` secret as the SQL 99 pin.

## What it reads

The tool runs one `BEGIN READ ONLY … ROLLBACK` with `search_path` set to `pg_catalog`, a 20 s
statement timeout and a 2 s lock timeout. Inside it, it runs only the fixed catalog SELECTs in
`Q` (`lib/mortgage-desk-access-inspect.mjs`). It reads no table rows and no row counts.

| section | content |
|---|---|
| `tables.<t>` for `mortgage_handling_requests`, `check_intake_items`, `check_messages`, `mortgage_agent_accounts` | owner; `rls_enabled`; `rls_forced`; every policy (name, command, permissive, roles, `using` / `with_check` text and sha256, `depends_on_functions`, `created_in_repo` and `repo_sources`); `grants` for `checksops`, `authenticated`, `PUBLIC` and `checksops_admin` (table ACL entries with grantor and grant option; column ACL by privilege, plus `column_acl_entries` (column, privilege, grant option and grantor of every entry) and `column_acl_grantors`; effective table / any-column privileges); non-internal triggers (name and function name only); for the policies on `mortgage_handling_requests` also `comment` (`present` and `sha256`; the hash is computed in the database from `obj_description(oid, 'pg_policy')`, the text is never read out) |
| `functions` | `aws_can_write_tenant`, `aws_can_access_tenant`, `aws_is_tenant_member`, `aws_is_cross_tenant_reader`, `aws_is_active_mortgage_agent`, `mortgage_agent_can_view_check` and `auth.uid`, every overload: owner, SECURITY DEFINER, language, volatility, proconfig names, `sets_row_security`, `functiondef_sha256` (of `pg_get_functiondef`), `prosrc_sha256`, the EXECUTE grants (`execute_acl`: every `aclexplode(proacl)` entry with grantee, `PUBLIC` included, grantor and grant option; the default ACL when `proacl` is NULL, `execute_acl_default`; `public_execute`), `repo_match` |
| `policy_dependency_functions` | the same for every other function a policy above depends on (`pg_depend`) |
| `roles`, `role_memberships` | superuser / BYPASSRLS / INHERIT / LOGIN for the three roles, and their `pg_auth_members` rows (names and options) |
| `sql99_ownership` | the functions of `trg_mirror_check_message_to_homeowner_ledger` and `assign_case_on_ledger_events`, resolved from `pg_trigger` (owner, SECURITY DEFINER, `sets_row_security`, hashes); owner and RLS / FORCE of `homeowner_ledger_events`, `profiles`, `check_cases`, `check_messages` and `mortgage_handling_requests`; SQL 99's own preconditions as booleans, with `precondition_failures`; whether SQL 99's objects already exist |

**Repo comparison.** `repo_match` compares the live `prosrc` with the body of every
`CREATE [OR REPLACE] FUNCTION` of that name in the `.sql` files under `aws/` and `supabase/`.
The result is `exact`, `whitespace_only` or `differs_from_repo`. `matched_sources` and
`matched_kinds` name the matching files (`aws_sql`, `supabase_migration`, `test_fixture`,
`unapplied`). The comparison uses `prosrc` because `pg_get_functiondef` is a server rendering
that no repository file contains byte for byte; `functiondef_sha256` is reported for
run-to-run comparison.

**Redaction.**
- A function's definition text is printed only when `repo_match` is `differs_from_repo` and
  every literal is a role name. Role names are live roles, `app_role` labels and the
  application role words in `APP_ROLE_WORDS`; `search_path` schema names and `''` are also
  allowed. The text must also have no comment at all (`comment_present`), no `"quoted
  identifier"` other than a known schema, table, column or role name
  (`quoted_identifier_beyond_known_names`), no nested dollar-quoted or `E''` string, no
  number longer than 4 digits, and nothing shaped like a UUID, email or long number anywhere.
  Otherwise the report says `definition_withheld: "differs from repo (<reason>)"`.
- Policy expressions (`using` / `with_check`) go through the same allowlist, plus a fixed list
  of repository status words (`POLICY_STATUS_WORDS`: `mortgage_handling_requests.status`
  `requested`, `in_progress`, `completed`, `cancelled`; `mortgage_agent_accounts.status`
  `active`, `inactive`), so a live agent policy can be copied into the repo. If one has a
  UUID-, email- or long-number-shaped literal, `text_withheld` names that; if it has any
  other literal beyond role and schema names (a company name, SSN, phone, ULID, tenant slug,
  status value ...), an unknown quoted identifier or a number over 4 digits, `text_withheld`
  is `literal_beyond_role_names`. Either way only the sha256 is printed.
- Errors, a failed connection included, report only the stage and the error's code
  (SQLSTATE or a Node `E*` code): never a message, hostname, stack or credential.

## Run (SSM runner `i-0c35557c4e5385406`)

This runs only after the change is merged to main. First stage that main commit with
`.github/workflows/sql53-temporary-transfer.yml` and copy `TARBALL_SHA256` from its log. Then
send one SSM command as in `ops/production-sql-one-shot.md`. No password or connection string
is a parameter: the tool reads the pinned admin secret through the VPC endpoint.

```bash
set -euo pipefail
SHA=<full main sha>
TARBALL_SHA256=<TARBALL_SHA256 from the transfer run log>
WORK=$(mktemp -d /var/tmp/mortgage-desk-inspect-XXXXXX)
cd "$WORK"
aws s3 cp "s3://checksops-sql53-transfer-806168576068/sql53/source-${SHA}.tar.gz" . --no-progress
aws s3 cp "s3://checksops-sql53-transfer-806168576068/sql53/source-${SHA}.tar.gz.sha256" . --no-progress
echo "${TARBALL_SHA256}  source-${SHA}.tar.gz" | sha256sum -c -
mkdir src
tar -xzf "source-${SHA}.tar.gz" -C src
cd src
test "$(cat SOURCE_COMMIT)" = "$SHA"
AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com \
  node scripts/deployment-guard/mortgage-desk-access-production-inspect.mjs --inspect
```

Record the date, SSM command ids and source commit in `production_inspect` of the
configuration file, in a reviewed change. Running this inspect authorizes nothing: no SQL 99
apply, no policy or grant change.

## Production inspect of 2026-10-17

Run at source commit `09aa7ab00`, SSM commands `ee5c42a3-fe1b-4da8-bb84-106766285bfa`,
`45d46a8f-beeb-4ea7-9b1e-598fe6b980b4` and `041bc13d-70fa-4f43-805a-e4d7b22afd19` (recorded in
`production_inspect`). It found that production has Mortgage Desk agent access the repository
lacked. `aws/workflows/sql/100_mortgage_desk_live_access.sql` writes that live state into the
repository. It is not an access change: applied to production it is a no-op. It lives in
`aws/workflows/sql/` because `aws/rls/sql/` is covered by the `database-rls` release-lock tree
hash; it comes after `12_final_select_policies.sql`, `24_complete_write_policies.sql` and SQL 50,
and leaves a rebuilt database where production is. It is numbered 100, after SQL 98 (tenant fee
collection) and SQL 99 (the Desk completion trigger).

Live on `public.mortgage_handling_requests` (owner `checksops_admin`, RLS enabled, not forced):

| policy | command | roles | in the repository before SQL 100 |
|---|---|---|---|
| `aws_select_mortgage_handling_requests` | SELECT | authenticated | yes, without the third OR term `aws_mortgage_agent_queue_visible(status, assigned_employee_id)` |
| `aws_select_mortgage_ops_agent_queue` | SELECT | authenticated, checksops | no |
| `aws_update_mortgage_ops_accept_complete` | UPDATE | authenticated, checksops | no |
| `aws_insert_mortgage_handling_requests` | INSERT | authenticated | no |
| `aws_delete_mortgage_handling_requests` | DELETE | authenticated | no |

Drift findings:

- The repository's `aws_write_mortgage_handling_requests` (FOR ALL, 24) is **not** live. Live has
  no tenant-writer UPDATE policy: only agents update a request, through
  `aws_update_mortgage_ops_accept_complete` (Accept an unassigned `requested` request to
  `in_progress` with `accepted_at`; Complete / Cancel only when assigned to the caller; never
  reassign or return to `requested`).
- Grants: `checksops` has table DELETE, INSERT, SELECT and column UPDATE on 17 columns (SQL 50's
  13 plus `accepted_at`, `assigned_employee_id`, `cancelled_at`, `completed_at`).
  `authenticated` has only column UPDATE on `accepted_at`, `assigned_employee_id`,
  `completed_at`; SQL 50 also grants it table SELECT, INSERT, DELETE and 13 UPDATE columns,
  none of which is live.
- `public.aws_is_mortgage_ops_agent()` (prosrc sha256 `787bad58…`) and
  `public.aws_mortgage_agent_queue_visible(text, uuid)` (`b9f70c8b…`) are live (SECURITY
  DEFINER, sql, STABLE, owner `checksops_admin`, `row_security` + `search_path`) and were not in
  the repository. Their bodies were found on unmerged Mortgage Ops branches (SQL 39
  `mortgage_ops_agent_accept_complete`, `mortgage_ops_agent_access` 29 / 31) with prosrc sha256
  equal to the live values.
- `public.aws_is_active_mortgage_agent(uuid)` is live with prosrc equal to the SQL 47 test
  fixture (`2bba15b2…`); SQL 100 records it when `mortgage_agent_accounts` exists.
- Live triggers: `mortgage_handling_requests_set_updated_at`, `tr_accrue_mortgage_ops_billing`,
  `tr_earn_mortgage_agent_compensation`, `tr_reject_inactive_mortgage_agent_accept`,
  `trg_mirror_mortgage_dates`, `trg_share_library_docs_to_mortgage_request`. SQL 100 does not
  record triggers; `tr_accrue_mortgage_ops_billing` has no CREATE TRIGGER in a repository SQL
  file, and the two compensation triggers exist only in the SQL 47 test fixture.
- Confirmed against the production inspect output: `functiondef_sha256` matches live for all
  three helpers (`aws_is_mortgage_ops_agent` `9a0fd538…`, `aws_mortgage_agent_queue_visible`
  `e8012bab…`, `aws_is_active_mortgage_agent` `d8846afb…`; full values in the SQL 100 header
  and asserted by its PG test). The SET values (`search_path = public`, `row_security = off`) and
  the other attributes are therefore the live ones, not just the proconfig names.
- Confirmed against the production inspect output: `authenticated` has no table-level ACL entry
  on `mortgage_handling_requests`, so SQL 100's REVOKEs from `authenticated` are a no-op on
  production.
- Second production inspect, 2026-10-17 at source commit `969e2b2b1` (SSM
  `24b9f38c-d721-4b82-b3a5-056c6c84d37a`, with `sql100-…-production-apply.mjs --inspect`): it
  reports the three items the first run could not. Helper EXECUTE grants are not the default:
  `aws_is_mortgage_ops_agent()` authenticated and checksops (no PUBLIC),
  `aws_mortgage_agent_queue_visible(text, uuid)` PUBLIC and checksops,
  `aws_is_active_mortgage_agent(uuid)` PUBLIC, authenticated and checksops (every entry granted by
  the owner). `aws_update_mortgage_ops_accept_complete` has a comment (sha256 `34ef5bf7…`), equal
  to SQL 39's `COMMENT ON POLICY` text on the cursor Mortgage Ops branches; the other four policies
  have none. Every table and column ACL entry is granted by `checksops_admin`. SQL 100 now records
  all of it; its intended fingerprint equals this run's live one (`52c00e3a…`). Function comments
  survive CREATE OR REPLACE and are not reported.

Future cleanup (not done now): the stale Supabase policies "Owner tenant staff can insert
checks" and "Owner tenant staff can update checks" on `check_intake_items` (`has_role` admin /
staff) are still live.

`aws/tests/sql100-mortgage-desk-live-access-pg.test.mjs` applies the repository sequence plus
SQL 100 to PostgreSQL 16, runs this inspect's library against it and checks that the policy
texts, grants and helper prosrc hashes equal the production values above, that every table and
column ACL entry's grantor is `checksops_admin`, that only the Accept / Complete policy has a
comment (sha256 equal to production's) and that the helpers have production's EXECUTE grants.

Tests: `aws/tests/mortgage-desk-access-production-inspect.test.mjs`, in
`npm run test:deployment-guard`. The PostgreSQL 16 part checks that a non-superuser
`checksops_admin` sends only allowlisted read-only statements, that nothing changes, and that
no row data or ids are printed. It also checks that repository helpers report `exact`, that
drifted helpers and policies are flagged, and that FORCE RLS on `check_messages` fails SQL 99's
precondition.
