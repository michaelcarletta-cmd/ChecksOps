# Settings / billing / branding / deposits — production apply evidence

This file records **deployed-code** production evidence for items **#1**, **#2**,
and **#5**. It does **not** claim authenticated user acceptance. Isolated HTTP
login remains **NOT ESTABLISHED**. This record does not authorize homeowner
association (item **#3**), configuration or provider-flag changes, charges,
money movement, or test client emails.

Item numbering (do not substitute):

| Item | Requirement |
|---|---|
| **#1** | Monthly billing bank-selection/consent persistence without initiating collection |
| **#2** | Company, invoice, and email branding persistence, including logo/color and sending-subdomain UI removal |
| **#5** | Deposit submission-date grouping, daily totals, expandable checks, and preserved exclusion filters |

Item **#5** is deposit-history grouping by `submitted_at`. Stakeholder labels
(`Bank verified` / `Provider linked`) are an independent surface and are **not**
a substitute for item **#5**.

## Source SHAs

| Identity | SHA |
|---|---|
| Authorized application candidate | `84ba11f4c5fbc5a98652768dc72cb1e58757ea14` |
| Source compose onto live DbYbvb6d | `2cd3cd2e7f366784986da0f635cf4827d8062fbf` |
| Staging-acceptance record | `65609c6e333b76e1291bf3c87fa133d41d17481a` |
| Deployment-tooling / SPA preflight composition fix | `6059f03918cdba8858ad53a512aa030051bffb11` |
| Workstream | `settings-billing-branding-deposits-51c8` |

Historical hashes (`17fa334d`, `index-CEKjixtZ.js`, `index-C_fh5VBD.js`,
`index-DbYbvb6d.js`, Lambda `RaFQKBA…` / `pxZj4G6p…`) are provenance. They are
**not** rollback targets.

## Verified production SPA

| Field | Value |
|---|---|
| Host | `https://checksops.com/` |
| Entry | `/assets/index-QDJiUFF1.js` |
| Entry SHA256 | `19ae149deecc2d06792dece4b27ba30bf198a146a4325645f6e4468d5afd92c7` |
| index.html SHA256 | `5d35bd47b200ce7a5dbfd562bef1fcb4daa52f7ea89a1207e0b00e2150f12467` |
| S3 version | `NNalIXDhhdaOovnqFQwZVSJ99V0BFZz9` |
| Invalidation | `IEEF8WPGTAFVCF2ZHV1LGGTRI8` |
| WalletOps chunk | `/assets/WalletOps-D5mOeN7Q.js` sha256 `7dd4e22371f35917ece1fe604f7ad5c5ac00f6ea34e21bc765eb68c6b96a0af3` |
| Deposit chunk | `/assets/BankDepositReconciliation-CNd9vt9D.js` sha256 `d494d87c3fd2c31908402660228b069eaa25ab1f8fd5649dbe508259c968a718` |
| Banner hide | preserved (`checksops-production-host`) |
| Deploy role | `ChecksOpsProductionSpaDeploy` (bucket policy approved writer) |
| Writer | `scripts/deployment-guard/production-spa-upload.mjs` per-object put |
| HTTPS + S3 match | verified 2026-09-30T20:36:44Z |

## Verified production Lambda overlay

| Field | Value |
|---|---|
| Function | `checksops-production-prep-api` |
| Before CodeSha256 | `RaFQKBA489aj69N8e76eCQdzlJ2ijkA1YFNFPa+D9r4=` |
| Before RevisionId | `33e3f02d-3a97-4b8e-be31-4e104b7027f3` |
| After CodeSha256 | `JlChQagI3F26AEcQrFHRPvNsVLRGmO8nR9RKMK7ERJ0=` |
| After RevisionId | `d00d17e6-1d0a-4418-a72e-23ab1ccd4157` |
| Overlay members | `app-services.mjs`, `tenant-settings-handlers.mjs`, `tenant-email-domain-handlers.mjs`, `providers/parity/moov-functions.mjs`, `providers/parity/moov-stakeholder-status.mjs` |
| Package origin | fresh-live-download |
| Configuration keys | 49, unchanged |
| Writer | `scripts/deployment-guard/production-lambda-apply.mjs` overlay-only |

Preserved live member SHA256 (unchanged):

| Member | SHA256 |
|---|---|
| `esign.mjs` | `7c60b6462f7e0caa21800481a68735a44fc38bde19d74f78c64bc5ca97956b74` |
| `workflow.mjs` | `bd18db71ab9277eea74add41f99ed5324841a163815a756578f60cfd50bf7bab` |
| `workflow-rpc.mjs` | `09bb37e6af8c9501f0af61ecc6cba6b8381971ae210e0f1a0ed05939dcb82c88` |
| `ocr.mjs` | `ecd3b253c111921ee62f21bab214bd346ab19819a9c764cdef33b07524c6221f` |
| `ocr-parse.mjs` | `16c15529f9bb4d975baa31ba5cbe824dd3eee4bd984487f7e4717b77c8878ede` |
| `signature-submit.mjs` | `24845b4cfbce74de6163a7f94174d5c56af2e5828cfbdeca99c791175150f38d` |

## Authenticated acceptance limitation

Deployed-code verification succeeded (S3, HTTPS, Lambda member hashes).
Authenticated user acceptance is **not** claimed. Isolated HTTP login is
**NOT ESTABLISHED**. No OTP, no `.invalid` mailbox claim, no test-client
session, and no in-app save of billing, branding, or deposits was exercised
against production as a signed-in tenant user.

## Not authorized / not done

- Item #3 homeowner Moov association
- Configuration or provider-flag changes
- Charges, money movement, or test client emails
- Restore of `index-DbYbvb6d.js`, `index-C_fh5VBD.js`, `index-CEKjixtZ.js`, or `17fa334d`
