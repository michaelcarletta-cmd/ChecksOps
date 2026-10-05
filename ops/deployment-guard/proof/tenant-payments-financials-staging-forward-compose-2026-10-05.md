# Tenant Payments & Financials staging forward-compose apply

Guarded **SPA-only** forward-compose. STOP for manual Tenant Payments & Financials UAT.
No production. No Lambda overlay. No SQL. No Moov writer. No financial-record mutation.

## Before (fresh-read, stable through preflight + TOCTOU)

| Target | Fingerprint |
|---|---|
| Staging SPA entry | `/assets/index-8R_AdfHv.js` |
| Staging `index.html` SHA-256 | `ece5927bd8009dca9973661fede239cb95980b11a78d7ee7015c9fc199a3af7d` |
| Staging `index.html` ETag | `31f0700d15ec6b8de2078181d085084a` |
| Staging `index.html` last modified | `2026-10-04T20:38:09+00:00` |
| Staging Lambda | `checksops-staging-api` |
| Staging Lambda CodeSha256 | `/0Wyipd63VyUCg97uzp4ppFHAnC9RLHeqBNOJCZZth8=` |
| Staging Lambda RevisionId | `a7ace3ea-006c-423e-a26d-87857c1e696a` |
| Staging Lambda last modified | `2026-10-04T20:34:40.000+0000` |

## After (verify-live)

| Target | Fingerprint |
|---|---|
| Staging SPA entry | `/assets/index-DxJGUt9C.js` |
| Staging `index.html` SHA-256 | `29a7fa5a6948ebf2e20136cfead50ae4c978d2ded986f2e98487b702446a1606` |
| Staging `index.html` ETag | `186a3d96ac532329cc0d46fb7c693460` |
| Staging `index.html` last modified | `2026-10-05T00:08:03+00:00` |
| Staging Lambda CodeSha256 | `/0Wyipd63VyUCg97uzp4ppFHAnC9RLHeqBNOJCZZth8=` **unchanged** |
| Staging Lambda RevisionId | `a7ace3ea-006c-423e-a26d-87857c1e696a` **unchanged** |
| CloudFront invalidation | `ID5EQTDP2FN1JKFTOZZMRTT8JD` |

## Exact source composition

- Live composition base: `2193ea9ca18f3e6bc11fbb139ab2f4c3b0e33cbf` (`cursor/platform-finance-staging-compose-93da`)
  - itself: Platform Finance `98e59823b` on Branding/SR/MAC `4f2687960`
- Accepted Payments delta: `cf4a4a781385ef224c419ca1921e69b9fbc01ad9` / tree `171c077ecb39d4d9c8e0b0b2f0249a9205c2a9b8`
- Compose branch: `cursor/tenant-payments-financials-staging-compose-4b16`
- Compose commit: `361318c8882079702ffabd27950ccfeee4d1cdd4`
- Compose tree: `00acb0c27e6c631768f0f894882687479a9fa79a`

Overlay only (byte-identical to `cf4a4a781`):

- `src/lib/payments/tenantPaymentAccuracy.ts` (new)
- `src/lib/payments/tenantPaymentAccuracyQueries.ts` (new)
- `src/components/ledger/PaymentLedger.tsx`
- `src/components/ledger/RecipientReport.tsx`
- `src/components/ledger/RevenueSummary.tsx`
- `src/components/ledger/TaxSummary.tsx`
- `src/lib/taxYtdSummary.ts`

Preserved unchanged vs `2193ea9c`: Platform Finance, Mortgage Agents, Branding, Homeowner, Signature Requests, Mortgage Desk, Claim Ledger, WalletOps/Moov, `moov-webhook`, `moov-disburse`.

## Exact deployed artifacts

Official writer: `node scripts/deployment-guard/staging-spa-upload.mjs` (put-object per file, no `s3 sync` / delete).

- Bucket: `checksops-staging-frontend-c48b`
- Uploaded object count: 106
- Candidate / live entry: `/assets/index-DxJGUt9C.js`
- Receipt: `.deployment-guard/receipts/staging::staging-frontend.json` (signed, single-use, exclusive lease)
- Lease workstream: `tenant-payments-financials-staging-compose-4b16`

Not deployed: Lambda ZIP, SQL, Moov writers, financial rows.

## Proof Lambda / Moov / SQL / financial data unchanged

- Staging Lambda CodeSha256 and RevisionId identical before and after.
- Production SPA remains `/assets/index-BgOCQCWm.js` (last modified `2026-10-03T11:41:40+00:00`).
- Production Lambda remains `CWB8lxnHoqANyVcaNpKL7h4MtDSPMlHZ6wliFuGE6yA=`.
- Git diff vs `2193ea9c` for `supabase/functions/moov-webhook`, `supabase/functions/moov-disburse`, `platformFinance.ts`, `PlatformBankPanel.tsx`, `PlatformTreasuryPanel.tsx`, `MortgageAgentsPanel.tsx`: empty.
- No `sql-apply`. No settlement backfill. No split status writes.

## Regression

- Accepted 31/31 Payments accuracy proofs PASS
  (`tests/tenant-payment-accuracy.test.ts` + `tests/moov-split-settlement-sync.proposed.test.ts` + recovered `/tmp/pre-staging-invariants.test.ts`)
- Mortgage Agents source contract PASS
- Branding public URL, tenant-logo isolation, Signature Requests, Homeowner ledger/tracking, Claim Ledger accepted + discovery, Review Claim Save, Check image, CheckAlt, tenant isolation, WalletOps layout, Moov file rules: PASS
- Built SPA contains Payments tabs/Profit/Received subtitle and Platform Finance + Mortgage Agents admin strings

## STOP

Manual Tenant Payments & Financials UAT is required.
No production.
The Moov settlement-sync proposal remains **NOT AUTHORIZED**.
