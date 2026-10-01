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
| Entry | `/assets/index-DyoF7zdg.js` |
| Entry JS SHA256 | `82002b64741255e8fd73e3fea61d8a2abebb255088d4508fa0ce23c425565080` |
| index.html SHA256 | `f114be0b9c9a963b5de63c06753a3887ddabd90b009439244a16245769c19726` |
| index.html S3 version | `SiE1MfXK8lnrffWWNEWs3BkYZRoyXqMt` |
| Last-Modified | `Thu, 01 Oct 2026 14:07:21 GMT` |
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
`index-BAD1KYoF.js`, or earlier conflicting bundle names) over this baseline.

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

- `last-modified: Thu, 01 Oct 2026 14:07:21 GMT`
- `x-amz-version-id: SiE1MfXK8lnrffWWNEWs3BkYZRoyXqMt`
- index.html SHA256 `f114be0b9c9a963b5de63c06753a3887ddabd90b009439244a16245769c19726`
- entry `/assets/index-DyoF7zdg.js`
- entry SHA256 `82002b64741255e8fd73e3fea61d8a2abebb255088d4508fa0ce23c425565080`

Exact match to the accepted baseline. Freeze proceeded.

Lambda identity was requested for continuity only and was not modified.
This task performed **zero** production writes.
