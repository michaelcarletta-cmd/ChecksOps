# Staging API → restored database `checksops` (read-only validation)

Point the existing staging Lambda `checksops-staging-api` at restored database `checksops` using env `DATABASE_NAME=checksops`. Keep `DATABASE_SECRET_ARN` on the application role secret (`checksops`). Do not use `checksops_admin`. Do not mutate the secret `dbname` (it may still say `postgres`).

This phase is **read-only**. STOP after `/db-health` and `/db-readonly-validate`. Do not start Cognito/Auth, RLS, Storage, frontend, Moov, CheckAlt, webhook, DNS, or production cutover work.

## Safety

- Production Lovable/Supabase, `main`, DNS, frontend: not changed
- Cognito users: not imported
- RLS: not enabled
- Storage/S3 object copy: not started
- Moov / CheckAlt / payment webhooks: not changed
- No INSERT / UPDATE / DELETE / migrations / schema changes / financial transactions
- Application role stays least-privilege (CONNECT + SELECT)

## How the database name is chosen

1. Lambda env `DATABASE_NAME` (staging: `checksops`)
2. Else secret `dbname`
3. Else `postgres`

Live update is `UpdateFunctionConfiguration` / `UpdateFunctionCode` on `checksops-staging-api`. Do not SAM-deploy this branch over the live stack (other PRs own VPC/Cognito template changes).

## Endpoints

- `GET /db-health` — TLS + `SELECT 1` + `current_database()` / `current_user`
- `GET /db-readonly-validate` — SELECT counts on 16 core tables plus catalog probes

## Live results

Pending in-place Lambda update and HTTP probes. This section is filled after staging `/db-health` and `/db-readonly-validate` succeed.
