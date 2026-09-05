# Temporary migration bridge teardown (AFTER successful cutover only)

**DO NOT TEAR DOWN NOW.** Both bridges remain the last-mile path for the final production delta.

Live (2026-09-05):

| Function | Health | Mode | Forbidden ops |
|---|---|---|---|
| `aws-staging-db-bridge` | HTTP 200 | `read_only` | writes/deletes/rpc/rawSql = false |
| `aws-staging-storage-bridge` | HTTP 200 | `sign_only` | deletes = false, dbWrites = false |

Project ref: `nbcqwpysqgyxrrbgtmkw`. Auth header `x-checksops-migration-token` (Secrets Manager `checksops/staging/storage-migration-token`). Never log the token.

Dry-run (refuses `--apply`):

```bash
node aws/cutover/scripts/bridge-teardown-dry-run.mjs
```

## When teardown is allowed

All of the following are true:

1. Human has declared production cutover **successful** (DNS + auth on AWS, recon PASS).
2. Final DB overlay is in the production AWS database (not only a rehearsal name).
3. Final storage COPY recon is 0 missing / 0 hash mismatch.
4. Bridges are no longer needed for a retry (Point A/B rollback window closed).
5. Migration token will be rotated in the same change window.

If cutover **failed**, keep both functions deployed.

## Ordered teardown (future operator, not this PR)

1. Confirm production API no longer needs a live Supabase read for delta.
2. `npx supabase functions delete aws-staging-db-bridge --project-ref nbcqwpysqgyxrrbgtmkw`
3. `npx supabase functions delete aws-staging-storage-bridge --project-ref nbcqwpysqgyxrrbgtmkw`
4. Rotate `checksops/staging/storage-migration-token` (and any copy in operator secret stores).
5. `POST` both function URLs → expect 404 / not found. Record HTTP status only.
6. Remove `verify_jwt = false` exceptions from `config.toml` if those functions were the only exceptions.
7. Do **not** delete the production Supabase project in the same step; Lovable rollback may still need it.

## What teardown is not

- Not a Storage or DB delete of customer data
- Not an S3 bucket empty
- Not RDS `DROP DATABASE`
- Not DNS rollback
