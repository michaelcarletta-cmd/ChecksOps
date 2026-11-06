# Shut down the legacy Supabase project `nbcqwpysqgyxrrbgtmkw`

Owner, 2026-11-06: "Let's shut down supabase now".

This runbook changes nothing by itself. Claude sessions cannot reach Supabase (the egress proxy
refuses `api.supabase.com` and `nbcqwpysqgyxrrbgtmkw.supabase.co`), so every step that touches
Supabase is run by the owner. Deleting the project is permanent; the steps keep an exact copy of its
data in AWS first and pause before they delete.

## Live state (read-only, 2026-11-06 ~18:25 UTC, `user/claude-code`)

| Check | Result |
|---|---|
| Live SPA at `https://checksops.com` | `index.html` and all 83 JavaScript files it loads (`index-DMtlCIui.js` and 82 chunks) contain no `supabase.co` URL and no project ref. The AWS build drops the Supabase fallbacks (`src/lib/publicWorkflowApi.ts`). |
| Production API Lambda `checksops-production-prep-api` | No environment variable named for Supabase, the bridge or Lovable, and no value containing `supabase` |
| Staging API Lambda `checksops-staging-api` | No Supabase, bridge, Plaid or Lovable variable (the October cleanup item is done) |
| Secrets Manager `checksops/…` | No secret named for Supabase, migration, bridge, Lovable or Plaid (`checksops/staging/storage-migration-token` is gone) |
| Bridges `aws-staging-db-bridge`, `aws-staging-storage-bridge` | Deleted 2026-10-21, both 404 (`aws/cutover/BRIDGE_TEARDOWN.md`) |

**Not proven by anything in the repository:** the conditions `aws/cutover/BRIDGE_TEARDOWN.md` sets
for a completed cutover, in particular a final storage reconciliation with 0 missing objects and
0 hash mismatches, and a final database count comparison. The project still holds the pre-AWS copy
of customer data that `docs/DATA_RETENTION.md` requires ChecksOps to keep for 7 years. Steps 1 and 2
close that gap before anything is removed.

**Still referencing Supabase in the repository (not live):** `.env.production` (Lovable build
variables), the non-AWS branches of `src/lib/publicWorkflowApi.ts`, `src/integrations/supabase/`,
and `supabase/`. Step 5 removes them.

## Step 1 — final export into AWS (owner)

Keeps an exact, encrypted copy of everything in the project before anything is switched off.

1a. Create the archive bucket in CloudShell:

```bash
B=checksops-production-supabase-archive-806168576068
aws s3api create-bucket --bucket "$B" --region us-east-1
aws s3api put-public-access-block --bucket "$B" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket "$B" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$B" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"},"BucketKeyEnabled":true}]}'
```

1b. On a trusted computer (not a shared one), with the database connection string from the
Supabase dashboard (Project Settings → Database). Never paste it into a chat, a PR or a log.

```bash
pg_dump "$SUPABASE_DB_URL" --format=custom --no-owner --file supabase-final-2026-11.dump
sha256sum supabase-final-2026-11.dump > supabase-final-2026-11.dump.sha256
```

1c. Download every Storage bucket (Supabase CLI storage copy, or the dashboard), keeping the bucket
and path layout, into `supabase-storage/`. Record the object count and total bytes per bucket.

1d. Upload and verify:

```bash
aws s3 cp supabase-final-2026-11.dump        s3://$B/db/
aws s3 cp supabase-final-2026-11.dump.sha256 s3://$B/db/
aws s3 cp supabase-storage/ s3://$B/storage/ --recursive
aws s3 ls s3://$B/storage/ --recursive --summarize | tail -2   # count and bytes match 1c
```

Delete the local copies afterwards. Record in the "Applied" section below: dump size and sha256,
storage object count and bytes per bucket, and the upload time. No row data or file names.

**Stop** if the dump or any upload fails.

## Step 2 — prove AWS has everything (owner and Claude)

2a. Owner, Supabase SQL editor (read-only): row counts for every table in `public`:

```sql
select table_name,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text::bigint as rows
from information_schema.tables
where table_schema = 'public' and table_type = 'BASE TABLE'
order by 1;
```

Save the result as CSV (names and counts only).

2b. AWS side, the same counts on `checksops-production` through a read-only inspect of the
production SQL one-shot (`ops/production-sql-one-shot.md`, `--phase inspect`). That needs its own
small inspect PR; Claude prepares it on request. Never a hand-run psql session.

2c. Storage: AWS private-files object count and bytes (owner, CloudShell, since the Claude IAM user
cannot list that bucket):

```bash
aws s3 ls s3://checksops-production-privatefiles-806168576068/ --recursive --summarize | tail -2
```

2d. Compare. Every Supabase table must have the same or a higher count on AWS (AWS has kept
receiving writes since cutover), or a written reason (a retired table, a table deliberately not
migrated). Storage on AWS must hold at least the Supabase object count per bucket.

**Stop** on any table or bucket with fewer rows or objects on AWS and no written reason. Bring it to
the owner; do not continue. The Step 1 archive means nothing is lost while it is investigated.

## Step 3 — pause, then watch (owner)

1. Supabase dashboard → Project Settings → General → **Pause project**, if the plan allows it. If
   it does not, use the dashboard's option to stop compute or downgrade first; check Supabase's
   current documentation for the plan.
2. Watch for 14 days:
   - API Gateway 5xx and Lambda errors stay at their usual level;
   - no tenant reports a broken sign, endorse or upload link;
   - Moov and CheckAlt webhooks keep arriving in `aws_provider_webhook_receipts`.
3. Anything that breaks: restore the project from the dashboard, record what depended on it, and stop.

## Step 4 — delete (owner, after 14 clean days)

1. Supabase dashboard → Project Settings → General → **Delete project**.
2. Cancel the Supabase subscription if no other project uses it.
3. Revoke any Supabase personal access tokens and remove Supabase secrets from GitHub
   (`Settings → Secrets and variables → Actions`), Lovable and password managers.
4. Lovable: disconnect or delete the Lovable project
   (`1cf02be0-d8a8-476b-aa64-79b68ee31cec`) so it cannot publish over anything, and remove its
   GitHub app access if no longer used.

## Step 5 — repository and policy cleanup (Claude, separate PRs)

1. Remove `.env.production` Supabase variables, the non-AWS branches of
   `src/lib/publicWorkflowApi.ts`, and other runtime Supabase references the AWS build no longer
   uses. Code change through the normal PR path, with `bun run build:aws` and the full test suite.
2. Decide what to keep from `supabase/` (the migrations are history the restored schema came from;
   archive them rather than delete).
3. Update `docs/WISP.md` §3.6, `docs/compliance/SYSTEM_DESCRIPTION.md` and the control matrix:
   Supabase removed as a vendor; the archive bucket added to the data inventory, with its retention
   (7 years, `docs/DATA_RETENTION.md`).

## Applied

Record each step here: who, when (UTC), the evidence listed in the step, and anything that differed
from the plan.
