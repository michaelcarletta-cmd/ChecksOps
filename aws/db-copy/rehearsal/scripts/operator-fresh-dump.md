# Operator: optional extra production dump (read-only)

Cloud Agents cannot hold the production DB URI (`aws/db-copy/lib/live-access.mjs`).

The 2026-09-05 rehearsal used the fail-closed `aws-staging-db-bridge` plus the Sept. 1 dump as baseline. A fresh dump is **optional extra evidence**, not a blocker, while that bridge remains deployed.

## Dump (operator host)

```bash
# URI never echoed to CI/chat. Prefer a read-only role.
export PGDUMP_URI='…read-only connection…'

# Custom format; no owner/ACL (RDS roles differ)
pg_dump "$PGDUMP_URI" \
  -Fc --no-owner --no-acl \
  -f "checksops_$(date -u +%Y%m%d).backup"

# Upload without overwriting the Sept-1 baseline
aws s3 cp "checksops_$(date -u +%Y%m%d).backup" \
  "s3://checksops-staging-privatefilesbucket-erzqsolpucjp/Migration/checksops_$(date -u +%Y%m%d).backup"
```

Confirm:

```bash
aws s3 ls s3://checksops-staging-privatefilesbucket-erzqsolpucjp/Migration/
```

## Sanitized catalog (optional, paste counts only)

```sql
SELECT
  (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') AS base_tables,
  (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='VIEW') AS views,
  (SELECT count(*) FROM information_schema.routines WHERE routine_schema='public') AS routines,
  (SELECT count(*) FROM information_schema.triggers WHERE trigger_schema='public') AS triggers,
  (SELECT count(*) FROM pg_policies WHERE schemaname='public') AS rls_policies,
  (SELECT count(*) FROM auth.users) AS auth_users,
  (SELECT count(*) FROM storage.objects) AS storage_objects;
```

Do not paste emails, names, account numbers, or storage object names into GitHub.
