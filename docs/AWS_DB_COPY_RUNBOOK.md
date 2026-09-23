# ChecksOps AWS staging database copy runbook

**This phase is preparation only.** Do not export, restore, truncate, drop, overwrite, or modify the live Supabase/Lovable database or the existing `checksops-staging` RDS instance until a copy is explicitly approved.

Authoritative live catalog: [`aws/db-copy/LIVE_SOURCE_INVENTORY.md`](../aws/db-copy/LIVE_SOURCE_INVENTORY.md) (committed on `aws-migration` from the Lovable-connected production database). Exact first-copy steps: [`aws/db-copy/FIRST_COPY_PROCEDURE.md`](../aws/db-copy/FIRST_COPY_PROCEDURE.md).

Live ChecksOps Supabase/Lovable PostgreSQL is the source of truth. The target is the existing AWS RDS instance `checksops-staging` (PostgreSQL 18.3, `checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com:5432`). Do not create another RDS instance.

The application role `checksops` stays least-privileged. Eventual schema restore uses `checksops_admin` only. Do not commit or print either password. Do not request another Supabase access token or database password.

## Authoritative live counts (no 20-table discrepancy)

| Object | Count | First copy |
| --- | ---: | --- |
| Public **base tables** | **166** | Schema + row data |
| Public **views** | **20** | After tables |
| Public relations (tables + views) | 186 | Earlier “186 tables” mixed these |
| Public functions | 960 | Restore, then inspect/transform |
| Public triggers | 211 | Keep data-integrity; disable net/cron/vault/pgmq |
| Public RLS policies | 380 | Sidecar only; **do not ENABLE** |
| `auth.users` | 9 | **Out of scope** (Cognito). 0 public FKs |
| `storage.objects` | 1,335 | **Out of scope** (S3) |

Generated PostgREST types (`src/types/database.ts`) match **166 tables and 20 views**. That file lists 358 functions (a PostgREST subset of the live 960).

```bash
node aws/db-copy/cli.mjs validate
node aws/db-copy/cli.mjs inventory
node aws/db-copy/cli.mjs plan
node aws/db-copy/cli.mjs live-inventory
node --test aws/db-copy/tests/db-copy-offline.test.mjs
```

`dump` and `restore` refuse unless `CHECKSOPS_DB_COPY_EXECUTE=I_UNDERSTAND_THIS_WRITES_DATA` and `--execute` are both set. This checkout still stops even then.

## Live inventory status

**Ready from committed file. No pg_dump, no application-row export, no RDS restore, no source or AWS changes in this pass.**

| Item | Result |
| --- | --- |
| Live project | `nbcqwpysqgyxrrbgtmkw` (`https://nbcqwpysqgyxrrbgtmkw.supabase.co`) |
| Inventory file | `aws/db-copy/LIVE_SOURCE_INVENTORY.md` |
| Token/password request | **None** — catalog is already committed |
| Other project named ChecksOps | `sqyyvpaymashtdwjjmku` — **do not use** |

Machine-readable copy: `aws/db-copy/live-inventory-status.json`.

## Lanes

| Lane | This copy | Notes |
| --- | --- | --- |
| PostgreSQL schema | Direct, with transforms below | 166 `public` tables, indexes, constraints, 20 views, enums |
| Public application data | Direct | All 166 tables, including sensitive tables; never print dump contents |
| Database functions/triggers | Transform | Restore data-integrity triggers; stub `auth.uid()`; strip `net.*`, `cron.*`, vault, `pgmq` |
| Auth users | Later (Cognito) | Do not dump the 9 users. Stubs only for function compile. |
| Storage objects | Later (S3) | 1,335 objects. Not `pg_restore` |
| RLS / security policies | Later | Dump sidecar SQL. Do not apply on first RDS restore |
| Edge Functions / webhooks | Later | Lambda rewrite. Do not change Moov, CheckAlt, Plaid, Resend, or DNS |

## What will migrate directly

- All **166** live public base tables (checks, deposits, endorsements, disbursements, wallets, provider accounts, tenants, users, claims, audit logs, reconciliation, billing, Darwin/claim intelligence, etc.)
- Indexes, unique constraints, foreign keys, check constraints, primary keys
- Sequences and identity defaults (none reported via `information_schema` on live; dump still captures table-owned sequences)
- **20** public views after base tables and required extensions exist
- Enums
- RDS-supported extensions from the live catalog: `pgcrypto`, `uuid-ossp`, `pg_stat_statements`, `postgis`, `vector`. **Stop** if `postgis` or `vector` cannot be enabled.

Row-count reconciliation covers **every one of the 166 tables** (`aws/db-copy/sql/reconciliation_counts.sql`).

Critical payment-domain tables (also included in the 166-count file):

- Checks: `check_cases`, `check_intake_items`, `check_payees`, `check_files`, `check_stakeholders`, `shared_checks`
- Deposits: `deposit_batches`, `deposit_items`, `checkalt_deposits`, `checkalt_tenant_accounts`, `deposit_exceptions`, `deposit_provider_attempts`
- Endorsements: `check_endorsements`, `endorsement_requests`, `check_endorsement_events`, `endorsement_audit_log`
- Disbursements: `disbursement_batches`, `disbursement_splits`, `claim_disbursements`, `claim_check_payments`, `claim_payments`
- Payment events/webhooks (table history only): `payment_webhook_events`, `payment_event_log`, `payment_idempotency_keys`, `checkalt_webhook_events`, `deposit_webhook_events`, `plaid_webhook_cursors`
- Wallets / provider accounts: `payment_wallets`, `payment_wallet_ledger`, `payment_wallet_sub_ledgers`, `payment_provider_accounts`, `payment_provider_methods`, `payment_transfers`, `payment_transfer_groups`, `payment_sweep_configs`, `wallet_funding_requests`, `wallet_funding_queue`
- Tenants/users: `tenants`, `tenant_users`, `user_roles`, `profiles`, `stakeholder_accounts`
- Claims: `claims`, `claim_checks`, `claim_files`, `loss_draft_tracking`, `homeowner_ledger_events`
- Audit: `audit_logs`, `check_audit_log`, `check_status_audit`, `deposit_audit_log`, `loss_draft_audit_log`, `esign_event_logs`
- Reconciliation: `check_reconciliation_alerts`

Financial aggregates (source vs target) are in `aws/db-copy/sql/reconciliation_financial.sql`: check intake amounts/fees, deposit item/batch/CheckAlt amounts, endorsement-linked check amounts, disbursement split/batch amounts, claim check payments, payment transfers, wallet ledger, claim payments, homeowner ledger.

## What requires transformation

These cannot be a literal Supabase restore onto RDS:

1. **`auth.uid()`, `auth.jwt()`, `auth.role()`, `auth.email()`** — 40 public functions reference `auth.uid()`. Install no-op stubs (`aws/db-copy/sql/01_auth_compatibility_stubs.sql`) so functions compile. They will not see a JWT on RDS. **Do not load the 9 Auth users** (0 public FKs to `auth.users`).
2. **Owners and ACLs** — dump with `--no-owner --no-acl`. Supabase roles `anon`, `authenticated`, and `service_role` do not exist on RDS.
3. **`pg_net` / `net.*` (4 functions)** — not on RDS. Do not restore working HTTP callbacks.
4. **`pg_cron` / `cron.*` (2 functions)** — do not recreate jobs against production URLs. Replace later with EventBridge.
5. **`supabase_vault` / `pgsodium` / `pgmq` (5 + 5 functions)** — not restored. Secrets stay in AWS Secrets Manager.
6. **PostGIS 3.3.7 / vector 0.8.0** — required by the live catalog. Enable on RDS or **stop**.
7. **Least-privilege `checksops`** — after restore, grant `CONNECT` + `SELECT` only on database `checksops`. Do not grant `BYPASSRLS`, writes, or DDL.

## What will migrate later

- **Supabase Auth → Cognito** (9 users, passwords, MFA, sessions). Do not dump `auth.users` in the first copy.
- **Storage → S3** (1,335 objects: `claim-files` 1,184, `endorsement-packets` 125, plus smaller buckets). Preserve object key mapping. Do not `pg_restore` `storage.objects`.
- **RLS policies (380)**. Extract to a sidecar file and filter `POLICY` / `ROW SECURITY` from `pg_restore -l`. Applying them on RDS would hide rows from `checksops` because `auth.uid()` is null.
- **Realtime** publications and `supabase_functions` schema.
- **Edge Functions → Lambda**, including `moov-webhook`, `plaid-transfer-webhook`, `resend-webhook`, CheckAlt, and billing webhooks. **Do not switch production webhook destinations.**
- **Application writes** and frontend cutover.

## Proposed exact sequence (later approved phase)

Do not start this sequence until a copy is explicitly approved. Full operator text: `aws/db-copy/FIRST_COPY_PROCEDURE.md`.

Work only in a **new database named `checksops`**. Leave `postgres` (and `/db-health`) untouched.

1. Confirm live inventory still matches `LIVE_SOURCE_INVENTORY.md` (166 tables, 20 views). Stop if not.
2. As `checksops_admin`: `CREATE DATABASE checksops;`
3. Enable RDS-supported extensions (`00_rds_supported_extensions.sql`). **Stop** if `postgis` or `vector` is unavailable.
4. Create auth **stubs only** (`01_auth_compatibility_stubs.sql`). Do not load Auth users.
5. `pg_dump --schema=public --schema-only --no-owner --no-acl --no-publications --no-subscriptions`.
6. Extract `CREATE POLICY` / `ENABLE ROW LEVEL SECURITY` into `public-rls.sql`. Filter those entries from `pg_restore -l`. Do not restore that file.
7. `pg_dump --schema=public --data-only --disable-triggers`.
8. `pg_restore` schema then data as `checksops_admin` into database `checksops`.
9. Inspect functions/triggers (`03_inspect_supabase_dependencies.sql`) for `net.*`, `cron.*`, vault, `pgmq`. Disable or stop.
10. Grant read-only to `checksops` on database `checksops`. Do not change passwords.
11. Run `reconciliation_counts.sql` (all 166 tables) and `reconciliation_financial.sql` on source and RDS. Diff must be zero.
12. Leave the staging API secret `dbname` on `postgres` until a later approved cutover.
13. Leave Auth, Storage, RLS apply, Edge Functions, and provider webhooks for later phases.

`node aws/db-copy/cli.mjs plan` prints the command templates without credentials.

## Temporary access required when the copy is approved

Do **not** create a new credential in this pass. Do **not** paste a database password or access token into chat.

| Need | Purpose | Not for |
| --- | --- | --- |
| Same Lovable-connected production database interface that produced `LIVE_SOURCE_INVENTORY.md`, or an operator-held **read-only** URI for `nbcqwpysqgyxrrbgtmkw` | `pg_dump` of `public` only | This Cloud Agent (it must not store the URI) |
| Existing `checksops_admin` Secrets Manager secret | `CREATE DATABASE`, `pg_restore`, grants, rollback | Lambda `DATABASE_SECRET_ARN` |
| Network path to private RDS (bastion, SSM, or VPC) | `pg_restore` | This Cloud Agent host (it cannot open TCP 5432 to RDS) |
| `checksops` application secret | Later read-only API | DDL |

Current blockers for actually running the copy:

1. No approved execute phase (this runbook forbids dump/restore until then).
2. This environment cannot TCP to private RDS; restore must run from a VPC path.
3. Operator must use existing live read access; this tooling will not request a new token or password.

## Failed-restore rollback

The first copy is isolated in database `checksops`. Production Lovable is never written.

If restore fails **before** the API secret is changed (the intended case):

1. Stop. Do not retry blindly.
2. Connect to maintenance database `postgres` as `checksops_admin`.
3. `DROP DATABASE checksops;` (`aws/db-copy/sql/04_rollback_failed_staging_database.sql`).
4. Do not drop `postgres`. Do not drop roles. Do not change passwords. Do not modify the RDS instance.
5. Staging Lambda continues to use `dbname=postgres`.
6. Delete local dump artifacts (they contain application data).
7. A new approved attempt starts at `CREATE DATABASE checksops` again.

If a restore were ever mistakenly applied to `postgres`, **stop** and do not `DROP DATABASE postgres`.

## Safety

- Do not change production Supabase/Lovable.
- Do not change Moov, CheckAlt, Plaid, Resend, DNS, or production webhooks.
- Do not merge to `main`.
- Do not modify RDS infrastructure to perform this preparation.
- Stop on unexpected dump objects rather than rewriting them in place.
