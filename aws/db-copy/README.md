# ChecksOps staging database copy

Preparation-only tooling for copying the **live** ChecksOps Supabase/Lovable PostgreSQL database into the existing `checksops-staging` RDS instance (PostgreSQL 18.3).

Do not run dump or restore from this directory yet. See `docs/AWS_DB_COPY_RUNBOOK.md`.

```bash
node aws/db-copy/cli.mjs validate
node aws/db-copy/cli.mjs inventory
node aws/db-copy/cli.mjs plan
node --test aws/db-copy/tests/db-copy-offline.test.mjs
```

`dump` / `restore` remain disabled. `live-inventory` stops unless dedicated live catalog credentials are provided.
