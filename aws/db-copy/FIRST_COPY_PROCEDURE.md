# First copy procedure (not executed)

Copy **public PostgreSQL schema and application data** from live Lovable ChecksOps into the existing `checksops-staging` RDS instance. This file is the exact operator procedure. **Do not run it until approved.**

Authoritative counts: `aws/db-copy/LIVE_SOURCE_INVENTORY.md`.

## In scope

- 166 public base tables (row data + indexes/constraints)
- 20 public views (after tables)
- PostgreSQL-safe extensions required by the live schema: `pgcrypto`, `uuid-ossp`, `postgis`, `vector`, `pg_stat_statements`
- `auth.uid()` compatibility stubs so 40 public functions can compile
- Data-integrity triggers that do not call `net` / `cron` / `vault` / `pgmq`
- Least-privilege `GRANT SELECT` to application role `checksops`
- Source-vs-target row counts for all 166 tables
- Financial aggregates for check/deposit/endorsement/disbursement/payment tables (`sql/reconciliation_financial.sql`)

## Out of scope (do not copy or activate)

- Supabase Auth (9 `auth.users`; Cognito later). Live catalog found **no** public FKs to `auth.users`. Do not copy password hashes, sessions, tokens, identities, or MFA.
- Storage (1,335 objects; S3 later)
- RLS **activation** (380 policies: extract to a sidecar file, do not enable on first restore)
- Realtime
- `pg_cron` jobs, `pg_net` HTTP, `supabase_vault` / `pgsodium`, `pgmq`
- Production webhooks (Moov, CheckAlt, Plaid, Resend)
- DNS, `main`, frontend cutover
- Changing `checksops` or `checksops_admin` passwords
- Creating or modifying the RDS instance

## Temporary access required (when approved; not requested now)

Do not create a new credential in this pass. Do not request another Supabase access token or database password.

| Access | Who | Use |
| --- | --- | --- |
| Same Lovable-connected production database interface that produced `LIVE_SOURCE_INVENTORY.md`, or an operator-held **read-only** URI for project `nbcqwpysqgyxrrbgtmkw` | Operator | `pg_dump` of `public` only |
| Existing `checksops_admin` Secrets Manager secret | Operator on a host that can reach private RDS | `CREATE DATABASE`, `pg_restore`, grants, rollback |
| Network path to `checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com:5432` | Operator (VPC/bastion/SSM). This Cloud Agent cannot open TCP 5432 | Restore |

Never log or commit URIs or passwords. Do not point Lambda `DATABASE_SECRET_ARN` at the admin secret.

## Exact steps (apply: false until approval)

Work only in a **new database named `checksops`**. Leave `postgres` untouched so `/db-health` on the current secret keeps working.

1. Confirm live inventory still matches `LIVE_SOURCE_INVENTORY.md` (166 tables, 20 views). Stop if not.
2. As `checksops_admin` on the existing instance: `CREATE DATABASE checksops;`
3. Connect to `checksops`. Run `aws/db-copy/sql/00_rds_supported_extensions.sql`. **Stop** if `postgis` or `vector` is unavailable.
4. Run `aws/db-copy/sql/01_auth_compatibility_stubs.sql` (stubs only; do not load Auth users).
5. From the live source, read-only:
   - `pg_dump --format=custom --schema=public --schema-only --no-owner --no-acl --no-publications --no-subscriptions` → `public-schema.dump`
   - `pg_dump --format=custom --schema=public --data-only --no-owner --disable-triggers` → `public-data.dump`
   - Extract `CREATE POLICY` / `ENABLE ROW LEVEL SECURITY` / `FORCE ROW LEVEL SECURITY` to `public-rls.sql` and **do not restore that file**
6. `pg_restore -l public-schema.dump` → filter out POLICY and ROW SECURITY entries → `public-schema.list`
7. `pg_restore --dbname=checksops --no-owner --no-acl --use-list=public-schema.list --exit-on-error public-schema.dump`
8. `pg_restore --dbname=checksops --data-only --disable-triggers --no-owner --exit-on-error public-data.dump`

When the approved artifact is a **full-database** custom dump (the S3 object `Migration/checksops_260901(1).backup`) instead of public-only dumps, use one `pg_restore --use-list` after the same CREATE DATABASE / extensions / auth-stub steps. Filter the TOC to skip: POLICY, ROW SECURITY, ACL, EXTENSION, TABLE ATTACH, objects owned by `supabase_auth_admin` / `supabase_storage_admin` / `supabase_realtime_admin` / `supabase_admin`, `SEQUENCE OWNED BY` outside `public`, and every object in excluded schemas (`auth`, `storage`, `realtime`, `cron`, `net`, `vault`, `pgmq`, `pgsodium`, `supabase_functions`, `extensions`, `graphql`). Do not enable realtime/cron/net/vault/pgmq to make those objects restore.
9. Run `aws/db-copy/sql/03_inspect_supabase_dependencies.sql`. Disable or no-op functions/triggers that call `net.*`, `cron.*`, vault, or `pgmq`. Keep data-integrity triggers. Stop rather than guessing.
10. Confirm RLS is not enabled for the application path: `checksops` must be able to `SELECT` without `auth.uid()`.
11. Run `aws/db-copy/sql/02_grant_readonly_application_role.sql` against database `checksops`.
12. Run `aws/db-copy/sql/reconciliation_counts.sql` on source and target; all 166 counts must match.
13. Run `aws/db-copy/sql/reconciliation_financial.sql` on source and target; payment/check/deposit/endorsement/disbursement metrics must match.
14. Leave the staging API `dbname` on `postgres` until a later approved cutover.

`node aws/db-copy/cli.mjs plan` prints the same sequence with `apply now: false`.

## Failed-restore rollback / cleanup

The first copy is isolated in database `checksops`. Production Lovable is never written.

If restore fails **before** the API secret is changed (the intended case):

1. Stop. Do not retry blindly.
2. Connect to maintenance database `postgres` as `checksops_admin`.
3. `DROP DATABASE checksops;` (see `aws/db-copy/sql/04_rollback_failed_staging_database.sql`).
4. Do not drop `postgres`. Do not drop roles `checksops` or `checksops_admin`. Do not change passwords.
5. Staging Lambda continues to use `dbname=postgres` (`SELECT 1` health).
6. Inspect dump artifacts locally; delete dump files after the incident (they contain application data).
7. A new approved attempt starts at `CREATE DATABASE checksops` again.

If `CREATE EXTENSION` fails, drop `checksops` the same way. Do not enable `pg_cron` / `pg_net` / vault / `pgmq` as a workaround.

If a restore were ever mistakenly applied to `postgres`, **stop** and do not `DROP DATABASE postgres`. That case is out of this procedure and needs a separate review. This procedure forbids restoring into `postgres`.

Optional extra safety (does not change instance class/networking): an RDS snapshot of `checksops-staging` immediately before `CREATE DATABASE`, used only if an operator later needs instance-level recovery. Not required for dropping the empty-or-partial `checksops` database.
