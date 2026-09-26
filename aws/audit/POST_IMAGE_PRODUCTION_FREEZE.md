# Post-image production freeze

This record freezes the **current live production state** after the accepted
existing-back-image compatibility overlay.

It is an invariant and provenance source. It is **not** an instruction to roll
production backward.

Future Lambda or SPA deployments must start from **current live production**.
If live has moved, reconcile against that newer package. Do not deploy obsolete
R3, R1, or pre-compat pins.

Machine-readable companion: `aws/audit/post-image-production-freeze.json`.

This workstream did **not** change production Lambda code, Lambda configuration,
SQL, Cognito, IAM, application data, or product behavior. It did **not**
republish the SPA. It did **not** resume R4.

## Authority

| Item | Authority |
| --- | --- |
| Production Lambda package | Fresh GetFunction / downloaded ZIP at freeze time |
| Production SPA graph | Live `index.html` recursive walk (CloudFront + S3 VersionId) |
| Git `main` | Not a deployment baseline |
| Historical R3 / R1 hashes | Provenance only — not rollback targets |

## Current live Lambda pin

Captured `2026-09-26T17:35:25.371Z`. Pins matched the accepted image-compat overlay; no drift to reconcile.

| Field | Value |
| --- | --- |
| Function | `checksops-production-prep-api` |
| Account / region | `806168576068` / `us-east-1` |
| CodeSha256 | `HzqcBPqWAtyIM61iEKHOdpfiO2lEPi8vWilo9xIcb9w=` |
| Package SHA256 | `1f3a9c04fa9602dc8833ad6210a1ce7697e23b69443e2f2f5a2968f7121c6fdc` |
| RevisionId | `31295ac7-f358-49bd-b29f-0e984d20b37f` |
| LastModified | `2026-09-26T14:12:05.000+0000` |
| Runtime | `nodejs22.x` |
| Handler | `index.handler` |
| Role | `arn:aws:iam::806168576068:role/checksops-production-api-execution` |
| Memory / timeout | 1024 MB / 45 s |
| Architecture | `arm64` |
| Env | `production-prep` |
| Files bucket | `checksops-production-privatefiles-806168576068` |
| Cognito | `us-east-1_h00WorYMT` / `3ja9fqaq2fjkv3i6up2varcqpe` |
| Sign base | `https://checksops.com` |

## Accepted image compatibility contract

These files are frozen at the accepted overlay. A later workstream may modify
**one** of them only when that workstream explicitly requires it, and must start
from this frozen version — never a pre-compat copy.

| File | SHA256 |
| --- | --- |
| `src/lib/checkImageInvariants.ts` | `41a42c8df6f61b52b2683a300310c3f0498531ee991c5492347e216dc418d802` |
| `src/pages/CheckCommandCenter.tsx` | `32436906507f3e8f183a0f393dd43ea66bd7eeb4dd2fca33087e737a6b7984d4` |
| `aws/functions/api/storage.mjs` (live `storage.mjs`) | `b6923ff66786f5604bda229c21e9309a3d7e49ba0ee2edaf07106690228eed56` |
| `aws/functions/api/storage-paths.mjs` (live `storage-paths.mjs`) | `278329e5230b2ddd6675e4cad9839d2193da8655ca4676573702dca3f90e9d09` |

Preserved behavior also includes R1 Claim Check, Delete Check, current Mortgage
Ops / billing, production Cognito, same-origin `/prep`, passwordless production
auth, current OCR/intake, endorsement/image, deposit-image clean-original
recovery, deterministic `*_endorsed_*` → clean `.jpg`/`.jpeg`/`.png` recovery,
narrow `/storage/sign` grant for that reconstructed sibling, existing
`.checkalt.jpg` protections, and existing financial/provider safeguards.

## Current live SPA pin

Updated after the accepted R4A tenant-branding production promotion. The
previous post-image SPA (`342c2e15…` / `index-CK2xJ5OO.js`) is provenance only.

| Field | Value |
| --- | --- |
| Index SHA256 | `6b211037ae70b510a9b5cfe316f006dbbc308ee3c94687ccea943b24cfd09f2e` |
| Index VersionId | `advEv5N0JfqM41odUraOM7kCH6Z2snP3` |
| Index LastModified | `2026-09-26T19:26:02Z` |
| Entry | `assets/index-CS_JpvZg.js` |
| Claim Check | `assets/CheckCommandCenter-DHNFge6N.js` |
| Recursive objects | 103 |
| Missing | 0 |
| HTML fallbacks | 0 |
| Overlay | R4A tenant branding |

## Accepted R4A branding contract

Protected SPA behavior. A later overlay must not silently restore:

- page-relative tenant logo URLs
- `CompanyBrandingSettings` on the tenant branding tab
- Sending-domain / `EmailSenderSettings` UI
- Supabase logo resolution

Relative AWS logo paths resolve through `/prep/storage/public?bucket=tenant-logos`.
Valid absolute URLs stay usable. Missing logos use the existing fallback.
R4B (stored `logo_url` migration / storage write-auth) is not implemented.

## Production data-plane contract

Promotions must build with `vite build --mode production` via
`scripts/build-production-aws-spa.mjs`. Never `vite --mode aws`.

| Variable | Required value |
| --- | --- |
| `VITE_AUTH_PROVIDER` | `cognito` |
| `VITE_APP_URL` | `https://checksops.com` |
| `VITE_CHECKSOPS_API_URL` | `/prep` |
| `VITE_COGNITO_USER_POOL_ID` | `us-east-1_h00WorYMT` |
| `VITE_COGNITO_USER_POOL_CLIENT_ID` | `3ja9fqaq2fjkv3i6up2varcqpe` |

Rejected: staging pool `us-east-1_vPmQ7cL1F`, staging client
`71bb7a192cbl6o6s8m259tl589`, staging execute-api `psr19uhop4`.

Upload assets first, `index.html` last. Never `s3 sync --delete`.

## Safeguards

This freeze **extends** the post-R3 / PR #491 overlay and promote guards. It
does not create a competing deployer.

### Lambda overlay (`scripts/production-lambda-overlay-guard.mjs`)

1. Download / start from the current live Lambda package.
2. Verify CodeSha256 + RevisionId immediately before write.
3. Overlay only an explicit allowlist.
4. Reject unexpected package differences.
5. Preserve every non-allowlisted current-live file byte-for-byte.
6. Re-check image-compat markers so an older `storage.mjs` / `storage-paths.mjs` cannot silently land.
7. Verify the resulting live package after deployment.

### SPA promotion (`scripts/production-spa-promote-guard.mjs`)

1. Start from the current accepted source/features.
2. Build with production mode; refuse `vite --mode aws`.
3. Require production Cognito, `VITE_APP_URL=https://checksops.com`, `VITE_CHECKSOPS_API_URL=/prep`.
4. Reject staging Cognito identifiers and the staging execute-api URL.
5. Recursively verify the asset graph.
6. Upload assets first and `index.html` last.
7. Never use `s3 sync --delete`.

## Provenance only (do not deploy)

- R3 Lambda `o/U/pbZ2FR38T3HI6A6kUxp9wik4pci92KmEVfmhF6I=`
- Pre-image-compat Lambda `Z5PR5OcmZSyiSPQxn6yYbuCd3jZK5F/NDrQnyF9A3U8=`
- R1 SPA index `ffa6c835…` / `index-DcU_cK7_.js`
- R3 SPA index `0fb105c58a5afeb8dd6fe4a497db1df012a0473f85da02484d9a7a4417ff4f87`
- Pre-compat `storage.mjs` `c3ddf79b…` / `storage-paths.mjs` `74638148…`

See `aws/audit/POST_R3_PRODUCTION_FREEZE.md` for the superseded R3 record.

## Out of scope

Do not start R4 from this freeze. No branding, sending-domain, tenant-logo,
SQL, Lambda deploy, SPA deploy, or Cognito/IAM/Moov changes.
