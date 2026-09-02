# Temporary Lovable → AWS staging Storage COPY bridge

Production Lovable/Supabase Storage stays authoritative. This bridge is COPY-only.

## Capability

Live production already injects `SUPABASE_SERVICE_ROLE_KEY` into Edge Functions. `storage-backup` is deployed and uses that key to read private objects. That function is **not** used here: it writes `storage_backup_log` and copies into `{bucket}-backup`.

This bridge instead:

1. `aws-staging-storage-bridge` (Edge Function) creates short-lived signed GET URLs for approved buckets only.
2. `aws/storage/bridge-copy.mjs` (AWS worker) downloads those URLs and `put-object`s into private staging S3.

The service-role key never leaves the Lovable runtime. AWS access keys are never placed in Lovable. The browser never receives either.

## Auth

Header `x-checksops-migration-token`. Compared to SHA-256 `e5549ea0d88afb24b3b0d7d99db10d6f72a88fa3a724cb8e07d468b11c0625d9`. CORS is omitted (403 on OPTIONS) so normal application users cannot call it from the ChecksOps UI.

## Guardrails

- No Storage delete/update on the source
- No production database writes
- Approved application buckets only; `database_export*` and `ai-knowledge-base` excluded
- Idempotent; hash mismatch refuses overwrite
- Batches of 20 signed URLs, 120s TTL
- Logs never include file bytes, signed URLs, or credentials

## Deploy (Lovable/Supabase management)

```
npx supabase functions deploy aws-staging-storage-bridge --project-ref nbcqwpysqgyxrrbgtmkw
```

`config.toml` sets `verify_jwt = false` for this function only. Platform still injects the service role into `Deno.env`.

## Copy

```
node aws/storage/bridge-copy.mjs /tmp/storage-inventory/dump-objects.json
```

Destination: `s3://checksops-staging-privatefilesbucket-erzqsolpucjp/files/{bucket}/{path}`

## Teardown

Delete the Edge Function from the Lovable/Supabase project after 1,334/1,334 reconciliation. Rotate the migration token. Do not leave the function deployed.
