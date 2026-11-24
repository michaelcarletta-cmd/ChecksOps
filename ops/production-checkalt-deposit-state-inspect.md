# Production CheckAlt deposit state inspect (read-only)

`scripts/deployment-guard/checkalt-deposit-state-inspect.mjs --inspect` answers one question about
production, without changing anything:

> Which `public.checkalt_deposits` rows are stranded: `provider_http_attempted_at` set,
> `checkalt_reference` NULL, `status` in (`queued`, `pending`, `submitting`, `error`), so that every
> later Deposit press on their check answers `reconciliation_required`?

Owner report 2026-11-24: a CheckAlt sign-in returned 504 at 19:58 UTC, and since then the Deposit
button on that check answers `reconciliation_required`. At least one row is stranded.

It is inspect-only. It has no pin, no `execute`, no apply, no `--input`, no receipt and no
one-shot entry. The configuration in `ops/deployment-guard/checkalt-deposit-state-inspect.json`
names the same production RDS and `checksops_admin` secret as the Mortgage Desk access inspect.

## Why these rows

How a row gets stranded (main at the time of this change):

- `aws/functions/api/providers/production/checkalt-submit.mjs` inserts the deposit row `queued`
  (`insertQueuedDeposit`, `last_status_payload.phase` `queued_before_http`), commits, then claims
  it with `markHttpAttempted` (`checkalt-idempotency.mjs`): `status` `submitting`,
  `provider_http_attempted_at` `now()`, `phase` `submitting`, and commits again. Only then does it
  sign in to CheckAlt (`getCheckAltJwt`), resolve the SSO key and post
  `/fincapture/deposit/process`.
- If the sign-in fails before the POST (the 504 at 19:58) and the error is not a provider network
  error, nothing writes the row again: it stays `submitting` with the attempt time and no
  reference, `failure_class` NULL. A network error or timeout writes `failure_class`
  `provider_timeout`, `phase` `provider_outcome` and keeps `submitting`.
- From then on `shouldReconcileInsteadOfPost` is true for that row (an HTTP attempt and a status
  in `queued`, `pending`, `submitting`, `error`), so every later press reconciles instead of
  posting, and with no reference to look up it answers `reconciliation_required`. The tests check
  this rule against the Lambda's own helper.

Columns are those `loadDepositsForCheck` reads, confirmed against the table's migration
(`supabase/migrations/20260503020002_*.sql`) and `aws/financial/sql/65_checkalt_production_writer.sql`
(`idempotency_key`, `amount_cents`, `provider_http_attempted_at`, `failure_class`, `last_error`).

## What it reads

One `BEGIN READ ONLY … ROLLBACK` with `search_path` set to `pg_catalog`, a 20 s statement
timeout, a 2 s lock timeout and `TimeZone` UTC. Inside it, only the fixed statements in `Q`
(`lib/checkalt-deposit-state-inspect.mjs`) over `public.checkalt_deposits` and
`public.check_intake_items`. Every statement returns counts, booleans, code labels, small
integers and timestamps truncated to the minute (UTC, `YYYY-MM-DDTHH:MIZ`). Ids, tenants, users,
amounts, idempotency keys, CheckAlt references, `last_error` and payload values are used only
inside predicates; none is returned.

| section | content |
|---|---|
| `row_security` | per table, whether row-level security filters what `checksops_admin` reads (expected all `false`; `true` would make the answer partial) |
| `summary` | total rows; rows by `status` × reference null / set × HTTP attempted yes / no (`by_status` and the raw `rows`); `total.stranded` |
| `stranded` | one entry per stranded row, ordered by `created_at`: `created_minute`, `attempted_minute`, `updated_minute`; `status`; `failure_class` label; `phase` (`last_status_payload->>'phase'`) label; `last_error_null`; `check_linked` (the row names a check), `check_found`, `check_deposited` (`deposited_at` set), `check_status`, `check_stage`; `check_deposit_rows` and `check_rows_with_reference` (all deposit rows of the same check); `other_row_has_reference` and `other_row_terminal` (another row of the same check has a reference, or a status in `submitted`, `pending_approval`, `cleared`, `rejected`, `returned`, `duplicate`) |
| `stranded_by_date` | stranded rows by `created_at` date (UTC) |
| `recent` | every row created in the last 2 days (from the transaction's `now()`), ordered by `created_at`: the three minute timestamps, `status`, `reference_null`, `http_attempted`, `failure_class` label, `stranded`, and `check_seq` (1, 2, … numbering the checks in this section by their first row: rows with the same number are the same check; it is not an id) |

A statement whose columns are missing is reported as
`{ "read": false, "reason": "columns_missing:…" }`; the others still run. Labels that do not look
like a code label (`^[a-z][a-z0-9_]{0,40}$`, the ownership inspect's sanitizer) are printed as
`other`; an empty or NULL label as `(none)`. Errors, a failed connection included, report only the
stage and the error's code (SQLSTATE or a Node `E*` code).

## Run (SSM runner `i-0c35557c4e5385406`, stopped between runs)

This runs only after the change is merged to main and the owner approves the run.

1. Stage main: dispatch `.github/workflows/sql53-temporary-transfer.yml` on `main`. When its
   `upload` job has finished, copy `SOURCE_COMMIT` and `TARBALL_SHA256` from the `package` job log.
2. Check the runner: `i-0c35557c4e5385406` (`checksops-sql53-temporary-runner`, profile
   `ChecksOpsSql53TemporaryRunner`) is `stopped` and has no SSM command in progress. Start it, wait
   for `running`, then for SSM `PingStatus` `Online`.
3. Send one SSM `AWS-RunShellScript` command:

   ```bash
   set -euo pipefail
   SHA=<full main sha>
   TARBALL_SHA256=<TARBALL_SHA256 from the transfer run log>
   WORK=$(mktemp -d /var/tmp/checkalt-deposit-state-inspect-XXXXXX)
   cd "$WORK"
   aws s3 cp "s3://checksops-sql53-transfer-806168576068/sql53/source-${SHA}.tar.gz" . --no-progress
   aws s3 cp "s3://checksops-sql53-transfer-806168576068/sql53/source-${SHA}.tar.gz.sha256" . --no-progress
   echo "${TARBALL_SHA256}  source-${SHA}.tar.gz" | sha256sum -c -
   mkdir src
   tar -xzf "source-${SHA}.tar.gz" -C src
   cd src
   test "$(cat SOURCE_COMMIT)" = "$SHA"
   AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com \
     node scripts/deployment-guard/checkalt-deposit-state-inspect.mjs --inspect
   cd / && rm -rf "$WORK"
   ```

4. Stop the runner and wait for `stopped`, whatever the result.
5. Record the date, SSM command id, source commit and the answer in `production_inspect` of the
   configuration file, in a reviewed change.

## Reading the answer

- `row_security` has a `true`: the rows are what `checksops_admin` can see, not every row. Stop
  and report it.
- `summary.total.stranded` is the number of stranded rows; `stranded_by_date` says when they were
  created. A row on 2026-11-24 with `attempted_minute` `…T19:58Z`, `status` `submitting`,
  `failure_class` `(none)` and `phase` `submitting` is a row the sign-in failure left before any
  POST was sent.
- `failure_class` `provider_timeout` (`phase` `provider_outcome`): the network error path wrote the
  row; the POST may or may not have reached CheckAlt.
- `other_row_has_reference` or `other_row_terminal` `true`: the check has another deposit row that
  went through (or was refused) at CheckAlt; `check_deposited` says whether the check moved.
- `recent` lines up the owner's presses: the 19:58 press and each later one, by minute, with
  `check_seq` grouping the rows of one check. A later press on a stranded check normally adds no
  row (same idempotency key), so one stranded row with no later rows for its `check_seq` is the
  expected shape.
- Whether a stranded row ever reached CheckAlt is not visible in the database. Any repair of the
  rows (for example releasing a row that provably never posted) is a separate, reviewed change:
  a new numbered migration or code change through the guarded staging and production path, never
  a hand edit.

## Staging

This change adds no staging tool. The tests run the same statements on PostgreSQL 16
(`aws/tests/checkalt-deposit-state-inspect.test.mjs`).
