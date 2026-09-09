# Phase 3A.5B — Legacy CheckAlt money-path shutdown

Review-only. Do not merge or deploy from this note.

## Goal

Make the old Lovable/Supabase CheckAlt money path incapable of executing,
even if `nbcqwpysqgyxrrbgtmkw.supabase.co` becomes reachable again.
Do not rely on NXDOMAIN.

## In-repo fail-closed functions

- `supabase/functions/checkalt-submit-deposit`
- `supabase/functions/checkalt-approve-deposit`

Both return `403 legacy_checkalt_money_path_disabled` before any CheckAlt
authentication or HTTP. They do not read `CHECKALT_USERNAME` /
`CHECKALT_PASSWORD`, do not use a cached CheckAlt JWT, and do not call
`/fincapture/deposit/process` or `/fincapture/deposit/approve`.

AWS production remains dark:

- `AWS_CHECKALT_ENABLED=false`
- `AWS_MOOV_ENABLED=false`
- `AWS_PROVIDER_EXECUTION_ENABLED=false`
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`
- `PROVIDER_SECRETS_ARN` unset
- SQL 64 / 65 `NOT_APPLIED`

## Production SPA

Command Center, Deposit Operations, and Pending Approvals no longer invoke
the legacy function names through the Supabase client. They use
`src/lib/awsCheckAltMoneyPath.ts`, which posts only to the Cognito `/prep`
API and refuses Lovable/Supabase hosts.

## Credential removal (prepare only — do not apply yet)

After the neutralized functions are deployed to the legacy project, remove
these secret *names* (values must not be copied into tickets or logs):

- `CHECKALT_USERNAME`
- `CHECKALT_PASSWORD`
- cached CheckAlt JWT / token (`checkalt_config.cached_jwt`,
  `checkalt_config.cached_jwt_expires_at`)

Do not create `checksops/production/providers`. Do not lift AWS money flags.

## `auto_approve_enabled`

Do not change Freedom `checkalt_tenant_accounts.auto_approve_enabled`.
The only executable consumer of that flag for money movement was Lovable
`checkalt-submit-deposit` after a successful process call. AWS production
submit does not auto-approve. After this shutdown is deployed to Lovable,
the flag cannot affect any executable production money path. The Settings
UI can still persist the boolean; that is configuration, not money movement.

## Remaining legacy CheckAlt functions (out of this shutdown)

These are not deposit process/approve, but they can still open CheckAlt HTTP
if the legacy project is reachable and they are not later neutralized:

- `checkalt-poll-status`
- `checkalt-test-connection`
- `checkalt-register-account`
- `checkalt-verify-account`
- `checkalt-account-status`
- `checkalt-deposit-history`
- `checkalt-prepare-image` (image resize only)
