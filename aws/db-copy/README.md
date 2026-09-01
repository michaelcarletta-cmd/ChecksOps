# ChecksOps staging database copy

Preparation-only tooling for copying the **live** ChecksOps Supabase/Lovable PostgreSQL database into the existing `checksops-staging` RDS instance (PostgreSQL 18.3).

Authoritative catalog: [`LIVE_SOURCE_INVENTORY.md`](LIVE_SOURCE_INVENTORY.md) (166 public base tables, 20 views). Exact operator steps: [`FIRST_COPY_PROCEDURE.md`](FIRST_COPY_PROCEDURE.md). Runbook: `docs/AWS_DB_COPY_RUNBOOK.md`.

Do not run dump or restore from this directory yet. Do not request another Supabase access token or database password.

```bash
node aws/db-copy/cli.mjs validate
node aws/db-copy/cli.mjs inventory
node aws/db-copy/cli.mjs plan
node aws/db-copy/cli.mjs live-inventory
node --test aws/db-copy/tests/db-copy-offline.test.mjs
```

`dump` / `restore` remain disabled. `live-inventory` reads the committed inventory file and does not contact the database.
