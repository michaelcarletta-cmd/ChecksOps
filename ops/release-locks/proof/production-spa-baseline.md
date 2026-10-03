# Production SPA baseline — LOCKED / FROZEN

This file is repository evidence for the already-live production frontend.
It does **not** deploy, upload, invalidate, or modify AWS.

Live verification on 2026-10-03T11:41:43Z records the accepted Mortgage
Ops overlay plus the expression-safe queue blur hotfix. Branding repair
and Homeowner `/h/ledger` routing were not included.

## Accepted live production SPA

| Field | Value |
|---|---|
| Host | `https://checksops.com` |
| CloudFront | `E1B0ZWWO5559U5` |
| S3 bucket | `checksops-production-frontend-806168576068` |
| Entry | `/assets/index-BgOCQCWm.js` |
| Entry JS SHA256 | `ae4ea2c96546b590f442fcff73d557e2ceafea25cb3ed2a51642948cbdad4190` |
| Queue SHA256 | `da66439ccf2f2f8c70435091a7f6cb8255cfb34351b2db4bac719dddd6a2dfe2` |
| index.html SHA256 | `3832fadc3d3fc77c8989a3426ee9e3f4b76a85d0c434f3782ec50cf7e43ba5df` |
| index.html S3 version | `QjOrqc19jhbyw1VYHKdDXoEgI.B5mVYd` |
| CloudFront invalidation | `I5T9PLB4T87BWXGN0C3I0CV9E8` |
| Last-Modified | `Sat, 03 Oct 2026 11:41:40 GMT` |
| Previous accepted baseline | Mortgage Ops overlay `/assets/index-BgOCQCWm.js` `ae4ea2c9…` / `.Z.2EBH5QBbyDTgcLX9fSOPrcr5u8y5P` / queue `092057a7…` |

## Accepted behavior

- PRODUCTION (`checksops.com` / `www.checksops.com`): no yellow Staging banner
- STAGING (`staging.checksops.com`): yellow Staging banner remains visible
- WalletOps: Manage sweeps / Turn off automatic payouts present
- Mortgage Ops queue overlay is live on the Branding entry filename
- Queue module is parseable (expression-safe blur; no `const` after a comma)
- Complete does not call `bill-mortgage-handling`
- Branding and Claim Ledger production functionality remain the host authority
- Other current production functionality: preserved

## Provenance

`origin/main` is **not** this baseline. A future deploy from main, another
branch, or another worktree must demonstrate that it contains or reconciles
this accepted production SPA. If it cannot, deployment must be refused.

Do not restore a superseded entry (`index-HXTuSrE0.js`, `index-CTqMys28.js`,
`index-BPbQUNFr.js`, `index-DSbVZXu8.js`, `index-BtDKt23D.js`,
`index-gYa_BW8r.js`, `index-BAD1KYoF.js`, `index-DyoF7zdg.js`, or the
pre-overlay Branding bytes of `index-BgOCQCWm.js` at `7d65f3c1…`) over
this baseline unless a separately authorized guarded rollback names that
exact artifact.

## Fail-closed promotion rules

1. Stale / older candidate than this baseline: refuse
2. Production changed after preflight (TOCTOU): refuse
3. Candidate missing this baseline / source lineage: refuse
4. Lock says this SPA, live production is something else: refuse; do not auto-fix
5. Destructive frontend deploy (`s3 sync --delete` or equivalent): refuse

Authorized production SPA writes remain per-object `s3api put-object`
(assets first, `index.html` last). This evidence file does not authorize any
write.

## Live verification (this freeze)

HTTPS `GET https://checksops.com/index.html` after the official
`production-spa-upload` writer (`per_object_put`, assets first,
`index.html` last) returned:

- `last-modified: Sat, 03 Oct 2026 11:41:40 GMT`
- `x-amz-version-id: QjOrqc19jhbyw1VYHKdDXoEgI.B5mVYd`
- index.html SHA256 `3832fadc3d3fc77c8989a3426ee9e3f4b76a85d0c434f3782ec50cf7e43ba5df` (bytes unchanged)
- entry `/assets/index-BgOCQCWm.js`
- entry SHA256 `ae4ea2c96546b590f442fcff73d557e2ceafea25cb3ed2a51642948cbdad4190`
- queue `/assets/MortgageOpsQueue-BD_nUT7A.js`
- queue SHA256 `da66439ccf2f2f8c70435091a7f6cb8255cfb34351b2db4bac719dddd6a2dfe2`

CloudFront invalidation `I5T9PLB4T87BWXGN0C3I0CV9E8` on `E1B0ZWWO5559U5`.
No `sw.js` was uploaded.

Lambda `checksops-production-prep-api` after the guarded overlay (unchanged
by this hotfix):

- CodeSha256 `S2CV0j3zWfYfyfSvmIq0axMhnSib1UntZZVqOvzxBbc=`
- RevisionId `2f112f18-9055-4760-859d-62be8899b91f`
- LastModified `2026-10-03T11:21:01.000+0000`
- LastUpdateStatus `Successful`

This evidence file records those already-applied fingerprints. It does
not authorize a further write.
