# QDJi→DSb recovery — production SPA apply

SPA only. Official `scripts/deployment-guard/production-spa-upload.mjs`
per-object put via `ChecksOpsProductionSpaDeploy`. No Lambda write. No
database, IAM, Cognito, environment, Moov/provider, or data changes.
Candidate was not rebuilt.

## Pre-write TOCTOU

Live HTTPS immediately before write still matched the pinned DSbVZXu8
baseline. No reclaim.

| Field | Required | Observed |
|---|---|---|
| Entry | `/assets/index-DSbVZXu8.js` | `/assets/index-DSbVZXu8.js` |
| Entry SHA256 | `8da351ee4060d065e626b382fec06acf9a7099317184980979b95468e7e4bbe5` | match |
| index.html SHA256 | `e93fe5488c013aed91626da1ee608978f702796a24e08350306ccb4c3163e75f` | match |
| S3 version | `Jc2Nyp5THf1j30gf21cQHeMoApSs8uDw` | match |
| ETag | `f92d3a12bd1f8eec9c200dbe71c05ae3` | match |

On-disk candidate still matched the approved artifact:

| Field | Required | Observed |
|---|---|---|
| Entry | `/assets/index-CvCKsSsX.js` | match |
| Entry SHA256 | `cd55efcde625c03ab8bba60decec3c4d6b3bb53e3a8e45dd6a4c2b9991065007` | match |
| index.html SHA256 | `0dac8cbceba15a086567511c447279c6a439c9c120079ebebb19309a8bf24e89` | match |

## Apply

| Field | Value |
|---|---|
| Writer | `scripts/deployment-guard/production-spa-upload.mjs --confirm-apply` |
| Role | `ChecksOpsProductionSpaDeploy` |
| Mode | `per_object_put` (108 objects, then `index.html`) |
| Receipt | signed `.deployment-guard/receipts/production::production-spa.json` |
| Commit | `e2056c095065151dc6bb2a487157e9663b1ef695` |
| Invalidation | `I5IAEE2NQOGRSI1QIPIZPYX04B` |
| After S3 version | `rLJElCrQEl1AqJJuW4YuKC.xuo06gfiV` |
| After ETag | `b2d4400446f1ef8b6a84896b5c11bcd2` |
| After Last-Modified | `2026-09-30T23:36:22Z` |

## Post-write live proof

HTTPS and S3 both serve the approved candidate. CloudFront `x-cache: Miss`.

| Field | HTTPS | S3 |
|---|---|---|
| Entry | `/assets/index-CvCKsSsX.js` | `/assets/index-CvCKsSsX.js` |
| Entry SHA256 | `cd55efcde625c03ab8bba60decec3c4d6b3bb53e3a8e45dd6a4c2b9991065007` | same |
| index.html SHA256 | `0dac8cbceba15a086567511c447279c6a439c9c120079ebebb19309a8bf24e89` | same |
| S3 version | `rLJElCrQEl1AqJJuW4YuKC.xuo06gfiV` | same |

## Acceptance

All required production-safe checks passed. Failures: none. Older SPA was
not restored.

| Check | Result |
|---|---|
| Moov `Bank verified` / `Provider linked` / `Bank pending` | present (1 each) |
| Freedom tenant logo GET | 200 PNG 796240 bytes sha256 `8fe8caf1…17c6801f` |
| Billing `save-tenant-billing-account` + no-collection guard | 3 / 1 |
| Deposit `groupDepositsBySubmissionDate` | 1 |
| Settlement `save_claim_settlement_breakdown` | 1 |
| Delete Check | `Delete Check` 1, `delete_check` 2 |
| Signature | 261 |
| Hostname guard | `checksops-production-host` 2 |
| WalletOps `environmentReady` | 3 |
| Full compiled-marker parity vs approved candidate | exact match, 0 mismatches |

Authenticated in-app clicks were not established. This record is
deployed-code / HTTPS / S3 verification.

Later read-only diagnosis: compiled-marker acceptance is **not** full
product acceptance. Live `index-CvCKsSsX.js` throws `supabaseUrl is
required.` during `src/integrations/supabase/client.ts` init because
`VITE_AUTH_PROVIDER` was baked empty. The HTML `#initial-loader`
(`Loading…`) never unmounts. See
`ops/release-locks/proof/2026-09-30-cvc-loading-init-failure.md`.

## Not done

- Lambda overlay
- Database, IAM, Cognito, environment, Moov/provider, or data writes
- Automatic restore of DSbVZXu8 or any older SPA
