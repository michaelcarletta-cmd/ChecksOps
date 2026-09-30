# Production SPA baseline — LOCKED / FROZEN

This file is repository evidence for the already-live production frontend.
It does **not** deploy, upload, invalidate, or modify AWS.

Read-only live verification on 2026-09-30 confirmed that production serves
`/assets/index-C_fh5VBD.js`. Older pins (`index-BPbQUNFr.js`,
`index-C9QrEEkl.js`, and earlier) are historical evidence only. They are
**not** restoration targets.

## Accepted live production SPA

| Field | Value |
|---|---|
| Host | `https://checksops.com` |
| CloudFront | `E1B0ZWWO5559U5` |
| S3 bucket | `checksops-production-frontend-806168576068` |
| Entry | `/assets/index-C_fh5VBD.js` |
| Entry JS SHA256 | `a357373bef9e41b004f887ee312ca239f64236706c826afb69400312e6fbad22` |
| index.html SHA256 | `d0d59415d6692713f73b8edabefec10a261f1b7a85d6f4a6abd719f9011b3eb4` |
| index.html S3 version | `VrLJwkt.ge_P4S2pjYAX5YX_uAoP8A6F` |
| Last-Modified | `Wed, 30 Sep 2026 18:06:18 GMT` |
| Source lineage | `338ede0e6313bfcf88feac36101d67a20c756fd9` (WalletOps Item #4 on isolated `8e8fde63` base) |
| Apply evidence | `261ceae7a56162648eba9310ebdda23b124d3e4c` / workstream `walletops-funding-prod-2d41` |
| Banner overlay commit | `6c679a120d5d4b0dd23d7035ecaf309558df29d0` |

## Accepted behavior

- PRODUCTION (`checksops.com` / `www.checksops.com`): staging banner hidden via production-host CSS
- STAGING (`staging.checksops.com`): yellow Staging banner remains visible
- WalletOps Item #4: Payment Account and Payout Preferences sections hidden
- Other current production functionality: preserved

## Provenance

`origin/main` is **not** this baseline. A future deploy from main, another
branch, or another worktree must demonstrate that it contains or reconciles
this accepted production SPA. If it cannot, deployment must be refused.

Do not restore a superseded entry (`index-BPbQUNFr.js`, `index-C9QrEEkl.js`,
`index-BAD1KYoF.js`, or earlier) over this baseline.

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

- `last-modified: Wed, 30 Sep 2026 18:06:18 GMT`
- `x-amz-version-id: VrLJwkt.ge_P4S2pjYAX5YX_uAoP8A6F`
- index.html SHA256 `d0d59415d6692713f73b8edabefec10a261f1b7a85d6f4a6abd719f9011b3eb4`
- entry `/assets/index-C_fh5VBD.js`
- entry SHA256 `a357373bef9e41b004f887ee312ca239f64236706c826afb69400312e6fbad22`

Exact match to the accepted live identity. This lock update records that
identity. It does not deploy or restore.

## Historical pins (do not restore)

| Entry | index.html SHA256 | S3 version | Recorded |
|---|---|---|---|
| `/assets/index-BPbQUNFr.js` | `244c4bd12bddc72e064723d87b6dbd6004a2d859b27200b0ca6747f189c73394` | `L.ND9yiehnJfDCocKdyFC_mRQZjchON3` | 2026-09-27 |
| `/assets/index-C9QrEEkl.js` | `67466d1e1fde618baa3e12aa6b3f3d2651390eee19c7e05004ffc05629a363d2` | `3_E4k2CTf2gxupKhLAu8H2KrJ_lmwSjh` | 2026-09-30 16:53Z |

Lambda identity was requested for continuity only and was not modified.
This task performed **zero** production writes.
