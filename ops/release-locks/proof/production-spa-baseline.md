# Production SPA baseline — LOCKED / FROZEN

This file is repository evidence for the already-live production frontend.
It does **not** deploy, upload, invalidate, or modify AWS.

Read-only live verification on 2026-09-30 confirmed that production now
serves the baseline recorded here. Metadata in this PR only records and
protects it.

## Accepted live production SPA

| Field | Value |
|---|---|
| Host | `https://checksops.com` |
| CloudFront | `E1B0ZWWO5559U5` |
| S3 bucket | `checksops-production-frontend-806168576068` |
| Entry | `/assets/index-DSbVZXu8.js` |
| Entry JS SHA256 | `8da351ee4060d065e626b382fec06acf9a7099317184980979b95468e7e4bbe5` |
| index.html SHA256 | `e93fe5488c013aed91626da1ee608978f702796a24e08350306ccb4c3163e75f` |
| index.html S3 version | `Jc2Nyp5THf1j30gf21cQHeMoApSs8uDw` |
| Last-Modified | `Wed, 30 Sep 2026 21:20:11 GMT` |
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

Do not restore a superseded entry (`index-BPbQUNFr.js`, `index-BAD1KYoF.js`,
or earlier conflicting bundle names) over this baseline.

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

- `last-modified: Wed, 30 Sep 2026 21:20:11 GMT`
- `x-amz-version-id: Jc2Nyp5THf1j30gf21cQHeMoApSs8uDw`
- index.html SHA256 `e93fe5488c013aed91626da1ee608978f702796a24e08350306ccb4c3163e75f`
- entry `/assets/index-DSbVZXu8.js`
- entry SHA256 `8da351ee4060d065e626b382fec06acf9a7099317184980979b95468e7e4bbe5`

Exact match to the accepted baseline. Freeze proceeded.

Lambda identity was requested for continuity only and was not modified.
This task performed **zero** production writes.
