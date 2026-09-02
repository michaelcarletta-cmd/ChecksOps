# AWS staging S3 Storage phase results

Date: 2026-09-02. Production Lovable/Supabase unchanged. `default_transaction_read_only=on` unchanged. Providers unchanged.

## Source inventory

Re-queried live Storage with the production anon JWT. Private buckets list as empty (RLS). Public buckets match the dump:

| Bucket | Live anon list | Dump objects | Live public GET |
| --- | ---: | ---: | --- |
| tenant-logos | 5 | 5 | 200 |
| email-assets | 1 | 1 | 200 |
| claim-files | denied | 1,184 | 400 |
| endorsement-packets | denied | 125 | 400 |
| homeowner-uploads | denied | 8 | 400 |
| tenant-documents | denied | 8 | 400 |
| loss-draft-documents | denied | 2 | 400 |
| document-templates | denied | 1 | 400 |
| others | 0 / denied | 0 | n/a |

Dump `storage.objects`: **1,334** application objects, **2,501,472,395** bytes. The earlier **1,335** catalog count includes `database_export_01_09_26`, which is not migrated.

Live private object bytes cannot be downloaded without a production Storage service role. PAT in `.env.example` is unauthorized. Provider secret has no current string.

## Copy

Destination: `s3://checksops-staging-privatefilesbucket-erzqsolpucjp/files/{bucket}/{path}`

| | Count | Bytes |
| --- | ---: | ---: |
| Copied | **6** | **3,702,461** |
| Failed (`private_requires_service_role`) | **1,328** | remaining dump bytes |
| Hash conflicts | 0 | |
| Skipped buckets | export / ai-knowledge-base | |

Copied keys are the five tenant logos (Freedom + C1C) and `email-assets/checksops-logo.png`. Source was not modified.

Block Public Access remains fully on. CORS allows GET/HEAD for presigned browser fetches. Direct S3 GET without signature returns 403.

## API

Deployed to `checksops-staging-api` (no `sam deploy`).

Authenticated: `POST /storage/sign`, `/storage/sign-many`, `/storage/list`, `/storage/download`.
Public branding: `GET /storage/public` (302 to presign) only for `tenants_public.logo_url` matches and `email-assets/checksops-logo.png`.
Uploads/deletes: `uploads_disabled`.
Public token reads: `POST /public/signature-document`, `POST /public/endorsement` (submit stays `writes_disabled`).

## Live authorization probes

| Probe | Result |
| --- | --- |
| Tester Freedom logo sign + GET | 200, PNG 885,435 bytes |
| C1C Freedom logo sign | **403** `storage_forbidden` (app UUID `fd857564-…`, spoof ignored) |
| C1C own logo sign | 200 |
| Tester Freedom check image | **404** `object_not_in_s3` (RLS authorized; bytes not copied) |
| C1C Freedom check image | **403** |
| Tester endorsement packet | **404** `object_not_in_s3` |
| C1C endorsement packet | **403** |
| Unauthenticated `/storage/sign` | **401** |
| Unauthenticated `/storage/public` claim-files | **403** |
| Direct S3 key / bogus presign | **403** |

Identity mapping unchanged: Tester `abd3c2a0-…`, C1C `fd857564-…`.

## Frontend

AWS-mode `storage.from` uses the Storage API. Production client unchanged. Sign/Endorse use `/public/*` only when `VITE_AUTH_PROVIDER=cognito`.

## Blocker

Private application objects (claim/check documents, endorsement packets, homeowner uploads, tenant documents, document templates) are **not** in staging S3. A read-only production Storage service role is required to finish the COPY. Do not declare Storage complete until those 1,328 objects are copied and reconciled.

## Completion

Storage phase is **not complete**. Overall AWS staging migration remains blocked on private object copy plus later write/provider cutover. Approximate overall migration completion after this work: **about 70%** of the isolated staging path (restore, RLS, Cognito, frontend reads, storage API/security) with Storage copy at **6 / 1,334** application objects.
