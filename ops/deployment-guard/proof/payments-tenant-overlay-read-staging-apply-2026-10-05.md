# Tenant recipient overlay read — guarded staging apply

Guarded **staging-only** apply of the accepted overlay-read correction.
STOP for manual Payments UAT. No production. No SQL. No Moov. No money movement.

SQL 81 was already applied by `payments-accounting-sql81-staging-apply-4b16`.
This workstream did **not** reapply, inspect-apply, or modify SQL 81.

## Accepted source

| Field | Value |
|---|---|
| Source branch | `cursor/payments-tenant-overlay-read-4b16` |
| Source commit | `d05d348220097b89faa84e7f1f7dc7800320db58` |
| Source tree | `26a293082e47fe4b832e2d3e1f94146f154f2a28` |
| Apply workstream | `payments-tenant-overlay-read-4b16` |
| Apply proof branch | `cursor/payments-tenant-overlay-read-staging-apply-4b16` |
| Operator | `cursor-cloud-agent` |
| Target | staging SPA + `checksops-staging-api` only |

Root cause accepted: overlay writes succeed through Class A
`tenant-payment-accounting`, but the Payments read model never listed
`tenant_payment_recipient_overrides`, so refresh fell back to `tenants.name`.

## 1 — Fresh-read (before apply)

Expected observations matched live. They were **not** restore authority.

| Target | Fingerprint |
|---|---|
| Staging SPA entry | `/assets/index-D7Zq697i.js` |
| Staging `index.html` SHA-256 | `cc1f1bdbe1851273ef19075594b04df1cf17a07e5db7a0e351a21431f1c70160` |
| Staging `index.html` ETag | `f3a660625aba04292153f0d884159d3a` |
| Staging `index.html` last modified | `2026-10-05T00:50:28+00:00` |
| Staging Lambda | `checksops-staging-api` |
| Staging Lambda CodeSha256 | `1eHQOkfWcbP31MB0hgMldpLSAmW/IMfTWpQONwcKjaw=` |
| Staging Lambda RevisionId | `c3690123-a961-49b2-9b6a-7194f72d2128` |
| Staging Lambda last modified | `2026-10-05T00:48:02.000+0000` |
| Live ZIP members | 6482 |
| `AWS_WRITES_ENABLED` | `true` |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | `true` |
| `AWS_MOOV_ENABLED` | `false` |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `false` |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | `true` |
| `CHECKSOPS_ENV` | `staging` |

Production (observe-only; not a target):

| Target | Fingerprint |
|---|---|
| Production SPA entry | `/assets/index-Bbftik1r.js` |
| Production `index.html` SHA-256 | `ac1dc285c0af1a6046d484bde94aff9b4e4238f52df5b4d24f5c8a9e3252820e` |
| Production `index.html` last modified | `2026-10-05T00:22:08+00:00` |
| Production Lambda | `checksops-production-prep-api` |
| Production Lambda CodeSha256 | `RUOC6wUAE9eCkhbhF8h8FAfUyegj9KCrvZt5vCojOlw=` |
| Production Lambda RevisionId | `48b8b0da-7448-435b-b9ea-d068a4497f1e` |
| Production Lambda last modified | `2026-10-05T00:15:53.000+0000` |

Live Lambda already contained write-only `payment-accounting.mjs`
(`716aef9cb4d9b54ea91148e4c10d9ff86fb85a34261e3a674ee9aaa01eefcbaa`)
and registered `app-services.mjs`
(`404d8fcd3427d07e26a1f2a3d3a49e202e0c6cf89da864a87517b83015bb1822`).
No competing workstream owned `payment-accounting.mjs` after the expired
metadata-apply lease. Forward-reconciled from a fresh live ZIP. Did not
restore an older composition.

## 2 — SQL 81 — NOT REAPPLIED / NOT MODIFIED

| Check | Result |
|---|---|
| SQL file | `aws/payments/sql/unapplied-do-not-run/NOT_APPLIED_81_tenant_payment_recipient_overrides.sql` |
| SHA-256 | `089dfd67a193cd57c0608e09a443332f5d76f6fa9d35e29e00bf24065fdcaf9e` **unchanged** |
| `sql-apply` / `sql-executor-invoke` this workstream | **not invoked** |
| Overlay-read apply artifacts under `/tmp/overlay-read-apply` | no SQL writer inputs or results |
| Receipts issued this workstream | `staging::checksops-staging-api` and `staging::staging-frontend` only |
| Leftover `staging::staging-sql` receipt | prior SQL 81 workstream `sql81-inspect-after-20261005-1` (expired; not consumed here) |

`allowed-tables.json` still SHA-256
`a1772c723bc07fbc0d02bda2fd02a4915b1a41944ca2f7b368602117634868cb`
and does **not** include `tenant_payment_recipient_overrides`.
Generic `/data/query` does not expose the overlay table.

## 3 — Lambda overlay

Official writer: `node scripts/deployment-guard/lambda-overlay-apply.mjs`
with a signed receipt. Fresh live ZIP origin. RevisionId CAS against
`c3690123-a961-49b2-9b6a-7194f72d2128`.

Owned member: `payment-accounting.mjs` only.

| Member | Op | SHA-256 |
|---|---|---|
| `payment-accounting.mjs` | **REPLACE** | before `716aef9cb4d9b54ea91148e4c10d9ff86fb85a34261e3a674ee9aaa01eefcbaa` → after `d596598ed9a064f67838f23c26389a101522389d73316964f22b8e9b53d7b2cb` |
| `app-services.mjs` | preserved | `404d8fcd3427d07e26a1f2a3d3a49e202e0c6cf89da864a87517b83015bb1822` |
| `allowed-tables.json` | preserved | `a1772c723bc07fbc0d02bda2fd02a4915b1a41944ca2f7b368602117634868cb` |

| Count | Value |
|---|---|
| Members before | 6482 |
| Members after | 6482 |
| Added | none |
| Removed | none |
| Changed | `payment-accounting.mjs` only |
| Official post-overlay preserved | 6481 |

Correction in that member: `list_recipient_overlays` (authenticated,
payer/tenant scoped, cross-tenant 403). Existing
`update_recipient_display` / `update_split_type` kept. Read uses
`withIdentity` (not write). No `moovFetch`, transfer, ACH, sweep, fee,
invoice, or payroll path.

Apply result CodeSha256
`JxM/0GaJ8kpGgwp/M5BscS3In2EBAUdhGJGQBS+/D/Q=`.
Writer-reported RevisionId `4edf723c-b9f9-4f50-911c-83e03cb6c540`;
subsequent observe-only `get-function-configuration` settled to
`a403d0da-e67e-42f6-adaf-5df639964ee3` with the **same** CodeSha256 and
`LastModified` `2026-10-05T01:27:12.000+0000`. Treated as Lambda settle,
not a second overlay.

Official apply-time `verify-live.mjs` (`kind=lambda-overlay`): **ok**.
CAS matched `1eHQOkfW…` / `c3690123…`. Post-overlay: 6481 preserved.

## 4 — SPA forward-compose

Official writer: `node scripts/deployment-guard/staging-spa-upload.mjs`
(put-object per file; no `s3 sync` / delete). Fresh `vite --mode aws`
build from `d05d34822` with local `.env` hidden so no Supabase embed.

Accepted overlay-read integration only (display metadata for `tenant:`
identities inside Payments & Financials; durable key remains
`tenant:<recipientTenantId>`):

- `src/lib/payments/paymentAccounting.ts` — `listRecipientOverlays`
- `src/lib/payments/tenantPaymentAccuracy.ts` — apply overlay on read
- `src/lib/payments/tenantPaymentAccuracyQueries.ts` — Class A list fetch
- `src/components/ledger/PaymentLedger.tsx`
- `src/components/ledger/RecipientReport.tsx`
- `src/components/ledger/TaxSummary.tsx`

Preserved composition base: metadata writes (`ca4b04fda`) on Payments
accuracy / Platform Finance / Branding / SR / MAC / Homeowner / Mortgage
Desk / Claim Ledger / WalletOps. `acct:` / `ext:` editing unchanged.

| Artifact | Value |
|---|---|
| Bucket | `checksops-staging-frontend-c48b` |
| Uploaded objects | 106 |
| CloudFront invalidation | `I9HW28Y3KQPO3W76ZIPSA4KMGS` |
| Candidate / live entry | `/assets/index-ffqZq1Rc.js` |
| Payments chunk | `/assets/Payments-Dt6tqXnG.js` |
| `production_untouched` | `true` |

Built Payments chunk contains `tenant-payment-accounting`,
`list_recipient_overlays`, `update_recipient_display`, `update_split_type`.
It does **not** contain `tenant_payment_recipient_overrides`,
`/data/query`, `moovFetch`, `createTransfer`, or `VITE_SUPABASE`.

Official apply-time `verify-live.mjs` (`kind=spa-promote`): **ok**.
TOCTOU matched `cc1f1bdbe…` / `/assets/index-D7Zq697i.js`.

## 5 — After (observe-only re-read `2026-10-05T01:31:52Z`)

Live still matches the applied composition. Production unchanged.

| Target | Before | After |
|---|---|---|
| Staging SPA entry | `/assets/index-D7Zq697i.js` | `/assets/index-ffqZq1Rc.js` |
| Staging `index.html` SHA-256 | `cc1f1bdbe1851273ef19075594b04df1cf17a07e5db7a0e351a21431f1c70160` | `238a1232ae3f9b8c528ee72b78aa1d70d4a1321476bcf651995d8c538f73e060` |
| Staging `index.html` ETag | `f3a660625aba04292153f0d884159d3a` | `ea6bf5e94f6e8c4aab68e4e85531a916` |
| Staging `index.html` last modified | `2026-10-05T00:50:28+00:00` | `2026-10-05T01:29:11+00:00` |
| Staging Lambda CodeSha256 | `1eHQOkfWcbP31MB0hgMldpLSAmW/IMfTWpQONwcKjaw=` | `JxM/0GaJ8kpGgwp/M5BscS3In2EBAUdhGJGQBS+/D/Q=` |
| Staging Lambda RevisionId | `c3690123-a961-49b2-9b6a-7194f72d2128` | `a403d0da-e67e-42f6-adaf-5df639964ee3` |
| Staging Lambda last modified | `2026-10-05T00:48:02` | `2026-10-05T01:27:12` |
| Production SPA | `/assets/index-Bbftik1r.js` | **unchanged** |
| Production Lambda CodeSha256 | `RUOC6wUAE9eCkhbhF8h8FAfUyegj9KCrvZt5vCojOlw=` | **unchanged** |
| Production Lambda RevisionId | `48b8b0da-7448-435b-b9ea-d068a4497f1e` | **unchanged** |

No reclaim. No restore. Flags after apply are identical to fresh-read.

## 6 — Proof SQL 81 / financial data / money movement untouched

| Path | Evidence |
|---|---|
| SQL 81 | file hash unchanged; no `sql-apply`; no executor invoke; leftover SQL receipt is prior workstream inspect-after |
| Generic table expose | `allowed-tables.json` unchanged; overlay table absent; Payments chunk has no `/data/query` |
| Moov / provider execution | `AWS_MOOV_ENABLED=false`, `AWS_PROVIDER_EXECUTION_ENABLED=false` unchanged |
| Handler money APIs | live `payment-accounting.mjs` has no `moovFetch` |
| SPA money APIs | Payments chunk has no `moovFetch` / `createTransfer` |
| Financial columns | overlay applies display metadata only; durable `tenant:<uuid>` key preserved |
| Unrelated Lambda members | 6481 byte-identical including `app-services.mjs` |
| Production | SPA + Lambda fingerprints identical before and after |

Overlay application must not change Received, Paid, Profit, payment
amount, status, settlement, provider IDs, `recipient_tenant_id`,
`destination_tenant_id`, payer tenant, underlying `tenants.name`, or bank
information. Those invariants are covered by the accuracy + metadata
suites below.

## 7 — Regression

Accepted suites (source `d05d34822`, before apply):

| Suite | Result |
|---|---|
| Payments accuracy (`tests/tenant-payment-accuracy.test.ts`) | **22/22 PASS** |
| payment-accounting metadata (`aws/tests/payment-accounting-metadata.test.mjs`) | **15/15 PASS** |
| Class A services | 14/14 PASS |
| Generic `/data/write` financial deny (`api-write`) | 25/25 PASS |
| Tenant isolation | 6/6 PASS |
| Tax containment | 33/33 PASS (`--experimental-strip-types` retry) |
| Wave1 review patches | 15/15 PASS (`--experimental-strip-types` retry) |
| Claim Ledger accepted | 4/4 PASS |
| Claim Ledger discovery | 9/9 PASS (`--experimental-strip-types` retry) |
| Claim Ledger SQL 44 | 2/2 (1 skipped) PASS |
| Signature Requests accepted | 5/5 PASS |
| e-sign SR invariants | 5/5 PASS |
| Parity signature submit | 5/5 PASS |
| Email branding SR | 3/3 PASS |
| Check image | 2/2 PASS (`--experimental-strip-types` retry) |
| CheckAlt deposit preflight | 7/7 PASS |
| OCR Azure | 5/5 PASS |
| Moov file rules | 21/21 PASS (retry) |
| WalletOps | 15/15 PASS |
| Release locks | 56/56 PASS |

Accuracy overlay proofs include: Condition One Commercial identity
unchanged; payer display Condition 1 Commercial after refetch/refresh;
one `tenant:<uuid>` bucket; other payer still sees Condition One
Commercial; cross-tenant overlay rows ignored; tax labels overlay
without changing Received/Paid/Profit; ledger fetch uses Class A list
and does not generic-write.

Metadata suite still proves `acct:` / `ext:` persist, financial-column
rejects, cross-tenant 403, and `list_recipient_overlays` payer-scope +
cross-tenant deny.

Known pre-existing / env-only failures (not this overlay):

- `npm run test:deployment-guard` 209/212 — `aws-production-spa-bootstrap`
  rebuilds `dist` and then cannot see `/assets/index-*.js`;
  `sql-executor-auth` “official preflight forwards executor authorization
  fields” still reports `REGRESSION_DETECTED` for `signature-requests`
  contract_results (pre-existing).
- `aws-production-spa-bootstrap` 1/2 after apply for the same rebuild/
  inspect path. Live staging `index.html` **does** reference
  `/assets/index-ffqZq1Rc.js`.

## 8 — STOP for manual UAT

Manual staging UAT is required. Do not treat this apply as product
acceptance.

Required observation for the payer that already saved the overlay:

- Underlying tenant / company: **Condition One Commercial**
- Payments & Financials display after refresh: **Condition 1 Commercial**
- No second recipient bucket
- Another payer without the overlay still sees **Condition One Commercial**
- `acct:` / `ext:` editing remains as previously accepted

**NO PRODUCTION.**
