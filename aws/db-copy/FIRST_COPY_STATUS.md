# First copy attempt — stopped

Approved copy was **not executed**. Live source could not be exported with access currently available in this Cloud Agent. No writes were made to Lovable/Supabase or to RDS. Database `checksops` was **not** created. Staging Lambda still uses `dbname=postgres`.

## What was checked

- No `CHECKSOPS_LIVE_SUPABASE_DB_URL` / `SUPABASE_DB_URL` in this environment.
- AWS Secrets Manager has RDS admin/app credentials and a providers secret; **none** is a live Supabase URI.
- Vite publishable key for `nbcqwpysqgyxrrbgtmkw` can hit Auth health (200) and cannot dump `/rest/v1` (401 secret key required).
- Committed example Management API token returns **403** against live project `nbcqwpysqgyxrrbgtmkw`. The other ChecksOps project was not used.
- Supabase pooler TCP `5432`/`6543` is reachable from this VM, but there is no password/URI to authenticate.
- Private RDS `checksops-staging:5432` times out from this VM. Staging API `/db-health` remains 200 on `postgres`.

## Operator action required

See `FIRST_COPY_PROCEDURE.md`. Minimum to continue:

1. Add Cursor Cloud environment secret `CHECKSOPS_LIVE_SUPABASE_DB_URL` = read-only URI for **only** `nbcqwpysqgyxrrbgtmkw` (never paste into chat), **or** drop `public-schema.dump` + `public-data.dump` in an S3 prefix this role can read.
2. Confirm restore may run via a temporary VPC Lambda using the existing `checksops_admin` secret (deleted after restore), because this agent cannot open TCP 5432 to RDS.
