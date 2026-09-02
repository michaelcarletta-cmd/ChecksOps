# AWS staging S3 Storage phase results

Date: 2026-09-02. Production Lovable/Supabase Storage objects were not modified or deleted. `default_transaction_read_only=on` unchanged. 293 DML paths remain `writes_disabled`. Uploads/deletes/moves remain `uploads_disabled`. Moov / CheckAlt / Plaid were not called. Production frontend, DNS, auth, and webhooks were not changed.

This phase **STOPS** after private Storage COPY, reconciliation, and staging file-access validation. The Lovable `aws-staging-storage-bridge` and `AWS_MIGRATION_TOKEN_SHA256` are **still in place** for operator verification before teardown.

Storage COPY + reconcile: **complete**. Staging file access: API **complete**; UI walkthrough recorded after the AWS-mode check-image fallback.

## 1. Source inventory (authoritative)

Dump `storage.objects` from `checksops_260901`:

| Bucket | Objects | Bytes | Migrate |
| --- | ---: | ---: | --- |
| claim-files | 1,184 | 2,455,307,970 | yes (private) |
| endorsement-packets | 125 | 9,217,337 | yes (private) |
| homeowner-uploads | 8 | 30,364,235 | yes (private) |
| tenant-documents | 8 | 2,800,034 | yes (private) |
| tenant-logos | 5 | 2,687,016 | yes (already in S3) |
| loss-draft-documents | 2 | 77,234 | yes (private) |
| document-templates | 1 | 3,124 | yes (private) |
| email-assets | 1 | 1,015,445 | yes (already in S3) |
| empty mapped buckets | 0 | 0 | map only |
| ai-knowledge-base / `database_export*` | — | — | **do not copy** |

**Application objects: 1,334. Total dump bytes: 2,501,472,395.**

## 2. Destination

Private bucket `checksops-staging-privatefilesbucket-erzqsolpucjp`. Key: `files/{supabase_bucket}/{original_path}`. Block Public Access remains on. Direct unsigned `GetObject` is 403.

## 3. COPY

Worker: `aws/storage/bridge-copy.mjs` using the live Lovable bridge (`action=sign`, 20 paths/batch, 120s TTL). Token compared by pinned SHA-256 only; plaintext never logged.

| | Count | Bytes |
| --- | ---: | ---: |
| Source application objects | 1,334 | 2,501,472,395 |
| Public objects already in S3 before private COPY | 6 | 3,702,461 |
| Private remaining before COPY | 1,328 | 2,497,769,934 |
| Pass 1 copied | 1,312 | 2,472,086,050 |
| Pass 1 failed | 16 | 25,683,884 |
| Pass 1 hash conflicts | 0 | |
| Sign retries | 0 | |
| Download retries (pass 1, in-worker) | not separately counted beyond 4 attempts/object | |
| Retry copied (all 16 recovered) | 16 | 25,683,884 |
| Retry failed | 0 | |
| Retry conflicts | 0 | |
| Combined private copied | 1,328 | 2,497,769,934 |
| Final S3 `files/` | **1,334** | **2,501,472,395** |

Pass 1 `copy_exception` (16): AWS CLI `--body` rejected when (a) concurrent identical-hash objects shared one temp path and one unlinked the other, or (b) a zero-byte source object. Worker fix: unique temp names + omit `--body` for empty objects. Retry inventory was the 16 failed keys only.

Two source objects are legitimately 0 bytes (copied; SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`):

- `files/claim-files/checks/7dbb3009-…/unclaimed/1784235588930_front_…_cropped.jpg`
- `files/claim-files/checks/7dbb3009-…/unclaimed/1784235588930_back_…_cropped.jpg`

## 4. Reconciliation

Against dump inventory:

| Check | Result |
| --- | --- |
| Missing S3 keys | **0** |
| Extra S3 keys under `files/` | **0** |
| ContentLength vs dump size | **0 mismatches** |
| Hash conflicts during COPY | **0** |
| Sample GetObject SHA-256 vs metadata (6 keys incl. empty + packet + logo) | **6/6 match** |
| Unexplained missing / hash / conflicting paths | **0 / 0 / 0** |

Manifests: `aws/storage/BRIDGE_COPY_SUMMARY.json`, `aws/storage/BRIDGE_COPY_MANIFEST.json`, `aws/storage/RECONCILE.json`. No signed URLs or plaintext tokens.

## 5. Freedom / C1C file access (API)

API: `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging`. Identity unchanged: Tester `abd3c2a0-…` / C1C `fd857564-…`. Cognito sub is never the application UUID. Spoofed `x-user-id` / `x-tenant-id` / body ids are ignored.

| Probe | Result |
| --- | --- |
| Tester Freedom check image sign + GET | **200** / **200**, 284,394 bytes match dump |
| Tester Freedom endorsement packet sign + GET | **200** / **200**, 60,283 bytes match dump |
| Tester `/storage/download` same check image | **200** + GET **200**, 284,394 bytes |
| C1C same Freedom check image (spoofed Tester UUID + Freedom tenant) | **403** `storage_forbidden`; identity stayed C1C |
| C1C same Freedom packet (same spoof) | **403** `storage_forbidden` |
| Unauthenticated `/storage/sign` | **401** `missing_cognito_token` |
| Unauthenticated `/storage/public` claim-files | **403** `storage_forbidden` |
| Unauthenticated `/storage/public` Freedom logo | **302** presign |
| Direct S3 GetObject | **403** |
| Upload / delete | **403** `uploads_disabled` |
| PATCH `/data/check_intake_items` and insert via `/data/query` | **403** `writes_disabled` |

Evidence: `aws/storage/API_FILE_ACCESS.json`.

Freedom paths used:

- `claim-files` `checks/7dbb3009-f059-4767-b5dc-1c5c72379330/unclaimed/1787321060661_front_IMG_1157_cropped.jpg`
- `endorsement-packets` `packets/1db86248-ddae-46dd-a2fc-5694680834e3/endorsement-packet-9020169620-1787167940223.svg`

## 6. AWS-mode UI preview path

`ViewCheckImageButton` previously always called `get-check-image-urls` when `checkId` was set. AWS staging returns `provider_disabled` for Edge Functions, so the button could not preview even after S3 COPY. Staging-only: skip that invoke when `VITE_AUTH_PROVIDER=cognito` and sign `front_image_path` / `back_image_path` through the Storage API. Production still uses the Edge Function. Packet preview already used `storage.createSignedUrl`.

## 7. What was not done

- Lovable bridge and migration token **not** removed (operator asked to verify reconcile first).
- Production frontend / DNS / auth / webhooks unchanged.
- Uploads, deletes, moves, DML, and payment providers remain disabled.
- Ninth UUID still fail-closed.

## Completion

Private Storage COPY and byte/key reconciliation are **complete** (1,334 / 1,334 objects, 2,501,472,395 / 2,501,472,395 bytes). API file access for Freedom preview/download and C1C isolation is **complete**. Storage can be declared **copy-complete** after the operator confirms this reconcile; do not tear down the bridge until then.
