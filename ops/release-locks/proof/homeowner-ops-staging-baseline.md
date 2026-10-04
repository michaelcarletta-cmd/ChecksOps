# Homeowner Ops accepted staging baseline (SQL73 composition)

Recorded 2026-10-04. Evidence only. This file does not deploy, apply SQL,
rotate tokens, or change production.

Manual UAT confirmed that an existing Homeowner Ops link which previously
failed now loads the Homeowner portal after SQL73. This proof pins that
working staging composition so later Homeowner signature work is a forward
change from this baseline, never a replacement with an older Homeowner build.

## Classification

- Component: `homeowner-ops-staging`
- Classification: `STAGING_LOCKED_NOT_PRODUCTION`
- Environment: staging only
- Production changed: no
- SQL73 rewritten: no
- Application functionality changed by this lock: no

## Accepted live staging fingerprints (fresh-read 2026-10-04)

Read-only AWS + HTTPS collection. No lease, overlay, SPA promote, or SQL apply
was performed while recording this baseline. Live fingerprints matched the
SQL73 apply acceptance composition exactly. No drift. No overwrite.

| Member | Identity |
| --- | --- |
| Staging SPA host | `https://staging.checksops.com/index.html` |
| `index.html` sha256 | `2186175d03b33bf9faae9b142b9f8e386b467027407623a773bd0fb0d1b6785b` |
| SPA entry | `/assets/index-BomgsBaq.js` |
| SPA entry sha256 | `c8ae5fa760744129d13594c387c3ae17227f1caa4255e9cfe1acf65e8827af1a` |
| Homeowner chunk | `/assets/HomeownerLedger-cDMDKYsn.js` |
| Homeowner chunk sha256 | `8e806b890866834fb60a0fb7369ebdda5b2eb57db8b7dca87bbf938787fccc4b` |
| Live SPA routes | `/h/ledger/:token` and `/ledger/:token` both registered |
| `checksops-staging-api` CodeSha256 | `wzp8UfI+GhlpIbChnOOFODUGCQtnsV//bRdh8ZSS2YA=` |
| `checksops-staging-api` RevisionId | `1c671313-ece2-4723-8975-b314317c22a7` |
| Live `homeowner.mjs` sha256 | `fa995062af8b98b2da298e2636606e9bb9726b3c25d6df3c800252dd59362dfd` |
| SQL executor CodeSha256 | `SYnnbN5P9+3lJJeTRdMU9F1K/Lb8NPAYsEcAH5JpM8s=` |
| SQL executor RevisionId | `1ee7c80f-00c8-44fc-95f3-0c929ea03e05` |
| Executor ZIP sha256 | `4989e76cde4ff7ede524979345d314f45d4afcb6fc34f018b047001f926933cb` |
| Embedded SQL73 source sha256 | `02a19f8ef11cb3e60122b1ff1e07dd331f95a677d13028564d497ef06e523c9e` |
| Live function | `public.aws_public_homeowner_ledger_by_token(text)` |
| Live function sha256 (SQL73 apply) | `42c83390575d90d39326aee61ccaf87851fd5320e278d6c7f687137245b62166` |
| SQL73 source commit | `e61d8d0f9c1e531e1969e31a6f694567d0956505` |
| Accepted composition commit | `a451da1df046b30a8df1b987f3549394cd918195` |

## Preserved unrelated fingerprints

| Member | Identity |
| --- | --- |
| Embedded SQL72 | `8ecb14d3f24e223ae6c9a7e17da6cab30d6425147040a5625302b58f3d6c2e9f` |
| Embedded SQL71 | `21d0968676097bb771e0271a6793e9ad0d48d4be02c70e85d728eb0f0b657ab5` |
| Embedded SQL44 | `059f10e936f27439b9fddae7030b76fe594d6538087de389ab07950fefdf8763` |
| Live SQL44 | `96d038c97a85bc3e49346442862c044e1e16ec1eb062519b4ad277bd998063a5` |
| Live SQL43 | `31a3d2fb20033987a3bdde93f102573c36acc99ae3969e84ad4dc50c916f4806` |
| Membership | `0cd4a7b515656be4777a1f467aa7ca3e0160060031fca66b207cc9fb0854b48e` |
| SQL39 | `4adc182c4ed13b11b37e8412056781112ea8f2a788bc1b51e21810460d13239b` |
| Production API CodeSha256 | `CWB8lxnHoqANyVcaNpKL7h4MtDSPMlHZ6wliFuGE6yA=` |
| Production API RevisionId | `16327bba-cc0a-4a17-b2a8-55b7b2d1b069` |
| Production SPA lock | `/assets/index-HXTuSrE0.js` (unchanged) |

## SQL73 apply evidence (already applied; do not reapply)

- Official path: `scripts/deployment-guard/sql-executor-invoke.mjs`
- One-use id: `sql73-apply-20261004-0133` (replay `SQL_COLLISION`)
- Apply acceptance: `/opt/cursor/artifacts/sql73_apply_acceptance.json`
- `claim_ok` preserved exactly from SQL72
- `pending_signatures` remains `[]` because `handleHomeownerLedgerSignLink` is not token/claim scoped
- Grants unchanged: REVOKE PUBLIC/authenticated, GRANT checksops
- Public token RPC was not invoked by apply or by this baseline lock

## Portal acceptance

- Existing valid Homeowner Ops link for claim `695064-GQ` loads after SQL73
- Isolated PG fixture of that claim shape returns `mode=claim` under SQL73
- Live SPA serves `/h/ledger/:token` (AWS send URL) and legacy `/ledger/:token`
- Source `src/App.tsx` on this pin still lists only `/ledger/:token`; the accepted live SPA already registers both. Future Homeowner work must preserve both live routes and must not restore an older Homeowner chunk.

## Forward-change rule

Homeowner check signing must start from this composition. Do not overlay an
older `homeowner.mjs`, Homeowner chunk, or pre-SQL73 function. Do not rewrite
SQL73. Do not re-enable `handleHomeownerLedgerSignLink` as-is.
