# Staging API → restored database `checksops` (read-only validation)

Point the existing staging Lambda `checksops-staging-api` at restored database `checksops` using env `DATABASE_NAME=checksops`. Keep `DATABASE_SECRET_ARN` on the application role secret (`checksops`). Do not use `checksops_admin`. Do not mutate the secret `dbname` (it still says `postgres`).

This phase is **read-only**. STOP after `/db-health` and `/db-readonly-validate`. Do not start Cognito/Auth, RLS, Storage, frontend, Moov, CheckAlt, webhook, DNS, or production cutover work.

## Safety

- Production Lovable/Supabase, `main`, DNS, frontend: not changed
- Cognito users: not imported
- RLS: not enabled
- Storage/S3 object copy: not started
- Moov / CheckAlt / payment webhooks: not changed
- No INSERT / UPDATE / DELETE / migrations / schema changes / financial transactions
- Application role stays least-privilege (CONNECT + SELECT on `public`)
- API role still has `GetSecretValue` only on the application secret (not `checksops_admin`)

## How the database name is chosen

1. Lambda env `DATABASE_NAME` (staging: `checksops`)
2. Else secret `dbname`
3. Else `postgres`

Live update was `UpdateFunctionCode` / `UpdateFunctionConfiguration` on `checksops-staging-api`. Do not SAM-deploy this branch over the live stack (other PRs own VPC/Cognito template changes).

## Endpoints

- `GET /db-health` — TLS + `SELECT 1` + `current_database()` / `current_user`
- `GET /db-readonly-validate` — SELECT counts on 16 core tables plus catalog probes
- Non-GET on those routes returns `405`

## Live results (2026-09-02)

Staging API: `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging`

### `GET /db-health` → 200

| Field | Value |
| --- | --- |
| `currentDatabase` | `checksops` |
| `currentUser` | `checksops` |
| `secretDatabase` | `postgres` (unchanged; override only) |
| `databaseNameOverride` | `checksops` |
| `postgresqlVersion` | `18.3` |
| `transactionReadOnly` / `defaultTransactionReadOnly` | `on` |
| secrets / TLS / auth / `SELECT 1` | all `ok` |

### `GET /db-readonly-validate` → 200, `ok: true`

All 16 requested core tables were present. `SELECT count(*)` matched the restored dump. Role `checksops` has SELECT only (no INSERT/UPDATE/DELETE). RLS is off. No writes were attempted (`POST` returns 405).

| Table | Count | Match |
| --- | ---: | --- |
| `tenants` | 6 | yes |
| `profiles` | 8 | yes |
| `tenant_users` | 7 | yes |
| `user_roles` | 10 | yes |
| `claims` | 180 | yes |
| `check_intake_items` | 182 | yes |
| `check_endorsements` | 502 | yes |
| `deposit_batches` | 115 | yes |
| `deposit_items` | 114 | yes |
| `checkalt_deposits` | 58 | yes |
| `disbursement_batches` | 109 | yes |
| `disbursement_splits` | 108 | yes |
| `payment_provider_accounts` | 3 | yes |
| `payment_wallets` | 1 | yes |
| `payment_webhook_events` | 227 | yes |
| `homeowner_ledger_events` | 657 | yes |

Catalog: restore sentinel present; `auth.users` stub present; **0** restored FKs to `auth.users`; **164** public triggers; **965** public functions.

### Findings (expected for this phase; none are errors)

| Kind | Finding |
| --- | --- |
| permission | `USAGE` denied on schema `auth`. `SELECT auth.uid()` and `has_function_privilege(..., 'auth.uid()')` fail with `42501 permission denied for schema auth`. Least-privilege; Auth/Cognito is out of scope. |
| missing_fk | **47** public FKs to `auth.users` were skipped on restore and remain absent. SELECT on the 16 tables still succeeded. |
| supabase_dependency | 40 public functions reference `auth.uid()`. Function bodies still mention net (4), cron (2), vault (5), pgmq (5). `EXECUTE` was not granted to `checksops`. |
| trigger | 164 public non-internal triggers present (matches restore). No missing-trigger error. |
| storage schema | `storage` is not in `pg_namespace` (Storage was not restored). |
| extensions schema | `USAGE` on `extensions` is true (PostgreSQL extension default). Not a write grant. |

No unexpected write privilege, no RLS on the 16 tables, no count mismatch, no missing core table.

## STOP

Do **not** begin Cognito user import, identity mapping application, RLS enablement, Storage/S3 copy, frontend cutover, Moov, CheckAlt, webhook endpoint changes, DNS, or production work until this report is reviewed.
