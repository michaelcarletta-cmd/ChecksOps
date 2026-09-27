# Post-R3 production freeze

> **SUPERSEDED as current-live authority.** The authoritative production freeze
> after the accepted existing-back-image compatibility overlay is
> `POST_IMAGE_PRODUCTION_FREEZE.md` / `post-image-production-freeze.json`.
> Hashes in this R3 record remain **provenance only** and must not be used as
> rollback targets.

This record froze live production after accepted R1 / R2 / R3 recovery.

It is an invariant and provenance source. It is **not** an instruction to roll production backward.

Future Lambda or SPA deployments must start from **current live production**. If live has moved, reconcile against that newer package. Do not deploy obsolete pins.

Machine-readable companion: `aws/audit/post-r3-production-freeze.json`.

## Authority

| Item | Authority |
| --- | --- |
| Production Lambda package | Fresh GetFunction / downloaded ZIP |
| Production SPA graph | Live `index.html` recursive walk |
| Git `main` | Not a deployment baseline |
| Historical hashes below | Provenance only |

This workstream did **not** change production Lambda code, Lambda configuration, SQL, Cognito, IAM, application data, or product behavior. It did **not** republish the SPA.

## Current live Lambda pin

| Field | Value |
| --- | --- |
| Function | `checksops-production-prep-api` |
| Account / region | `806168576068` / `us-east-1` |
| CodeSha256 | `o/U/pbZ2FR38T3HI6A6kUxp9wik4pci92KmEVfmhF6I=` |
| Package SHA256 | `a3f53fa5b676151dfc4f71c8e80ea4531a7dc22938a5c8bdd8a98455f9a117a2` |
| RevisionId | `470ad806-c710-415b-8f93-59232d8ee13c` |
| LastModified | `2026-09-25T18:35:08.000+0000` |
| Runtime | `nodejs22.x` |
| Handler | `index.handler` |
| Role | `arn:aws:iam::806168576068:role/checksops-production-api-execution` |
| Memory / timeout | 1024 MB / 45 s |
| Architecture | `arm64` |
| VPC | `vpc-09f2268778966ce97` |

This package contains accepted R2 identity/invite-lock recovery, Delete Check, S2, S5, S11, S14, current Moov monthly billing, the newer billing engine/handlers, and R3 OCR/intake recovery.

### Protected-file hashes (live)

| File | Role | SHA256 |
| --- | --- | --- |
| `identity-env.mjs` | R2 | `e814546feded3a323461b3a7a8369e3d8a09f9a5d306d68973e15389b871f443` |
| `tenant-admin.mjs` | R2 | `2e4a30da6f8eb8504044ab1159ba0ecb79403ecef97c067d3581e08917eb8244` |
| `workflow.mjs` | Delete Check / S5 | `85274058cbe4db085ac7ee558c0165a593b5bd6c7cd5ad844ce16571b5d70059` |
| `workflow-rpc.mjs` | Delete Check / S5 | `165aee3f695c51b509054b4c03db82f833ac67c41fb290351aa2815bae31a0b2` |
| `endorsement-material-invalidation.mjs` | S2 | `8a345898d19ed791f9a5c2e94f7c9bfb95f05508d1cce514b82ea165e2f32af1` |
| `financial-idempotency.mjs` | S11 | `14c6ca7a4bd5ea18b681d1cb83921b83b1a933255d0ef1a60546ad1fffe2f96e` |
| `financial-remaining.mjs` | S14 | `e608c00f65623bfc226eecd7d216d64141e610f2a2c1b0cb841f9736d5397989` |
| `check-deposited.mjs` | S14 | `395ddec5c88e2290fc72f2ab86ef2c934fe7654c7f2309a8176e1147ce32edf1` |
| `tenant-billing-engine.mjs` | Moov monthly (newer live) | `f17199aaf630d015313ea80ab4cdf5d19af0b7fb6e189833587a36471453605d` |
| `tenant-billing-handlers.mjs` | Moov monthly (newer live) | `d64c7538317d6b20df6a28e3551cfec73cdc60ab47546e8d8059951c87b423e1` |
| `tenant-billing-destination.mjs` | Moov monthly | `4c0d72def4eb82ef6507853a5cd8aba29f6d8c5058e17f1b23db52ace9815621` |
| `ocr-parse.mjs` | R3 | `16c15529f9bb4d975baa31ba5cbe824dd3eee4bd984487f7e4717b77c8878ede` |
| `ocr-descriptive-persist.mjs` | R3 | `32c2cecc723ad4253558d39fdbba13aa20e6e4a04b1886e9e7e6e7e1f66748ae` |
| `check-ocr-provider.mjs` | R3 | `2d2eaa6a4deb02b257f2928d71cc6b6d3f501ee480adb479266bd0930f41e2dc` |

Live-package regression: **107/107 PASS**. Protected-file preservation: **PASS**.

## SQL invariant

`public.ocr_persist_extracted_amount(p_check_id uuid, p_amount numeric) → jsonb`

Migration 42 is already present in production. It must **not** be reapplied. This workstream did not run SQL. Proof is the already captured R3 SQL-gate evidence.

## Current live SPA pin

A newer complete SPA became live after the accepted R1 pins. Recursive walk of the **current** live `index.html` is the freeze.

| Field | Value |
| --- | --- |
| Index SHA256 | `0fb105c58a5afeb8dd6fe4a497db1df012a0473f85da02484d9a7a4417ff4f87` |
| Index VersionId | `8SaYIyB6Vu9Yyb56agkS.j4ua4z2ZJWY` |
| Index LastModified | `2026-09-25T18:38:14Z` |
| Main | `assets/index-GHTPHbRW.js` |
| Main SHA256 | `d726623a64ca6f38a97d1f1a37f41f63f4fcc9578f8ad1bd60ee7281ebe6ec4d` |
| Claim Check | `assets/CheckCommandCenter-D3bX7ola.js` |
| Claim Check SHA256 | `520117f30184846490f52a72c6909d1af3d755318813d4873e1f98ee058af19a` |
| Recursive objects | 102 |
| Missing | 0 |
| HTML fallbacks | 0 |
| CloudFront checks | 102 / 102 match, 0 HTML fallbacks |

Required surfaces present on the live graph:

- Claim Check
- Payee Endorsements
- Mortgage Desk
- Admin / Tenant / Moov billing

The earlier incomplete-R1 failure mode (index live while a lazy chunk is missing or returns SPA HTML) is rejected by `scripts/production-spa-promote-guard.mjs`.

### R1 artifact comparison

`/opt/cursor/artifacts/r1-2d-prod-candidate` (tree `15c9ab29…`) matches the **previous** live index at `2026-09-25T17:19:12Z` (VersionId `MarEkrFtsgcP56EkceG6j0IOOcK_FL1t`, SHA `ffa6c835…`). It is **not** the current live index.

Those historical hashed objects remain in S3. They were not deleted. They must not be used to roll the live index backward.

## Provenance hashes (do not deploy)

These are **not** current deployment pins:

- Lambda `DMWpDQ…` — obsolete
- Lambda `KdqRSVd7D7rpBNEsmZPlQ08J+H+E7rOjfaidTvgyNXE=` — immediate pre-R3 live
- R3 candidate ZIP `bae57b…` / `uuV7Pco…` — must not be deployed
- SPA index `ffa6c835…` / main `index-DcU_cK7_.js` / Claim Check `CheckCommandCenter-CYCiVxBh.js` — accepted R1 pins, superseded at `2026-09-25T18:38:14Z`

## Safeguards

### Lambda overlay (`scripts/production-lambda-overlay-guard.mjs`)

1. Fetch current live Lambda immediately before candidate construction.
2. Record CodeSha256 + RevisionId.
3. Overlay only an explicit allowlist onto that exact package.
4. Fail if any non-allowlisted file differs.
5. Verify frozen/protected hashes for files that are not on the allowlist.
6. Re-fetch immediately before deploy; fail if CodeSha256 or RevisionId moved.
7. Deploy code-only with RevisionId optimistic lock.
8. Never call `UpdateFunctionConfiguration` unless a separately authorized operation requests it.
9. Download the deployed package and prove it equals the candidate and only authorized files changed.

If live production has moved, the guard requires reconciliation against the newer live package. It does not roll back to this freeze ZIP.

### SPA complete-graph promotion (`scripts/production-spa-promote-guard.mjs`)

1. Recursively discover every asset referenced by the candidate.
2. Fail if any referenced local asset is missing.
3. Record the current live index pin.
4. Upload every required asset **except** `index.html` first.
5. `s3 sync --delete` is prohibited.
6. Verify every required uploaded object exists and matches SHA, and is not HTML fallback.
7. Switch `index.html` last.
8. Recursively crawl the now-live graph and fail if any referenced object is missing, mismatched, or HTML.

A failed asset preflight leaves the old index live.

## Safeguard tests

`aws/tests/production-lambda-overlay-guard.test.mjs` and `aws/tests/production-spa-promote-guard.test.mjs`: **18/18 PASS**.

Covered failures: unexpected protected-file change, unauthorized fourth Lambda file, CodeSha256 TOCTOU, RevisionId TOCTOU, stale production ZIP, missing nested dynamic import, missing lazy-route dependency, HTML fallback, index-before-assets, `s3 sync --delete`.

Covered passes: authorized overlay, complete SPA graph with index last, current accepted R3 ZIP no-op, R1 artifact complete-graph walk.

## Configuration-rewrite investigation

Read-only. IAM was not broadened.

| Source | Result |
| --- | --- |
| `cloudtrail:LookupEvents` | AccessDenied for `ChecksOpsCursorCloudStaging` |
| `config:DescribeConfigurationRecorders` | AccessDenied |
| Current Lambda LastModified / RevisionId | Match accepted R3 `UpdateFunctionCode` at `2026-09-25T18:35:08Z` |
| Configuration fingerprint vs R3 post-deploy | Unchanged |

Attribution of earlier LastModified / RevisionId moves that left CodeSha256 unchanged remains an **unresolved audit gap**. The overlay guard still protects against those moves via TOCTOU on CodeSha256 and RevisionId.

## Out of scope

These decisions were not resolved and were not changed:

- production password-auth intent
- intended production value of `AWS_ENDORSEMENT_AUTO_ADVANCE`
- Mortgage hire lock that never reached accepted production
- R4 logo / branding

Do not start R4 from this freeze.
