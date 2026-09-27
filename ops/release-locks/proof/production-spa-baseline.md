# Production SPA baseline — LOCKED / FROZEN

This file is repository evidence for the already-live production frontend.
It does **not** deploy, upload, invalidate, or modify AWS.

Read-only live verification on 2026-09-27 confirmed that production still
serves this baseline. Metadata in this PR only records and protects it.

## Accepted live production SPA

| Field | Value |
|---|---|
| Host | `https://checksops.com` |
| CloudFront | `E1B0ZWWO5559U5` |
| S3 bucket | `checksops-production-frontend-806168576068` |
| Entry | `/assets/index-BPbQUNFr.js` |
| Entry JS SHA256 | `78b393152e17e1eb223deced357f2276e7a5f00e214d2652d115347b2d2ed9d5` |
| index.html SHA256 | `244c4bd12bddc72e064723d87b6dbd6004a2d859b27200b0ca6747f189c73394` |
| index.html S3 version | `L.ND9yiehnJfDCocKdyFC_mRQZjchON3` |
| Last-Modified | `Sun, 27 Sep 2026 01:34:04 GMT` |
| Banner overlay commit | `6c679a120d5d4b0dd23d7035ecaf309558df29d0` |
| Live source lineage before overlay | `1c2ec1ad7d3331f11f8cde61fdbc5cd363eb6720` |

## Accepted behavior

- PRODUCTION (`checksops.com` / `www.checksops.com`): no yellow Staging banner
- STAGING (`staging.checksops.com`): yellow Staging banner remains visible
- Other current production functionality: preserved

## Provenance

`origin/main` is **not** this baseline. A future deploy from main, another
branch, or another worktree must demonstrate that it contains or reconciles
this accepted production SPA. If it cannot, deployment must be refused.

Do not restore a superseded entry (`index-BAD1KYoF.js` or earlier conflicting
bundle names) over this baseline.

## Fail-closed promotion rules

1. Stale / older candidate than this baseline: refuse
2. Production changed after preflight (TOCTOU): refuse
3. Candidate missing this baseline / source lineage: refuse
4. Lock says this SPA, live production is something else: refuse; do not auto-fix
5. Destructive frontend deploy (`s3 sync --delete` or equivalent): refuse

Authorized production SPA writes remain per-object `s3api put-object`
(assets first, `index.html` last). This evidence file does not authorize any
write.

## Read-only verification (this freeze)

HTTPS `GET https://checksops.com/` returned:

- `last-modified: Sun, 27 Sep 2026 01:34:04 GMT`
- `x-amz-version-id: L.ND9yiehnJfDCocKdyFC_mRQZjchON3`
- index.html SHA256 `244c4bd12bddc72e064723d87b6dbd6004a2d859b27200b0ca6747f189c73394`
- entry `/assets/index-BPbQUNFr.js`
- entry SHA256 `78b393152e17e1eb223deced357f2276e7a5f00e214d2652d115347b2d2ed9d5`

Exact match to the accepted baseline. Freeze proceeded.

Lambda identity was requested for continuity only and was not modified.
This task performed **zero** production writes.
