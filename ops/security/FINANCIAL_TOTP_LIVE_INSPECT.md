# Financial TOTP live inspect (read-only)

`scripts/deployment-guard/financial-totp-live-inspect.mjs --inspect` answers one question about
production without changing anything:

> Does the live `public.consume_financial_totp_rate_limit` accept the action `code_check`?

## Why

Since the finding 7 deploy (production overlay run 40992441506, 2026-10-30) the API sends the
rate-limit action `code_check` for every authenticator-code check:
- `aws/functions/api/auth-financial-totp.mjs`: `RATE_LIMITS.code_check`, used by enroll confirm
  and step-up;
- `providers/production/checkalt-register.mjs`: the finding 13 deposit-account change.

The only repository definition of the function is
`aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql`. At lines 87-90 it
allows only `enroll_start`, `enroll_confirm` and `step_up`, and raises
`invalid_rate_limit_action` for anything else, which the API turns into 401
`financial_totp_failed` ("code incorrect"). No repository migration defines the function, so
nobody has read the live definition. If production matches the proposed file, every
authenticator-code check since the deploy fails. The production API access logs show no
step-up or enroll-confirm call since the deploy, so no user has hit it yet, and there is no
proof either way.

## What it reads

One `BEGIN READ ONLY … ROLLBACK` with `search_path` `pg_catalog`, a 20 s statement timeout and a
2 s lock timeout. Inside it, only the fixed SELECTs in `Q`
(`scripts/deployment-guard/lib/financial-totp-live-inspect.mjs`). There is no SQL argument.

| section | content |
|---|---|
| `accepts_code_check` | `true` / `false`; `null` with a reason when the function is missing or its body has no recognizable allow-list |
| `rate_limit` | per overload: the parsed allow-list (`p_action [NOT] IN (…)` or `= ANY (ARRAY[…])`), whether it raises `invalid_rate_limit_action`, and whether it accepts each action the API sends (`enroll_start`, `code_check`) |
| `functions` | every `public` function whose name contains `financial_totp`: signature, result, owner, SECURITY DEFINER, language, volatility, `proconfig` names, EXECUTE ACL (with `PUBLIC`), `functiondef_sha256`, `prosrc_sha256`, `repo_match` against `aws/` and `supabase/`, `matches_proposed_file`, and the `pg_get_functiondef` text (withheld only if it has UUID-, email- or long-number-shaped content) |
| `tables` | `financial_totp_enrollments`, `financial_totp_rate_limits`, `financial_stepup_log`: exists, owner, RLS enabled / forced, column names and types |
| `activity` (since 2026-10-29) | aggregate counts only: rate-limit rows and requests by action and day, `code_check_rows`, step-up log rows by `action_key`, `succeeded` and day, and enrollment totals (enrolled, verified, failed attempts > 0, `locked_until` set, `last_used_timestep` set) |

It never selects a user id, tenant id, secret, ciphertext, nonce, key id, metadata or raw row
(the test checks every statement). Action labels are printed only when they look like a code
label (`^[a-z][a-z0-9_]{0,40}$`); anything else is counted as `other`. Errors report the stage and
the error's code only. Any argument other than `--inspect`, and any `CHECKSOPS_DEPLOYMENT_GUARD_*`
or `CHECKSOPS_SKIP_DEPLOYMENT_GUARD` variable, is refused before the secret is read.

Configuration: `ops/deployment-guard/financial-totp-live-inspect.json`, the same production RDS
and `checksops_admin` secret as `mortgage-desk-access-production-inspect.json`. Test:
`aws/tests/financial-totp-live-inspect.test.mjs` (PostgreSQL 16 with the proposed SQL loaded:
`false` before, `true` after the function also allows `code_check`; nothing changes; a write in
the transaction is refused with 25006; no ids or secrets in the output).

## Owner approval

The inspect is read-only, but it starts the production SQL runner and connects to the production
database as `checksops_admin`. It runs only after this change is merged to main and the owner
says to run it. Running it authorizes nothing else: no rollback, no migration, no deploy.

## Run (SSM runner `i-0c35557c4e5385406`, stopped between runs)

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
   WORK=$(mktemp -d /var/tmp/financial-totp-inspect-XXXXXX)
   cd "$WORK"
   aws s3 cp "s3://checksops-sql53-transfer-806168576068/sql53/source-${SHA}.tar.gz" . --no-progress
   aws s3 cp "s3://checksops-sql53-transfer-806168576068/sql53/source-${SHA}.tar.gz.sha256" . --no-progress
   echo "${TARBALL_SHA256}  source-${SHA}.tar.gz" | sha256sum -c -
   mkdir src
   tar -xzf "source-${SHA}.tar.gz" -C src
   cd src
   test "$(cat SOURCE_COMMIT)" = "$SHA"
   AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com \
     node scripts/deployment-guard/financial-totp-live-inspect.mjs --inspect
   cd / && rm -rf "$WORK"
   ```

4. Stop the runner and wait for `stopped`, whatever the result.
5. Record the date, SSM command id, source commit and the answer in `production_inspect` of the
   configuration file, in a reviewed change.

## Reading the answer

- `accepts_code_check: false` (allow-list without `code_check`): every authenticator-code check
  fails in production. Quick relief: a guarded overlay rollback of `auth-financial-totp.mjs`
  (and `checkalt-register.mjs`) to the version before `code_check`, on the owner's
  "DEPLOY … TO PRODUCTION". Lasting fix: a new numbered migration that adds `code_check` to the
  allow-list, through staging and then production.
- `accepts_code_check: true`: the live function already accepts it; nothing is broken.
- `null`: read `functions[].definition` for the rate-limit function and decide from the text.

## Staging

No existing guarded path can read these functions on staging. The staging SQL executor's
`read-live` mode works only for registered, pinned migrations, and none covers the TOTP functions.
This change adds no staging tool.
