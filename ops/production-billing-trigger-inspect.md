# Production billing trigger inspect (read-only)

`scripts/deployment-guard/billing-trigger-inspect.mjs --inspect` reports the live billing and
agent-compensation triggers and their functions, without changing anything.

**Why.** Owner, 2026-11-12:
- "we are removing the mortgage handling for an additional check … There will be no more $5 charge";
- stop agent pay for an additional check;
- "if a user deposits a check outside of checksops they should NOT be charged $4".

The $5 additional-check event is written by the API's accrual (`mortgage-ops-usage.mjs`). It is
also written by the live trigger `tr_accrue_mortgage_ops_billing` / `tg_accrue_mortgage_ops_billing`
on `mortgage_handling_requests`. No repository SQL has a CREATE for that trigger
(`aws/docs/money-write-flag.md`: "live-only, no repository SQL"). A migration that replaces it must
start from its live body, and this inspect prints that body.

It also compares the other functions with the repository:
- `record_check_billing_event` (SQL 98), which charges the $4 when a check becomes `deposited`;
- `earn_mortgage_agent_compensation` and `tg_earn_mortgage_agent_compensation` (SQL 47, SQL 86).

It is inspect-only: there is no pin, no `execute`, no apply, no `--input`, no receipt and no
one-shot entry. The configuration `ops/deployment-guard/billing-trigger-inspect.json` names the
same production RDS and `checksops_admin` secret as the Mortgage Desk access inspect.

## What it reads

The tool runs one `BEGIN READ ONLY … ROLLBACK` with `search_path` set to `pg_catalog`, a 20 s
statement timeout and a 2 s lock timeout. Inside it, it runs only the fixed catalog SELECTs in `Q`
(`lib/billing-trigger-inspect.mjs`). **It reads no table row.**

| section | content |
|---|---|
| `triggers` | every non-internal trigger on `mortgage_handling_requests`, `check_intake_items`, `checkalt_deposits` and `deposit_items`: table, name, function, enabled flag, `pg_get_triggerdef` (timing, events, columns, WHEN) |
| `functions` | the named functions (`tg_accrue_mortgage_ops_billing`, `record_check_billing_event`, `aws_check_processing_price_cents`, `aws_check_billing_charges_when_per_check_off`, `earn_mortgage_agent_compensation`, `tg_earn_mortgage_agent_compensation`), plus every function a trigger above runs. For each: owner, SECURITY DEFINER, language, volatility, `proconfig` names, EXECUTE ACL, `functiondef_sha256`, `prosrc_sha256`, `repo_match` against `aws/` and `supabase/` SQL, `run_by_triggers`, and the `definition` text |
| `missing` | named functions that are not live |
| `columns` | column names, types and NOT NULL of `check_billing_events`, `deposit_items`, `mortgage_agent_compensation_rates`, `mortgage_agent_compensation_entries`, `mortgage_handling_requests` (never values) |

**Redaction.** A definition is withheld (`definition: null`, `definition_withheld`) when it contains
UUID-, email- or long-number-shaped content. SQLSTATE codes are not counted as numbers. Errors,
including a failed connection, report only the stage and the error's code (SQLSTATE or a Node
`E*` code).

## Run (SSM runner `i-0c35557c4e5385406`, stopped between runs)

This runs only after the change is merged to main, and each production run needs the owner's
words for that run.

1. **Stage main.** Dispatch `.github/workflows/sql53-temporary-transfer.yml` on `main`. When its
   `upload` job has finished, copy `SOURCE_COMMIT` and `TARBALL_SHA256` from the `package` job log.
2. **Check the runner.** `i-0c35557c4e5385406` must be `stopped` with no SSM command in progress.
   Start it, wait for `running`, then for SSM `PingStatus` `Online`.
3. **Send one SSM `AWS-RunShellScript` command.** The definitions can be long, so the command keeps
   the output in a file and prints it as compact JSON, staying under the 24000-character SSM limit:

   ```bash
   set -euo pipefail
   SHA=<full main sha>
   TARBALL_SHA256=<TARBALL_SHA256 from the transfer run log>
   WORK=$(mktemp -d /var/tmp/billing-trigger-inspect-XXXXXX)
   cd "$WORK"
   aws s3 cp "s3://checksops-sql53-transfer-806168576068/sql53/source-${SHA}.tar.gz" . --no-progress
   aws s3 cp "s3://checksops-sql53-transfer-806168576068/sql53/source-${SHA}.tar.gz.sha256" . --no-progress
   echo "${TARBALL_SHA256}  source-${SHA}.tar.gz" | sha256sum -c -
   mkdir src
   tar -xzf "source-${SHA}.tar.gz" -C src
   cd src
   test "$(cat SOURCE_COMMIT)" = "$SHA"
   AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com \
     node scripts/deployment-guard/billing-trigger-inspect.mjs --inspect > "$WORK/out.json" || true
   node -e 'const t=require("fs").readFileSync(process.argv[1],"utf8");process.stdout.write(JSON.stringify(JSON.parse(t)))' "$WORK/out.json"
   echo; sha256sum "$WORK/out.json"
   cd / && rm -rf "$WORK"
   ```

   **The full output exceeds the limit in production** (2026-11-12). Send one command per section
   instead: the same script, ending with a `node -e` filter that prints one slice of `details`. Use
   `functions` without definitions plus `triggers`, `missing` and `columns` for the summary. Then
   print the `definition` of at most two functions per command. Each command prints `sha256sum` of
   its `out.json`; equal sums show the database did not change between the commands. Never
   hand-edit a value the run did not print.
4. **Stop the runner** and wait for `stopped`, whatever the result.
5. **Record the result.** Put the date, SSM command id, source commit and the answer in
   `production_inspect` of the configuration file, in a reviewed change.

## Reading the answer

- **`tg_accrue_mortgage_ops_billing`**: its `definition` is the body the next migration replaces.
  That migration must keep every behavior except the `mortgage_ops_additional_check` event: the
  $10 `mortgage_ops_initial` and SQL 153's second-mortgagee $5 stay. Its `security_definer` and
  `owner` also answer `aws/docs/money-write-flag.md` uncovered item 2.
- **`record_check_billing_event`**: `repo_match` `exact` means SQL 98's body is live, so the
  migration can add the manual-deposit exclusion to it. Anything else is drift: stop and report.
- **`earn_mortgage_agent_compensation`**: `repo_match` names the SQL 47 fixture when the live body
  is the one the migration will change (no pay for an additional check).
- **`columns.deposit_items`**: must include `provider` and the check link the exclusion reads
  (`mark_manual_deposit` sets `provider = 'manual_branch'`).
- **`missing` not empty, or a trigger `enabled` other than `origin`**: report it before writing SQL.

## Runs

- **2026-11-12, partial** (`production_inspect` in the configuration). This run found:
  - `record_check_billing_event` is SQL 98's body;
  - `earn_mortgage_agent_compensation` is SQL 47's body;
  - `tg_accrue_mortgage_ops_billing` only gates on the first accept and calls
    `accrue_mortgage_ops_billing(uuid)`, which the tool then did not read;
  - a second Mortgage Ops billing trigger: `tr_record_mortgage_handling_billing` on
    `check_intake_items`, which runs `tg_record_mortgage_handling_billing`.

  `accrue_mortgage_ops_billing` is now in `NAMED_FUNCTIONS`. The next run prints its definition and
  that of `tg_record_mortgage_handling_billing`.

## Staging

This change adds no staging tool. The guarded staging SQL executor's read-live reports the staging
state of the migration that follows. The tests run the same statements on PostgreSQL 16
(`aws/tests/billing-trigger-inspect.test.mjs`).
