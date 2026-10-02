# Production SPA baseline — LOCKED / FROZEN

This file is repository evidence for the already-live production frontend.
It does **not** deploy, upload, invalidate, or modify AWS.

Read-only live verification on 2026-10-02 confirmed that production now
serves the baseline recorded here. Metadata in this change only records and
protects it.

## Accepted live production SPA

| Field | Value |
|---|---|
| Host | `https://checksops.com` |
| CloudFront | `E1B0ZWWO5559U5` |
| S3 bucket | `checksops-production-frontend-806168576068` |
| Entry | `/assets/index-HXTuSrE0.js` |
| Entry JS SHA256 | `d584fe66e677db7ff0b532fc2a296a578a40f6b4f7b5f7a58f5c8e839d90041d` |
| index.html SHA256 | `a33569d86c2483eecdb8550a47013ccb087011d201f718765a567647958d2b52` |
| index.html S3 version | `PzXfOI.HeUgvUqw6Q2L_PzPMmL1EbEXX` |
| Last-Modified | `Fri, 02 Oct 2026 15:03:04 GMT` |
| Previous accepted baseline | `/assets/index-gYa_BW8r.js` |

## Accepted behavior

- PRODUCTION (`checksops.com` / `www.checksops.com`): no yellow Staging banner
- STAGING (`staging.checksops.com`): yellow Staging banner remains visible
- WalletOps: Manage sweeps / Turn off automatic payouts present
- Other current production functionality: preserved

## Provenance

`origin/main` is **not** this baseline. A future deploy from main, another
branch, or another worktree must demonstrate that it contains or reconciles
this accepted production SPA. If it cannot, deployment must be refused.

Do not restore a superseded entry (`index-CTqMys28.js`, `index-BPbQUNFr.js`,
`index-DSbVZXu8.js`, `index-BtDKt23D.js`, `index-gYa_BW8r.js`, `index-BAD1KYoF.js`,
`index-DyoF7zdg.js`, or earlier conflicting bundle names) over this baseline.
`index-gYa_BW8r.js` is superseded lineage only after this successful acceptance.

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

- `last-modified: Fri, 02 Oct 2026 15:03:04 GMT`
- `x-amz-version-id: PzXfOI.HeUgvUqw6Q2L_PzPMmL1EbEXX`
- `x-cache: RefreshHit from cloudfront`
- index.html SHA256 `a33569d86c2483eecdb8550a47013ccb087011d201f718765a567647958d2b52`
- entry `/assets/index-HXTuSrE0.js`
- entry SHA256 `d584fe66e677db7ff0b532fc2a296a578a40f6b4f7b5f7a58f5c8e839d90041d`

Exact match to the accepted baseline. Freeze proceeded.

Lambda `checksops-production-prep-api` identity is recorded for continuity only and was not modified.
Live fingerprint during verification:

- CodeSha256 `S8ma0PVG3pzjuJSD17eznstHuB+AgD7M3/35OcKSoPY=`
- RevisionId `9f673420-a5a1-43df-a798-cc7022a4fb8d`

This task performed **zero** production writes.
