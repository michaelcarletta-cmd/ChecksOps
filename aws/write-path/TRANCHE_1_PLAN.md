# AWS write path — Tranche 1 plan

## Goal

Open a **narrow, kill-switchable** authenticated write path for two low-risk frontend operations while production ChecksOps and AWS reads stay unchanged.

Do not migrate claim/check workflow, money movement, providers, auth, or webhooks.

## Selected operations

Chosen because they are real ChecksOps frontend DML (not probe tables) and do not move money or call providers.

| # | Frontend | Table | Ops | Why this is Tranche 1 |
| --- | --- | --- | --- | --- |
| 1 | `CheckMessageThread` upsert when a thread loads | `check_message_reads` | insert / update / upsert / delete | Live Messages UI. Columns: `user_id` (server-forced), `check_id`, `last_read_at`. RLS: `aws_can_write_check(check_id)`. |
| 2 | `NotificationPreferencesSettings` load/save | `notification_preferences` | get_or_create / insert / update / delete | Flag storage only (in-app/email/SMS). Does not send mail/SMS. `user_id` server-forced. RLS: `aws_can_write_same_tenant_user(user_id)`. Settings card mounted on white-label Settings → Profile so testers can reach it. |

Rejected for this tranche:

- `check_messages` INSERT — trigger writes `homeowner_ledger_events`
- `check_messages` UPDATE `is_deleted` — check-workflow, not settings CRUD
- `_aws_rls_write_probe` — not used by the product UI
- `notification_preferences` SECURITY DEFINER RPC as-is — would honor client `p_user_id`

## Architecture

```
React/Vite (AWS mode only)
  -> API Gateway POST /data/write
  -> Lambda checksops-staging-api
  -> write connection as role checksops (no default_transaction_read_only GUC)
  -> BEGIN; SET TRANSACTION READ WRITE;
  -> Cognito sub -> identity_accounts.application_user_id
  -> set_config request.app_user_id / request.jwt.claim.email
  -> allowlisted DML
  -> COMMIT or ROLLBACK
  -> RLS USING/WITH CHECK
```

Browser never receives RDS credentials. Read pool keeps `-c default_transaction_read_only=on`. Database/role defaults are not globally flipped.

Identity: never use Cognito `sub` as `auth.uid()`. Spoofed `user_id` / `tenant_id` / `x-user-id` / `x-tenant-id` / query identity are ignored.

## Write contract

`POST /data/write`

```json
{ "table": "check_message_reads", "op": "upsert", "values": { "check_id": "...", "last_read_at": "..." } }
```

Server owns tables, ops, columns, required fields, identity, and tenant authorization. No arbitrary SQL, table names, or WHERE clauses.

Generic `POST/PUT/PATCH/DELETE /data/*` remains `writes_disabled`.

## Controlled write privilege

Temporary admin oneshot applies `aws/write-path/sql/31_tranche1_write_grants.sql` (INSERT/UPDATE/DELETE on the two tables only). API Policy4 still cannot load `checksops_admin`. Financial tables stay SELECT-only for `checksops`.

## Kill switch / rollback

Lambda env `AWS_WRITES_ENABLED=true` required. Any other value → authenticated `403 writes_disabled`. Reads continue. Production is untouched.

Immediate disable: set `AWS_WRITES_ENABLED=false` on `checksops-staging-api` (no code deploy). Optional GRANT revoke: `32_tranche1_revoke_write_grants.sql`.

Details: `aws/write-path/TRANCHE_1_ROLLBACK.md`.

## Tests required before stop

Freedom CRUD on own data; C1C CRUD on own data; cross-tenant deny both ways; unauthenticated 401; spoofed app/tenant UUID ignored; Cognito sub as app UUID refused; ninth UUID fail-closed; unapproved table/column denied; financial/provider tables denied; error rolls back; financial aggregates unchanged; test rows deleted.

## Out of scope

Tranche 2+ writes, production DNS/Supabase/Moov/CheckAlt/Plaid/Actum/QuickBooks, merging this PR, disabling the ninth UUID fail-closed behavior.
