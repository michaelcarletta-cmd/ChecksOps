# Phase 3A.5B — Legacy CheckAlt provider-HTTP shutdown (OPTION 2)

Review-only until explicitly merged. Do not deploy from this note.

## Goal

AWS `/prep` is the only executable CheckAlt provider rail before Phase 3B.
Do not rely on NXDOMAIN.

## Neutralized Lovable functions

These return `403 legacy_checkalt_provider_path_disabled` before any CheckAlt
authentication, credential read, cached JWT use, provider HTTP, or
financial/workflow writes:

- `checkalt-submit-deposit`
- `checkalt-approve-deposit`
- `checkalt-poll-status`
- `checkalt-test-connection`
- `checkalt-register-account`
- `checkalt-verify-account`
- `checkalt-account-status`
- `checkalt-deposit-history`

They do not import `checkalt.ts` and do not read `CHECKALT_USERNAME` /
`CHECKALT_PASSWORD`.

## Non-provider image utility

`checkalt-prepare-image` is **not** a provider function. It resizes and stores
a deposit-ready JPEG. It cannot authenticate to CheckAlt, move money, mutate
financial tables, or read provider credentials.

## Production SPA

Provider-facing UI uses `src/lib/awsCheckAltMoneyPath.ts` and posts only to
the Cognito `/prep` API. Lovable/Supabase hosts are refused. There is no
legacy fallback. While AWS holds stay off, Settings/register/verify/poll/history
surface **Provider not enabled / unavailable**.

Command Center CheckAlt one-click calls AWS submit first. It does not run
`prepare_deposit` or `assign_provider`.

## Legacy cron

`supabase/migrations/20260909213600_unschedule_checkalt_poll_status.sql`
unschedules only `checkalt-poll-status`. Safe no-op when `cron.job` is absent
(AWS RDS).

Operator step (legacy project only, after an authorized Lovable deploy):

1. Deploy the eight neutralized functions.
2. Apply that migration on the **legacy** project (or `SELECT cron.unschedule('checkalt-poll-status')` if the job exists).
3. Confirm `cron.job` has no `checkalt-poll-status` row.

Until that operator step, a still-scheduled cron hitting the neutralized
function receives 403 and performs zero CheckAlt HTTP.

Do not unschedule unrelated cron jobs.

## Credential removal (after authorized Lovable deploy — do not apply now)

Remove these secret *names* (never copy values into tickets or logs):

- `CHECKALT_USERNAME`
- `CHECKALT_PASSWORD`
- `checkalt_config.cached_jwt`
- `checkalt_config.cached_jwt_expires_at`

Do not create `checksops/production/providers`. Do not lift AWS money flags.

## `auto_approve_enabled`

Unchanged in this phase. After all legacy provider HTTP is disabled, no
executable production rail consumes it. Classify as **INERT LEGACY CONFIG**.

Recommendation before the first live AWS deposit: set Freedom
`auto_approve_enabled` to `false` so a later AWS auto-approve port cannot
inherit an old true. Do not change it in this phase.

## AWS dark path (unchanged)

- `AWS_CHECKALT_ENABLED=false`
- `AWS_MOOV_ENABLED=false`
- `AWS_PROVIDER_EXECUTION_ENABLED=false`
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`
- `PROVIDER_SECRETS_ARN` unset
- SQL 64 / 65 `NOT_APPLIED`
