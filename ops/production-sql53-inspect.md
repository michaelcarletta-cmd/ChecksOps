# Production SQL 53 read-only inspect (prepared, not executed)

This package records that official host-compare run `38067130648`
bound the live production Lambda to RDS instance `checksops-production`.
It does not inspect SQL, apply SQL, overlay Lambda, or dispatch a workflow.

## What is proven

- Live function `checksops-production-prep-api`
- `CodeSha256=DMcCoF3dpIiULPe530F8DJ8vC1wL1BP7ayqr+e8SCyI=`
- `RevisionId=fb17cb70-7b50-468d-a0a6-59a020c43f8c`
- Unique secret-host match to `checksops-production`
- Secret ARN remains the live `DATABASE_SECRET_ARN`

`origin/main` is still the #856 merge tip. No later production deploy was
observed.

## What is not proven

Whether production already contains:

- `public.save_claim_settlement_breakdown(uuid,uuid,jsonb)`
- `public.sync_homeowner_ledger_from_check()`
- `public.aws_can_write_claim(uuid)`
- `public.hle_on_check_intake_insert()`
- the 17 SQL 53 `claim_settlements` columns
- `trg_sync_homeowner_ledger_ins`
- `trg_sync_homeowner_ledger_upd`
- `trg_hle_check_intake_insert`

Do not treat unknown as missing.

## Why the existing inspect path cannot run yet

The official AWS inspector never contacts a database.

The existing hash inspect lives in
`aws/functions/api/db-readonly-validate.mjs` and
`scripts/deployment-guard/lib/function-def-lookup.mjs`. It uses
parameterized `SELECT` plus `BEGIN READ ONLY` and returns SHA-256 only.

That inspect is skipped when `CHECKSOPS_ENV=production`. HTTP details
that include `inspect` are returned only to `staging_admin`.

The live production member `db-readonly-validate.mjs` is
`ee58fd0a2ea5a4fd...`, matching 2026-09-07 commit `5d3ebf6c9`, before
function-definition hashing existed. Invoking live
`GET /db-readonly-validate` cannot return SQL 53 hashes.

GitHub-hosted runners cannot reach the RDS VPC. The inspect role has no
`rds-db:connect`.

## Exact workflow after later authorization

Do not use `inspect-production-readonly.yml` or
`inspect-production-secret-host-compare.yml` for SQL.

Use the official lookup SQL and column/trigger probes already pinned in
`db-readonly-validate.mjs`, against `checksops-production`, inside
`BEGIN READ ONLY`, after a separately authorized production read-only
connection. Return only redacted hashes.

Draft PR #852 is superseded. It pinned BLOCKED before the host compare.
