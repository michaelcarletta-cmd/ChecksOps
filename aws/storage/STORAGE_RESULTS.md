# AWS staging S3 Storage phase results

Date: 2026-09-02. Production Lovable/Supabase unchanged. `default_transaction_read_only=on` unchanged. Providers unchanged. This phase **STOPS** after S3 copy, reconciliation, Storage API integration, and authenticated staging file reads.

Storage is **not complete**. Private application bytes were not copied.

## 1. Source inventory (authoritative)

Re-queried live Lovable/Supabase Storage (`https://nbcqwpysqgyxrrbgtmkw.supabase.co`) on 2026-09-02. Private buckets list as empty to the anon JWT (RLS). Public buckets were walked recursively.

Do **not** treat the earlier catalog count of **1,335** as current. That figure included `database_export_01_09_26`, which is not an application bucket.

Dump `storage.objects` from `checksops_260901` (last complete object catalog, including MIME and sizes):

| Bucket | Live anon | Dump objects | Dump bytes | Migrate |
| --- | ---: | ---: | ---: | --- |
| claim-files | denied / `[]` | 1,184 | 2,455,307,970 | yes (private) |
| endorsement-packets | denied / `[]` | 125 | 9,217,337 | yes (private) |
| homeowner-uploads | denied / `[]` | 8 | 30,364,235 | yes (private) |
| tenant-documents | denied / `[]` | 8 | 2,800,034 | yes (private) |
| tenant-logos | **5** (GET 200) | 5 | 2,687,016 | yes |
| loss-draft-documents | denied / `[]` | 2 | 77,234 | yes (private) |
| document-templates | denied / `[]` | 1 | 3,124 | yes (private) |
| email-assets | **1** (GET 200) | 1 | 1,015,445 | yes |
| claim-files-backup | empty/denied | 0 | 0 | map only |
| company-branding | empty/denied | 0 | 0 | map only |
| contractor-documents | empty/denied | 0 | 0 | map only |
| deposit-attachments | empty/denied | 0 | 0 | map only |
| ai-knowledge-base | empty/denied | 0 | 0 | inventory only, do not copy |
| database_export_01_09_26 | n/a | not in extract | n/a | **do not copy** |

**Application objects: 1,334. Total dump bytes: 2,501,472,395.**

Live-confirmed today: `tenant-logos` 5, `email-assets` 1. A production Storage **service role** is required to refresh private object counts. Cognito staging passwords do not grant production Supabase Auth (HTTP 401). Secret `checksops/staging/providers` has no `AWSCURRENT` string.

## 2. Bucket map

Destination: private bucket `checksops-staging-privatefilesbucket-erzqsolpucjp`.

S3 key: `files/{supabase_bucket}/{original_object_path}`

Database `file_path` / image path values stay relative to the Supabase bucket. The Storage API translates them. Production source was not deleted or modified.

See `aws/storage/BUCKET_MAP.md`.

## 3. Security model

- All Block Public Access flags remain on. Versioning on. Direct unsigned `GetObject` is 403. A malformed/bogus presign is 400/403, not 200.
- Browser never receives AWS credentials.
- Authenticated reads: Cognito ID token → `identity_accounts.application_user_id` → `request.app_user_id` → RLS-visible row that references the path → short-lived S3 `GetObject` presign.
- Spoofed `x-user-id`, `x-tenant-id`, and body `tenant_id` / `user_id` are ignored. Authorization uses the mapped ChecksOps UUID, not a browser-supplied tenant id.
- Knowing an S3 key is not sufficient.
- Unauthenticated access is only `GET /storage/public` for `tenant-logos` paths referenced by `tenants_public.logo_url`, plus `email-assets/checksops-logo.png`.
- Claim/check/endorsement/homeowner/tenant/payment documents are never public.
- Uploads, deletes, and moves return `uploads_disabled`.

## 4. Copy

COPY only. Hashes recorded in object metadata. Hash conflicts would skip (none occurred).

| | Count | Bytes |
| --- | ---: | ---: |
| Source application objects | 1,334 | 2,501,472,395 |
| Copied | **6** | **3,702,461** |
| Failed `private_requires_service_role` | **1,328** | remaining dump bytes |
| Skipped (export / ai-knowledge-base) | 0 selected | |
| Hash mismatches / conflicts | 0 | |
| Duplicate/conflicting paths | 0 | |
| Unexplained differences | 1,328 private objects missing from S3 (explained: no service role) | |

Copied keys: five tenant logos (Freedom + C1C) and `files/email-assets/checksops-logo.png`. Manifest: `aws/storage/COPY_MANIFEST.json`.

## 5. AWS Storage API

Live Lambda `checksops-staging-api` updated in place (no `sam deploy` of the thin template).

| Route | Auth | Behavior |
| --- | --- | --- |
| `POST /storage/sign` | Cognito | RLS-authorize then presign |
| `POST /storage/sign-many` | Cognito | batch |
| `POST /storage/list` | Cognito | DB-visible paths, not raw S3 prefix list |
| `POST /storage/download` | Cognito | same as sign |
| `GET /storage/public` | none | branding only; 302 to presign |
| other `/storage*` | — | `uploads_disabled` |
| `POST /public/signature-document` | token hash | exact signer document presign |
| `POST /public/endorsement` | token | read-only `get_endorsement_data`; other actions `writes_disabled` |
| `POST /public/signature-submit` | — | `writes_disabled` |

Check-queue has-many embeds: do not inject `check_payee_id` onto `check_intake_items`; join `check_payees` on `check_id` and `checkalt_deposits` on `check_intake_item_id`. Regression: `aws/tests/api-auth-data.test.mjs`. All `aws/tests/*.test.mjs` pass (60).

## 6. Frontend (AWS mode only)

`src/integrations/aws/storage.ts` replaces `storage.from` when `VITE_AUTH_PROVIDER=cognito`. Production client unchanged. No Supabase Storage fallback for migrated protected files in AWS staging.

Sign/Endorse use `src/lib/publicWorkflowApi.ts`: AWS `/public/*` iff Cognito mode; production keeps the same Supabase URL + anon fallback. Production signing links are not redirected.

## 7. Freedom / C1C validation

Identity unchanged: Tester `abd3c2a0-…` / C1C `fd857564-…`. Cognito sub is never the application UUID.

### API

| Probe | Result |
| --- | --- |
| Tester Freedom check queue (with `check_payees` + `checkalt_deposits`) | **200**, 50 rows (limit 50) |
| C1C Freedom tenant filter | **200**, **0** rows |
| Tester Freedom logo sign + GET | 200 |
| C1C Freedom logo sign | **403** `storage_forbidden` |
| C1C own logo | 200 |
| Tester Freedom check image | **404** `object_not_in_s3` (RLS authorized; bytes not copied) |
| C1C same Freedom check image | **403** (including spoofed Tester UUID / Freedom tenant headers) |
| Tester Freedom endorsement packet | **404** `object_not_in_s3` |
| C1C same packet | **403** |
| Unauthenticated `/storage/sign` | **401** |
| Unauthenticated `/storage/public` claim-files | **403** |
| Unauthenticated `/storage/public` Freedom logo | **200** (presign follow) |
| Bogus S3 presign | **400** |
| Fake signature token | **404** `fetch_signer` |
| Fake endorsement token | **404** token consumed/invalid |
| Upload | **403** `uploads_disabled` |

### UI (`npm run preview:aws` on port 4173)

- Tester: Freedom logo on `/freedom/login` and in-app header. `/freedom/checks` Endorsing queue lists 22 checks (Anissa Nassry / State Farm $17,357.80 and further rows). Tiles: Review 26, Endorsing 22, Ready for Deposit 9, Deposited 14, Returned 1, Loss Draft 11.
- C1C: Condition One logo on `/c1c/login`. `/c1c/checks` shows 0 Freedom checks (Endorsing 0; Loss Draft tile 7 is C1C-only). Direct `/freedom/checks` while logged in as C1C: **Access Denied**.
- Claim/check image preview in the detail panel was not completed in the GUI (row click in the grouped Endorsing view did not open the panel during automation). API already proves authorized Tester reads 404 for missing S3 objects and C1C is 403.

## 8. Public token pages

`Sign.tsx` / `Endorse.tsx` hardcoded production Supabase fallback remains for **production mode only**. AWS staging calls `/public/signature-document` and `/public/endorsement`. Submit stays `writes_disabled`. Real signer documents are not in S3, so a valid token would still 404 `object_not_in_s3` until private copy. Production links were not redirected.

## 9. Remaining upload/write dependencies

Uploads/deletes/moves: `uploads_disabled` (18 `storage.from` write sites still in UI). 293 browser DML paths: `writes_disabled`. Moov / CheckAlt / Plaid / Resend: `provider_disabled`. `default_transaction_read_only=on`. Ninth UUID unchanged.

## Blockers

1. **Private object COPY** requires a read-only production Storage service role. Until then 1,328 application objects are missing from staging S3. Do not declare Storage complete.
2. Claim/check/endorsement/homeowner/tenant document display, download, and preview cannot succeed until those bytes are copied.
3. Public signing/endorsement document bytes have the same COPY dependency.

## Completion

Storage phase is **not complete**.

Approximate overall AWS staging migration completion: **about 72%** of the isolated staging path (restore, RLS, Cognito, frontend reads, storage API/security, public branding copy, Freedom check-queue reads) with Storage copy at **6 / 1,334** application objects (**3,702,461 / 2,501,472,395** bytes).
