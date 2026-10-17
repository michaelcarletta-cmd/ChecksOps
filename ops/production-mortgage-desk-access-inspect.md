# Production Mortgage Desk access inspect (read-only)

`scripts/deployment-guard/mortgage-desk-access-production-inspect.mjs --inspect` reports
what is really live in production for the Mortgage Desk, without changing anything. Under
the repository's RLS and grants, a Mortgage Agent who is not a member of the requesting
tenant cannot read, accept or update `mortgage_handling_requests`, but the Desk is believed
to be in use in production. This inspect shows the live policies, grants and helpers so that
drift can be seen, and records the ownership facts SQL 99 needs.

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
| `tables.<t>` for `mortgage_handling_requests`, `check_intake_items`, `check_messages`, `mortgage_agent_accounts` | owner; `rls_enabled`; `rls_forced`; every policy (name, command, permissive, roles, `using` / `with_check` text and sha256, `depends_on_functions`, `created_in_repo` and `repo_sources`); `grants` for `checksops`, `authenticated`, `PUBLIC` and `checksops_admin` (table ACL entries with grantor and grant option, column ACL by privilege, and effective table / any-column privileges); non-internal triggers (name and function name only) |
| `functions` | `aws_can_write_tenant`, `aws_can_access_tenant`, `aws_is_tenant_member`, `aws_is_cross_tenant_reader`, `aws_is_active_mortgage_agent`, `mortgage_agent_can_view_check` and `auth.uid`, every overload: owner, SECURITY DEFINER, language, volatility, proconfig names, `sets_row_security`, `functiondef_sha256` (of `pg_get_functiondef`), `prosrc_sha256`, `repo_match` |
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
  allowed. The text must also have no nested dollar-quoted or `E''` string, no number longer
  than 4 digits, and nothing shaped like a UUID, email or long number anywhere, comments
  included. Otherwise the report says `definition_withheld: "differs from repo (<reason>)"`.
- Policy expressions are schema metadata and are printed, unless they contain a UUID-, email-
  or long-number-shaped literal. Then only their sha256 is printed, with `text_withheld`.
- Errors report only the SQLSTATE.

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

Record the date, SSM command id and source commit in `production_inspect` of the
configuration file, in a reviewed change. Running this inspect authorizes nothing: no SQL 99
apply, no policy or grant change.

Tests: `aws/tests/mortgage-desk-access-production-inspect.test.mjs`, in
`npm run test:deployment-guard`. The PostgreSQL 16 part checks that a non-superuser
`checksops_admin` sends only allowlisted read-only statements, that nothing changes, and that
no row data or ids are printed. It also checks that repository helpers report `exact`, that
drifted helpers and policies are flagged, and that FORCE RLS on `check_messages` fails SQL 99's
precondition.
