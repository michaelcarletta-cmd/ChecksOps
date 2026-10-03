# Production SPA baseline — LOCKED / FROZEN

This file is repository evidence for the already-live production frontend.
It does **not** deploy, upload, invalidate, or modify AWS.

Read-only live verification on 2026-10-03 confirmed that production now
serves the Branding baseline recorded here. Metadata in this change only
records and protects it. It does not promote Mortgage Ops.

## Accepted live production SPA

| Field | Value |
|---|---|
| Host | `https://checksops.com` |
| CloudFront | `E1B0ZWWO5559U5` |
| S3 bucket | `checksops-production-frontend-806168576068` |
| Entry | `/assets/index-BgOCQCWm.js` |
| Entry JS SHA256 | `7d65f3c16d638fb5b01b9333338040e0a082ab75c62d65f5bb21a891711f11bf` |
| index.html SHA256 | `3832fadc3d3fc77c8989a3426ee9e3f4b76a85d0c434f3782ec50cf7e43ba5df` |
| index.html S3 version | `w6KPzOeYx631RcnJr9la9tTZ2_J3mSSd` |
| Last-Modified | `Fri, 02 Oct 2026 21:26:09 GMT` |
| Previous accepted baseline | `/assets/index-HXTuSrE0.js` |

## Accepted behavior

- PRODUCTION (`checksops.com` / `www.checksops.com`): no yellow Staging banner
- STAGING (`staging.checksops.com`): yellow Staging banner remains visible
- WalletOps: Manage sweeps / Turn off automatic payouts present
- Branding production identity is the SPA authority, not the staging Mortgage Ops SPA
- Other current production functionality: preserved

## Provenance

`origin/main` is **not** this baseline. A future deploy from main, another
branch, or another worktree must demonstrate that it contains or reconciles
this accepted production SPA. If it cannot, deployment must be refused.

Do not restore a superseded entry (`index-HXTuSrE0.js`, `index-CTqMys28.js`,
`index-BPbQUNFr.js`, `index-DSbVZXu8.js`, `index-BtDKt23D.js`,
`index-gYa_BW8r.js`, `index-BAD1KYoF.js`, `index-DyoF7zdg.js`, or earlier
conflicting bundle names) over this baseline. `index-HXTuSrE0.js` is
superseded lineage only after this successful Branding acceptance.

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

HTTPS `GET https://checksops.com/index.html` returned:

- `last-modified: Fri, 02 Oct 2026 21:26:09 GMT`
- `x-amz-version-id: w6KPzOeYx631RcnJr9la9tTZ2_J3mSSd`
- `x-cache: RefreshHit from cloudfront`
- index.html SHA256 `3832fadc3d3fc77c8989a3426ee9e3f4b76a85d0c434f3782ec50cf7e43ba5df`
- entry `/assets/index-BgOCQCWm.js`
- entry SHA256 `7d65f3c16d638fb5b01b9333338040e0a082ab75c62d65f5bb21a891711f11bf`

S3 `head-object` on `index.html` matched the same ETag
`b70636253b28bbeb25af61c9e105ebf2`, VersionId, and LastModified.
No `sw.js` is present on the production bucket.

Lambda `checksops-production-prep-api` identity is recorded for continuity
only and was not modified. Live fingerprint during verification:

- CodeSha256 `nc1J1gjRR4GZinIJh/rNMpi/PXd3ZwqgoUSc9NRlwVg=`
- RevisionId `c8483271-f94e-4c76-aec4-05ac8707cc8a`
- LastModified `2026-10-02T20:26:42.000+0000`

This task performed **zero** production writes.
