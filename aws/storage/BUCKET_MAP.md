# ChecksOps storage bucket map (AWS staging S3)

Live source: Lovable/Supabase project `nbcqwpysqgyxrrbgtmkw` (`https://nbcqwpysqgyxrrbgtmkw.supabase.co`).

Destination: private bucket `checksops-staging-privatefilesbucket-erzqsolpucjp` (all Block Public Access flags on, versioning on).

S3 key: `files/{supabase_bucket}/{original_object_path}`

Database `file_path` / image path values stay relative to the Supabase bucket. The Storage API translates them to S3 keys. Do not store S3 URLs in the restored database during this phase.

## Live re-query (2026-09-02)

Anon/publishable listing of live Storage:

| Bucket | Live list (anon) | Dump `storage.objects` (2026-09-01) | Public? | Migrate |
| --- | ---: | ---: | --- | --- |
| ai-knowledge-base | 0 / empty-or-denied | 0 | no | inventory only |
| claim-files | empty-or-denied | 1,184 | no | yes (private) |
| claim-files-backup | empty-or-denied | 0 | no | map only |
| company-branding | empty-or-denied | 0 | yes in source | map only |
| contractor-documents | empty-or-denied | 0 | no | map only |
| database_export_01_09_26 | empty-or-denied | 0 in objects extract | no | **do not copy** |
| deposit-attachments | empty-or-denied | 0 | no | map only |
| document-templates | empty-or-denied | 1 | no | yes (private) |
| email-assets | **1** | 1 | yes | yes |
| endorsement-packets | empty-or-denied | 125 | no | yes (private) |
| homeowner-uploads | empty-or-denied | 8 | no | yes (private) |
| loss-draft-documents | empty-or-denied | 2 | no | yes (private) |
| tenant-documents | empty-or-denied | 8 | no | yes (private) |
| tenant-logos | **5** | 5 | yes | yes |

Dump `storage.objects` count: **1,334** application objects. Earlier live catalog count of **1,335** includes the `database_export_01_09_26` artifact, which is not copied into `files/`.

Private buckets return HTTP 200 + `[]` to anon list and refuse GET/sign without a user JWT. Treat dump metadata as the last complete object catalog. Live-confirmed today: tenant-logos 5 and email-assets 1 (public GET 200).

Do **not** assume 1,335 is still the live private count. A service-role re-list is required to refresh private buckets.

## Skip

- `ai-knowledge-base` (empty)
- `database_export_01_09_26` and any `Migration/*` dump already in the staging bucket
- `claim-files-backup` (empty; backup of backups)

## Security model

- S3 stays private. No bucket policy for public `s3:GetObject`.
- Browser never receives AWS credentials.
- Authenticated reads: Cognito ID token → `identity_accounts.application_user_id` → `request.app_user_id` → RLS row that references the path → short-lived S3 `GetObject` presign (30s–14400s).
- Spoofed `x-tenant-id` / `x-user-id` / body tenant id are ignored.
- Knowing an S3 key is not sufficient; Head/Get without a presign fails on the private bucket.
- Unauthenticated access is only `GET /storage/public` for `tenant-logos` paths referenced by `tenants_public.logo_url`, plus the platform `email-assets/checksops-logo.png`.
- Uploads, deletes, and moves return `uploads_disabled` until that authorization model is validated.

## API

| Route | Auth | Behavior |
| --- | --- | --- |
| `POST /storage/sign` | Cognito | RLS-authorize then presign |
| `POST /storage/sign-many` | Cognito | batch of the same |
| `POST /storage/list` | Cognito | DB-visible paths for the bucket, not raw S3 prefix list |
| `POST /storage/download` | Cognito | same as sign |
| `GET /storage/public` | none | branding only; 302 to presign |
| `POST /storage/*` other | Cognito or none | `uploads_disabled` |
| `POST /public/signature-document` | token hash | exact signer document presign |
| `POST /public/endorsement` | token | read-only endorsement payload |
| `POST /public/signature-submit` | token | `writes_disabled` |
