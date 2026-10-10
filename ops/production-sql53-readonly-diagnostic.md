# Production SQL 53 read-only diagnostic (source-only)

This adds an owner-gated catalog inspect that is separate from
`GET /db-readonly-validate` and `staging_admin`. It is not authorized to
run. Do not overlay, dispatch, or open a production SQL session from this
pull request.

## Path

- Module: `aws/functions/api/sql53-production-readonly-inspect.mjs`
- Transport: temporary owner-authorized **direct Lambda invoke only**
- Payload: `{ "diagnostic": "sql53-production-readonly-inspect", "authorization": "<owner-chosen one-time token>" }`
- Exact two keys. Extra fields, headers, or API Gateway events are refused.
- The in-repo phrase `OWNER_AUTHORIZED_PRODUCTION_SQL53_READONLY_INSPECT` is a
  diagnostic marker only. Using it as the token is refused.

There is no HTTP route. `GET /sql53-production-readonly-inspect` is not
registered and must 404 through the production catch-all API.

The existing staging validator endpoint is unchanged and still skips
`inspectPinnedSqlObjects` when `CHECKSOPS_ENV=production`.

## Authorization

The in-repo owner phrase is not a credential. Copying it from git, a
workflow, or this document cannot authorize the diagnostic. All of these
must match or the handler refuses before loading credentials:

1. Direct invoke of `checksops-production-prep-api` with IAM
   `lambda:InvokeFunction` on that function only. API Gateway events are
   refused.
2. `CHECKSOPS_ENV=production`
3. `AWS_LAMBDA_FUNCTION_NAME=checksops-production-prep-api`
4. Temporary Lambda env `CHECKSOPS_SQL53_READONLY_INSPECT_AUTHORIZATION`
   is an owner-chosen token of at least 32 characters and is not the
   published diagnostic marker
5. Temporary Lambda env `CHECKSOPS_SQL53_READONLY_INSPECT_EXPIRES_AT` is a
   valid RFC 3339 timestamp no more than two hours in the future
6. Invoke field `authorization` equals that same owner-chosen token
7. Live `secrets.mjs` SHA-256 equals the official host-compare pin

The environment variables are a one-shot window. Unset both immediately
after the invoke. Do not leave them as a permanent production access
mechanism.

## Production RDS proof

Lambda name plus `secrets.mjs` hash is not enough. Staging and production
both use database name `checksops`. After credentials load and before
connect, the secret host first label must be `checksops-production` and
the hostname must end with `.rds.amazonaws.com`. Staging hosts are
refused. A complete response reports `rdsIdentifier` only, never the
hostname.

## What it returns

Existence and SHA-256 only for:

- `public.save_claim_settlement_breakdown(uuid,uuid,jsonb)`
- `public.sync_homeowner_ledger_from_check()`
- `public.aws_can_write_claim(uuid)`
- `public.hle_on_check_intake_insert()`
- 17 `claim_settlements` columns
- 3 `check_intake_items` ledger triggers

Queries run only inside `BEGIN READ ONLY` and only if they match the
allowlisted official catalog SQL. Function bodies, passwords, and
hostnames are not returned. Query errors fail closed instead of reporting
`exists: false`.

## Future overlay

Do not replace the live ZIP. Do not overlay `origin/main` `index.mjs` or
`db-readonly-validate.mjs`. Add the new member onto a freshly downloaded
live package and surgically patch live `index.mjs` with the direct-invoke
hook only. See
`ops/deployment-guard/production-sql53-readonly-diagnostic.json`.
