# Production SPA baseline — LOCKED / FROZEN

This file is repository evidence for the already-live production frontend.
It does **not** deploy, upload, invalidate, or modify AWS.

Read-only live verification on 2026-10-01 confirmed that production now
serves the baseline recorded here. Metadata in this PR only records and
protects it.

## Accepted live production SPA

| Field | Value |
|---|---|
| Host | `https://checksops.com` |
| CloudFront | `E1B0ZWWO5559U5` |
| S3 bucket | `checksops-production-frontend-806168576068` |
| Entry | `/assets/index-CTqMys28.js` |
| Entry JS SHA256 | `ff377c4ab411eb8401595124018d7d54b2b3457a7ea30d82b8f39c54a81711bd` |
| index.html SHA256 | `ed911a7c5cc9ca9544500e4d3760da9a3fcc207ec5f7893d2fac60a06c08af9b` |
| index.html S3 version | `0AuwkrSXSQDHFGUBHFw93_symfzRvIkv` |
| Last-Modified | `Thu, 01 Oct 2026 15:15:51 GMT` |
| Banner overlay commit | `e3e4649478a0c3978065b71b0528dd93baa8dac1` |
| Live source lineage before overlay | `6c679a120d5d4b0dd23d7035ecaf309558df29d0` |

## Accepted behavior

- PRODUCTION (`checksops.com` / `www.checksops.com`): no yellow Staging banner
- STAGING (`staging.checksops.com`): yellow Staging banner remains visible
- Other current production functionality: preserved

## Provenance

`origin/main` is **not** this baseline. A future deploy from main, another
branch, or another worktree must demonstrate that it contains or reconciles
this accepted production SPA. If it cannot, deployment must be refused.

Do not restore a superseded entry (`index-DSbVZXu8.js`, `index-BPbQUNFr.js`,
`index-BAD1KYoF.js`, `index-DyoF7zdg.js`, or earlier conflicting bundle names)
over this baseline.

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

- `last-modified: Thu, 01 Oct 2026 15:15:51 GMT`
- `x-amz-version-id: 0AuwkrSXSQDHFGUBHFw93_symfzRvIkv`
- index.html SHA256 `ed911a7c5cc9ca9544500e4d3760da9a3fcc207ec5f7893d2fac60a06c08af9b`
- entry `/assets/index-CTqMys28.js`
- entry SHA256 `ff377c4ab411eb8401595124018d7d54b2b3457a7ea30d82b8f39c54a81711bd`

Exact match to the accepted baseline. Freeze proceeded.

Lambda identity was requested for continuity only and was not modified.
This task performed **zero** production writes.
