# Production SPA baseline — LOCKED / FROZEN

This file is repository evidence for the already-live production frontend.
It does **not** deploy, upload, invalidate, or modify AWS.

Read-only live verification on 2026-10-02 confirmed that production now
serves the baseline recorded here after the official guarded apply.

## Accepted live production SPA

| Field | Value |
|---|---|
| Host | `https://checksops.com` |
| CloudFront | `E1B0ZWWO5559U5` |
| S3 bucket | `checksops-production-frontend-806168576068` |
| Entry | `/assets/index-gYa_BW8r.js` |
| Entry JS SHA256 | `71dcf3eb5f95eafcbc19e47897b0d106c1194044d4ef9c40f8f831fdfbecd280` |
| index.html SHA256 | `791bae2c9157442e0c7ea9f412db54bae482f57f476703c6434df57275f06805` |
| index.html S3 version | `TYCJ6QSvW7E1bkW1sRdPbvpwJlWeCTsJ` |
| Last-Modified | `Fri, 02 Oct 2026 01:51:18 GMT` |
| Accepted application source | `b39738cab7c1afd68e97c88781766b6cabe04896` |
| Previous accepted baseline | `/assets/index-CTqMys28.js` |

## Accepted behavior

- PRODUCTION (`checksops.com` / `www.checksops.com`): no yellow Staging banner
- STAGING (`staging.checksops.com`): yellow Staging banner remains visible
- WalletOps: Manage sweeps / Turn off automatic payouts present
- Other current production functionality: preserved

## Provenance

Official guarded apply via `scripts/deployment-guard/production-spa-apply.mjs`
after Lambda overlay of the same accepted source. Invalidation
`I2702DHJBLILBWQYTJNBG085KU`. Role `ChecksOpsProductionSpaDeploy`.
Deploy mode `per_object_put`. No `s3 sync --delete`.

`origin/main` is **not** this baseline. A future deploy from main, another
branch, or another worktree must demonstrate that it contains or reconciles
this accepted production SPA. If it cannot, deployment must be refused.

Do not restore a superseded entry (`index-CTqMys28.js`, `index-BPbQUNFr.js`,
`index-DSbVZXu8.js`, `index-BAD1KYoF.js`, `index-DyoF7zdg.js`, or earlier
conflicting bundle names) over this baseline. `index-CTqMys28.js` is
superseded lineage only after this successful acceptance.

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

- `last-modified: Fri, 02 Oct 2026 01:51:18 GMT`
- `x-amz-version-id: TYCJ6QSvW7E1bkW1sRdPbvpwJlWeCTsJ`
- index.html SHA256 `791bae2c9157442e0c7ea9f412db54bae482f57f476703c6434df57275f06805`
- entry `/assets/index-gYa_BW8r.js`
- entry SHA256 `71dcf3eb5f95eafcbc19e47897b0d106c1194044d4ef9c40f8f831fdfbecd280`
- `x-cache: Miss from cloudfront`

Exact match to the accepted baseline. Freeze proceeded.

Lambda `checksops-production-prep-api` CodeSha256 after the same authorized
apply is `M5wMzEWDxjNGQ0mfxTkseEPXUfDNVQ9VURKnb7cwqGw=` (RevisionId
`91753f93-71ab-4126-a3f8-6a5cfa08b291`). Environment variables were unchanged.
