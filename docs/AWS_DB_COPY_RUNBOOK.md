# ChecksOps AWS staging database copy runbook

**This phase is preparation only.** Do not export, restore, truncate, drop, overwrite, or modify the live Supabase/Lovable database or the existing `checksops-staging` RDS instance yet.

Live ChecksOps Supabase/Lovable PostgreSQL is the source of truth. The target is the existing AWS RDS instance `checksops-staging` (PostgreSQL 18.3, `checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com:5432`). Do not create another RDS instance.

The application role `checksops` stays least-privileged. Eventual schema restore uses `checksops_admin` only. Do not commit or print either password.

## What this tooling does now

Offline inventory and a dump/restore plan, derived from:

- `src/integrations/supabase/types.ts` (166 public tables, 20 views, 358 functions, 18 enums at scan time)
- `supabase/migrations/` (extension, RLS, `auth.users`, `pg_net` / `pg_cron` / vault references)
- `supabase/functions/` (151 Edge Functions)

Generated types can lag the live database. A prior direct inspection of live Lovable ChecksOps (`nbcqwpysqgyxrrbgtmkw`) found **186 public tables**; the repository scan has **166**. **The live catalog must control the migration inventory.** This environment could not complete that live inventory (see below).

```bash
node aws/db-copy/cli.mjs validate
node aws/db-copy/cli.mjs inventory
node aws/db-copy/cli.mjs plan
node aws/db-copy/cli.mjs live-inventory
node --test aws/db-copy/tests/db-copy-offline.test.mjs
```

`dump` and `restore` refuse unless `CHECKSOPS_DB_COPY_EXECUTE=I_UNDERSTAND_THIS_WRITES_DATA` and `--execute` are both set. This checkout still stops even then.

## Live inventory status (2026-09-01)

**Stopped. No live catalog was collected. No pg_dump, no application-row export, no RDS restore, no source or AWS changes.**

| Item | Result |
| --- | --- |
| Live project | `nbcqwpysqgyxrrbgtmkw` (`https://nbcqwpysqgyxrrbgtmkw.supabase.co`) from `supabase/config.toml` and `.env.production` |
| Repo generated public tables | 166 |
| Prior live public tables | 186 |
| Gap | 20 tables — **names unknown until live catalog access** |
| Vite publishable key for live project | Present; Auth health works; cannot read `pg_catalog` / OpenAPI / all table counts |
| Management API token for live project | **Missing** (403 access-control on `nbcqwpysqgyxrrbgtmkw`) |
| Other project named ChecksOps | `sqyyvpaymashtdwjjmku` is visible to an existing PAT. **Do not inventory it as live.** |
| Live read-only Postgres URI | Absent from this environment |

Machine-readable copy: `aws/db-copy/live-inventory-status.json`.

### Access required for the live inventory (do not paste a database password into chat)

Store **one** of these as a Cursor Cloud environment secret, then re-run `node aws/db-copy/cli.mjs live-inventory`:

1. `CHECKSOPS_LIVE_SUPABASE_ACCESS_TOKEN` — fine-grained Supabase token with **`database_read` on `nbcqwpysqgyxrrbgtmkw`**. Queries will use `POST /v1/projects/nbcqwpysqgyxrrbgtmkw/database/query` with `read_only=true`.
2. `CHECKSOPS_LIVE_SUPABASE_DB_URL` — read-only Postgres URI for that same project (`default_transaction_read_only=on`). Direct `pg_dump` is still forbidden until a later approved copy phase.

Not sufficient: the Vite publishable/anon key. Not acceptable: using `sqyyvpaymashtdwjjmku` as a stand-in for production.

## Lanes

| Lane | This copy | Notes |
| --- | --- | --- |
| PostgreSQL schema | Direct, with transforms below | `public` tables, indexes, constraints, sequences, views, enums |
| Public application data | Direct | Including sensitive tables; never print dump contents |
| Database functions/triggers | Transform | Restore data-integrity triggers; stub or strip `auth.*`, `net.http_*`, vault, cron |
| Auth users | Transform identity map now; Cognito later | UUID/email only so FKs succeed. Not passwords or sessions |
| Storage objects | Later | S3 copy with key mapping. Not `pg_restore` |
| RLS / security policies | Later | Dump sidecar SQL. Do not apply on first RDS restore |
| Edge Functions / webhooks | Later | Lambda rewrite. Do not change Moov, CheckAlt, Plaid, Resend, or DNS |

## What will migrate directly

Public ChecksOps application objects that PostgreSQL/RDS can restore:

- All `public` tables in the live dump (checks, deposits, endorsements, disbursements, wallets, provider accounts, tenants, users, claims, audit logs, reconciliation, billing, Darwin/claim intelligence, etc.)
- Indexes, unique constraints, foreign keys, check constraints, primary keys
- Sequences and identity defaults
- Public views that do not depend on Supabase catalogs (examples: `tenant_safe`, `deposit_reconciliation_summary`, `claim_money_snapshot`)
- Enums (`check_stage`, `app_role`, …)
- `pgcrypto` and other RDS-supported extensions listed in `aws/db-copy/sql/00_rds_supported_extensions.sql`

Critical reconciliation tables (must match source vs RDS row counts):

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

Financial aggregates to compare are in `aws/db-copy/sql/reconciliation_financial.sql`.

## What requires transformation

These cannot be a literal Supabase restore onto RDS:

1. **`auth.users` foreign keys** — many public columns `REFERENCES auth.users(id)`. Create the stub table in `aws/db-copy/sql/01_auth_compatibility_stubs.sql` and load `id, email` only before data restore.
2. **`auth.uid()`, `auth.jwt()`, `auth.role()`, `auth.email()`** — used by RLS and helper functions (`has_role`, `is_tenant_member`, `is_platform_owner`, …). Install no-op stubs so functions compile. They will not see a JWT on RDS.
3. **Owners and ACLs** — dump with `--no-owner --no-acl`. Supabase roles `anon`, `authenticated`, and `service_role` do not exist on RDS.
4. **`pg_net` / `net.http_*`** — not on RDS. Database HTTP callbacks must not be restored as working jobs.
5. **`pg_cron` jobs** — do not recreate against production URLs. Replace later with EventBridge.
6. **`supabase_vault` / `pgsodium` / `pgmq`** — not restored. Secrets stay in AWS Secrets Manager.
7. **PostGIS / pgvector** — enable on RDS only if the live dump actually contains those types (`geography_columns` / `geometry_columns` appear in generated views; Darwin migrations create `vector`).
8. **Least-privilege `checksops`** — after restore, grant `CONNECT` + `SELECT` only (`aws/db-copy/sql/02_grant_readonly_application_role.sql`). Do not grant `BYPASSRLS`, writes, or DDL.

## What will migrate later

- **Supabase Auth → Cognito** (passwords, MFA, sessions, GoTrue hooks). Do not assume a dump of `auth.users` can be imported into Cognito.
- **Storage → S3** (buckets such as `claim-files`, `deposit-attachments`, `tenant-documents`, `tenant-logos`, `company-branding`, `loss-draft-documents`, `homeowner-uploads`). Preserve object key mapping. Do not `pg_restore` `storage.objects`.
- **RLS policies** (~380 live). Extract to a sidecar file. Applying them on RDS would hide rows from `checksops` because `auth.uid()` is null. Tenant isolation moves to the AWS API first.
- **Realtime** publications and `supabase_functions` schema.
- **Edge Functions → Lambda**, including `moov-webhook`, `plaid-transfer-webhook`, `resend-webhook`, CheckAlt, and billing webhooks. **Do not switch production webhook destinations.**
- **Application writes** and frontend cutover.

## Proposed exact sequence (later approved phase)

Do not start this sequence until a copy is explicitly approved.

1. Freeze nothing on production yet. Take a **read-only** source snapshot URI (Supabase dashboard / replica). Never use the production writer if a replica exists.
2. As `checksops_admin`, `CREATE DATABASE checksops` on the existing instance. Do not drop `postgres`.
3. Enable RDS-safe extensions (`00_rds_supported_extensions.sql`). Stop if an extension is unavailable rather than skipping silently.
4. Create auth compatibility stubs (`01_auth_compatibility_stubs.sql`).
5. Export `auth.users (id, email, created_at)` identity map. No password hashes.
6. `pg_dump --schema=public --schema-only --no-owner --no-acl --no-publications --no-subscriptions`.
7. Extract `CREATE POLICY` / `ENABLE ROW LEVEL SECURITY` into `public-rls.sql`. Do not restore that file.
8. `pg_dump --schema=public --data-only --disable-triggers`.
9. `pg_restore` schema, load identity map, `pg_restore` data as `checksops_admin`.
10. Inspect functions/triggers for `net.http_`, `cron.`, `vault.`, `storage.`. Disable or stop.
11. Grant read-only to `checksops`. Do not change the `checksops` or `checksops_admin` passwords as part of the copy.
12. Run `reconciliation_counts.sql` and `reconciliation_financial.sql` on source and RDS. Diff must be zero for critical tables/metrics.
13. Point the staging API secret `dbname` at `checksops` only after reconciliation passes (separate change).
14. Leave Auth, Storage, RLS apply, Edge Functions, and provider webhooks for later phases.

`node aws/db-copy/cli.mjs plan` prints the command templates without credentials.

## Credentials and access required later

Do not put these in Git.

| Need | Purpose | Not for |
| --- | --- | --- |
| Live Supabase database URI (read-only if possible) | `pg_dump` | Application role on RDS |
| `checksops_admin` Secrets Manager secret | Schema/data restore | Lambda `DATABASE_SECRET_ARN` |
| Network path to private RDS (bastion, SSM, or VPC) | `pg_restore` | This Cloud Agent host (it cannot open TCP 5432 to RDS) |
| `checksops` application secret | Later read-only API | DDL |

Current blockers for actually running the copy:

1. Live catalog inventory is blocked: this environment lacks `database_read` (or a read-only DB URI) on `nbcqwpysqgyxrrbgtmkw`. Repository types are 166 tables; live was 186.
2. No approved execute phase (this runbook forbids dump/restore).
3. This environment cannot TCP to private RDS; restore must run from a VPC path.
4. PostGIS / pgvector availability on this RDS instance is unconfirmed until an admin `CREATE EXTENSION` attempt in the later phase.

## Safety

- Do not change production Supabase/Lovable.
- Do not change Moov, CheckAlt, Plaid, Resend, DNS, or production webhooks.
- Do not merge to `main`.
- Do not modify RDS infrastructure to perform this preparation.
- Stop on unexpected dump objects rather than rewriting them in place.
