# Production SPA baseline — LOCKED / FROZEN

This file is repository evidence for the already-live production frontend.
It does **not** deploy, upload, invalidate, or modify AWS.

Read-only live verification on 2026-10-03 confirmed that production now
serves the baseline recorded here. Metadata in this change only records and
protects it. Historical `index-HXTuSrE0.js` is superseded lineage only.

## Accepted live production SPA

| Field | Value |
|---|---|
| Host | `https://checksops.com` |
| CloudFront | `E1B0ZWWO5559U5` |
| S3 bucket | `checksops-production-frontend-806168576068` |
| Entry | `/assets/index-BgOCQCWm.js` |
| Entry JS SHA256 | `ae4ea2c96546b590f442fcff73d557e2ceafea25cb3ed2a51642948cbdad4190` |
| index.html SHA256 | `3832fadc3d3fc77c8989a3426ee9e3f4b76a85d0c434f3782ec50cf7e43ba5df` |
| index.html S3 version | `QjOrqc19jhbyw1VYHKdDXoEgI.B5mVYd` |
| Last-Modified | `Sat, 03 Oct 2026 11:41:40 GMT` |
| Previous accepted baseline | `/assets/index-HXTuSrE0.js` |

## Accepted behavior

- PRODUCTION (`checksops.com` / `www.checksops.com`): no yellow Staging banner
- STAGING (`staging.checksops.com`): yellow Staging banner remains visible
- WalletOps: Manage sweeps / Turn off automatic payouts present
- Other current production functionality: preserved

## Provenance

`origin/main` is **not** this baseline. A future deploy from main, another
branch, or another worktree must demonstrate that it contains or reconciles
this accepted production SPA. If it cannot, deployment must be refused.

Do not restore a superseded entry (`index-HXTuSrE0.js`, `index-CTqMys28.js`,
`index-BPbQUNFr.js`, `index-DSbVZXu8.js`, `index-BtDKt23D.js`,
`index-gYa_BW8r.js`, `index-BAD1KYoF.js`, `index-DyoF7zdg.js`, or earlier
conflicting bundle names) over this baseline. `index-HXTuSrE0.js` is
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

HTTPS `GET https://checksops.com/index.html` and matching S3 `get-object`
returned:

- `last-modified: Sat, 03 Oct 2026 11:41:40 GMT`
- `x-amz-version-id: QjOrqc19jhbyw1VYHKdDXoEgI.B5mVYd`
- CloudFront `x-cache: RefreshHit from cloudfront` (apex) / `Hit from cloudfront` (www)
- index.html SHA256 `3832fadc3d3fc77c8989a3426ee9e3f4b76a85d0c434f3782ec50cf7e43ba5df`
- entry `/assets/index-BgOCQCWm.js`
- entry SHA256 `ae4ea2c96546b590f442fcff73d557e2ceafea25cb3ed2a51642948cbdad4190`

S3 and CloudFront matched exactly. Freeze proceeded.

Lambda `checksops-production-prep-api` identity is recorded for continuity only and was not modified.
Live fingerprint during verification:

- CodeSha256 `CWB8lxnHoqANyVcaNpKL7h4MtDSPMlHZ6wliFuGE6yA=`
- RevisionId `16327bba-cc0a-4a17-b2a8-55b7b2d1b069`

This task performed **zero** production writes.
