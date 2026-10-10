# Production SQL 53 read-only diagnostic (source-only)

This adds an owner-gated catalog inspect that is separate from
`GET /db-readonly-validate` and `staging_admin`. It is not authorized to
run. Do not overlay, dispatch, or open a production SQL session from this
pull request.

## Path

- Module: `aws/functions/api/sql53-production-readonly-inspect.mjs`
- HTTP: `GET /sql53-production-readonly-inspect`
- Direct invoke: `{ "diagnostic": "sql53-production-readonly-inspect", "authorization": "OWNER_AUTHORIZED_PRODUCTION_SQL53_READONLY_INSPECT" }`

The existing staging validator endpoint is unchanged and still skips
`inspectPinnedSqlObjects` when `CHECKSOPS_ENV=production`.

## Authorization

All of these must match or the handler refuses before loading credentials:

1. `CHECKSOPS_ENV=production`
2. `AWS_LAMBDA_FUNCTION_NAME=checksops-production-prep-api`
3. Lambda env `CHECKSOPS_SQL53_READONLY_INSPECT_AUTHORIZATION` equals
   `OWNER_AUTHORIZED_PRODUCTION_SQL53_READONLY_INSPECT`
4. Request header `x-checksops-sql53-inspect-authorization` or invoke
   field `authorization` equals the same phrase
5. Live `secrets.mjs` SHA-256 equals the official host-compare pin

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
live package and surgically patch live `index.mjs`. See
`ops/deployment-guard/production-sql53-readonly-diagnostic.json`.
