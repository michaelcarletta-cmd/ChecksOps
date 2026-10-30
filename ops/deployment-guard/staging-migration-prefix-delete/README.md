# Staging files bucket: delete the production data copies under Migration/ (finding 5)

Security audit 2026-10-29, finding 5: production data sits in the staging files bucket. Owner
decision of 2026-10-30, verbatim: "Finding 5 - delete it".

| File | What it is |
|---|---|
| `staging-migration-prefix.live-2026-10-30.json` | `ListObjectVersions` of `Migration/` in `checksops-staging-privatefilesbucket-erzqsolpucjp`, read 2026-10-30: every version (Key, VersionId, size, ETag, date) |
| `scripts/deployment-guard/lib/s3-prefix-version-delete.mjs` | builds the `DeleteObjects` requests from the snapshot and compares a live listing with it |

Test: `aws/tests/staging-migration-prefix-delete.test.mjs`.

## Why

`Migration/` holds the 2026-09-01 dump of the production database (`checksops_260901(1).backup`,
49 MB) and the table exports of the 2026-09-05 migration rehearsal (`rehearsal-20260905/…`,
167 objects, 39 MB). Staging roles can read the bucket (the staging API function role, the
rehearsal one-shot), so whoever gets into staging gets a copy of production data. The migration
finished in September; production runs on its own database, backups and bucket.

## Read-only inspect (2026-10-30, `user/claude-code`)

- Versioning `Enabled`; no replication; lifecycle rules only for incomplete multipart uploads and
  the compliance upload staging prefix `files/verification-docs/uploads/` (1 day), none for
  `Migration/`.
- 657 versions under `Migration/` (169 current, 488 noncurrent, 204,732,360 bytes in all), no
  delete markers, last written 2026-09-06. The other staging buckets have no `Migration/` objects.
- Code that names these keys is the finished September migration tooling only
  (`aws/db-copy/`, `aws/write-path/scripts/run-parity-schema-rehearsal.mjs`); the application never
  reads `Migration/`.
- Not in scope: the production bucket `checksops-production-privatefiles-806168576068` has 14
  objects under its own `Migration/`; that is production data in production and stays.

## What changes

- Every version of every object under `Migration/` in the staging files bucket is deleted
  (deleting by VersionId removes the data; a plain delete would only add delete markers).
- Nothing else in the bucket changes: the compliance uploads and every other file under `files/`
  stay. The application, staging and production: nothing.
- The September rehearsal scripts can no longer be re-run against these files (they are done).

## Apply (only on the owner's approval of this run)

1. `ListObjectVersions` of `Migration/`; stop if `diffListing(snapshot, live)` is not `equal`.
2. `buildDeleteRequests(snapshot)`; send each request with `DeleteObjects`; stop on any `Errors`.

## Verify after apply

1. `ListObjectVersions` of `Migration/` returns no versions and no delete markers.
2. A `files/` object count read before the apply is unchanged after it.

## Rollback

There is no rollback: deleted versions cannot be restored. The production database, its backups
and the production bucket are the source of truth.

## Applied (2026-10-30)

Owner approval, verbatim: "delete finding 5". Source: `origin/main` `a2f0995` (PR #1425); snapshot
`staging-migration-prefix.live-2026-10-30.json` sha256
`d39f7425d23ebb0cfee902c90459f62f00019bd4e07c5e9fe9e9bcbfcd716829`. Identity:
`arn:aws:iam::806168576068:user/claude-code`.

1. `ListObjectVersions` of `Migration/` just before: 657 versions, 0 delete markers;
   `diffListing(snapshot, live)` equal (0 missing, 0 extra, 0 changed). `files/`: 1573 objects.
2. `buildDeleteRequests(snapshot)`: one request, 657 objects. `DeleteObjects` HTTP 200, request
   `0P525DJ0GK8C56QC`: 657 deleted, `Errors` [].
3. Verify: `ListObjectVersions` of `Migration/` returns 0 versions and 0 delete markers; `files/`
   still 1573 objects.

Not verified: no CloudTrail data event read for the request (data events may not be logged for
this bucket).
