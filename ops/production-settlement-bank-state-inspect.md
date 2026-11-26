# Production settlement bank state inspect (read-only)

`scripts/deployment-guard/settlement-bank-state-inspect.mjs --inspect` answers one question about
production, for one organization (Condition One, fixed in
`lib/settlement-bank-state-inspect.mjs` as a bind parameter, never printed), without changing
anything:

> Does ChecksOps hold a `public.payment_provider_methods` row for the organization's own Moov bank
> in production, and did a micro-deposit verification ever open for it?

Owner report 2026-11-25 (Condition One):

- Transfer to bank says "No settlement bank", while the Wallet & Treasury Settlement bank tile
  shows a bank (grayed out).
- "Start verification" in ChecksOps did not send the Moov micro-deposit. Sending it from Moov
  directly arrived at once.
- Entering that code in ChecksOps answered "This verification can no longer accept codes".

It is inspect-only. It has no pin, no `execute`, no apply, no `--input`, no receipt and no
one-shot entry. The configuration in `ops/deployment-guard/settlement-bank-state-inspect.json`
names the same production RDS and `checksops_admin` secret as the Mortgage Desk access inspect.

## Why these rows

How the website and the API read the bank (main at the time of this change):

- **Transfer to bank:** `src/hooks/useWalletWithdraw.ts` lists the tenant's `provider = 'moov'`
  rows of the wallet environment with `external_recipient_id` NULL.
  - `transferBankOptions` (`src/lib/payments/walletWithdraw.ts`) keeps every such row and
    disables the ones not linked or not verified.
  - So "No settlement bank" means the list is empty: no row at all.
- **The tile:** `aws/functions/api/providers/parity/sweep-read.mjs` can show a bank from Moov's
  sweep configuration even when no row exists.
- **`moov-micro-deposit-initiate`** (`aws/functions/api/providers/onboarding/handlers.mjs`):
  - It needs such a row, not `disconnected`, with both provider ids.
  - Otherwise it answers `Bank account not found.` (404) or `not ready` (409) before calling
    Moov, and inserts no `payment_method_verifications` row.
- **The code entry:** `moov-micro-deposit-confirm`, and the browser's `getVerificationId`, need a
  `pending` verification row. Without one the screen shows "This verification can no longer
  accept codes".
- **`pullMoovStatus`** (`moov-sync`) only updates existing rows by `provider_bank_account_id`.
  It never inserts a bank that exists at Moov without a row.

## What it reads

One `BEGIN READ ONLY … ROLLBACK`, with these settings:

- `search_path` set to `pg_catalog`;
- a 20 s statement timeout and a 2 s lock timeout;
- `TimeZone` UTC.

Inside it, only the fixed statements in `Q` run, each with the tenant id as its only parameter.

Statements return only counts, booleans, code labels, small integers, per-section sequence
numbers and timestamps truncated to the minute (UTC). Provider ids (Moov account and bank) appear
only inside predicates, as the `has_*` and `*_matches` booleans. These values are never returned:

- ids;
- names, holder names and bank names;
- last four and routing digits;
- amounts, error text and payload values.

| section | content |
|---|---|
| `tenant_found` | whether the tenant row exists |
| `row_security` | per table, whether row-level security filters what `checksops_admin` reads (expected all `false`) |
| `derived` | `transfer_to_bank_rows_production` / `_sandbox`: the rows the Transfer to bank list would show; `micro_deposit_initiate_production`: `bank_account_not_found`, `not_ready_for_verification` or `would_call_moov`, by the initiate handler's rule |
| `accounts` | each `payment_provider_accounts` row: provider, environment, onboarding and verification status, whether a provider account id is set, disabled, restricted, last webhook event type, created and synced minute |
| `methods` | each `payment_provider_methods` row (all providers), with `seq` 1, 2, … by creation. Fields: provider; environment; `is_recipient_bank`; whether the provider account and bank ids are set; `account_matches` (its Moov account is the tenant's account row of the same environment); connection and verification status; default / send / receive flags; `provider_metadata` `source` and `status` labels; created, connected and disconnected minute |
| `verifications` | each `payment_method_verifications` row. Fields: provider; environment; method; status; attempts and max attempts; `failure_reason` label; whether it names a method and that method exists (`method_seq`); `bank_matches` (same Moov bank as that method); created, initiated, verified and updated minute |
| `events` | `payment_event_log` rows of the last 30 days: event type, environment, previous and new status, minute |
| `step_ups` | `financial_stepup_log` rows of the last 14 days: action key, factor type, succeeded, minute |
| `stakeholder_accounts` | the legacy card's rows by account type, active, primary and verification status, with counts |

A statement whose columns are missing is reported as
`{ "read": false, "reason": "columns_missing:…" }`; the others still run.

Labels must look like a code label (`^[a-z][a-z0-9_.-]{0,60}$`) to be printed:

- any other label is printed as `other`;
- an empty or NULL label is printed as `(none)`.

Errors, a failed connection included, report only the stage and the error's code (SQLSTATE or a
Node `E*` code).

## Run (SSM runner `i-0c35557c4e5385406`, stopped between runs)

This runs only after the change is merged to main and the owner approves the run.

1. **Stage main.** Dispatch `.github/workflows/sql53-temporary-transfer.yml` on `main`. When its
   `upload` job has finished, copy `SOURCE_COMMIT` and `TARBALL_SHA256` from the `package` job
   log.
2. **Start the runner.**
   - Check that `i-0c35557c4e5385406` (`checksops-sql53-temporary-runner`, profile
     `ChecksOpsSql53TemporaryRunner`) is `stopped` and has no SSM command in progress.
   - Start it, wait for `running`, then for SSM `PingStatus` `Online`.
3. **Run the inspect.** Send one SSM `AWS-RunShellScript` command:

   ```bash
   set -euo pipefail
   SHA=<full main sha>
   TARBALL_SHA256=<TARBALL_SHA256 from the transfer run log>
   WORK=$(mktemp -d /var/tmp/settlement-bank-state-inspect-XXXXXX)
   cd "$WORK"
   aws s3 cp "s3://checksops-sql53-transfer-806168576068/sql53/source-${SHA}.tar.gz" . --no-progress
   aws s3 cp "s3://checksops-sql53-transfer-806168576068/sql53/source-${SHA}.tar.gz.sha256" . --no-progress
   echo "${TARBALL_SHA256}  source-${SHA}.tar.gz" | sha256sum -c -
   mkdir src
   tar -xzf "source-${SHA}.tar.gz" -C src
   cd src
   test "$(cat SOURCE_COMMIT)" = "$SHA"
   AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com \
     node scripts/deployment-guard/settlement-bank-state-inspect.mjs --inspect
   cd / && rm -rf "$WORK"
   ```

4. **Stop the runner** and wait for `stopped`, whatever the result.
5. **Record the run.** Put the date, SSM command id, source commit and answer in
   `production_inspect` of the configuration file, in a reviewed change.

## Reading the answer

- **`row_security` has a `true`:** the rows are only what `checksops_admin` can see, not every
  row. Stop and report it.
- **`derived.transfer_to_bank_rows_production` is 0 and `micro_deposit_initiate_production` is
  `bank_account_not_found`:** this confirms the suspected cause. ChecksOps has no row for the
  bank, so initiate never called Moov.
  - The fix is a reviewed code change through the guarded staging and production path, for
    example `moov-sync` recording a Moov bank that has no row.
  - It is never a hand insert.
- **A production row with `connection_status` `disconnected`:** the initiate handler skips it,
  but Transfer to bank lists it disabled, which would contradict the report. Stop and report it.
- **`not_ready_for_verification`:** a row exists without its Moov ids.
- **`account_matches` `false`:** the row names a different Moov account than the tenant's
  account row.
- **`verifications`:** shows whether any verification ever opened and how many attempts it used.
- **`events` and `step_ups`:** show when bank actions and step-ups happened, by minute.

## Staging

This change adds no staging tool. The tests run the same statements on PostgreSQL 16
(`aws/tests/settlement-bank-state-inspect.test.mjs`).
