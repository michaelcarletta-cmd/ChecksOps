# Production SPA overlay — Mortgage Desk Return-to-Tenant

Narrow additive frontend overlay. Does not modify Lambda, database, schema,
RLS, billing, IAM, Cognito, provider configuration, or financial flags.

## Starting baseline (current live production)

| Field | Value |
|---|---|
| Host | `https://checksops.com` |
| Entry | `/assets/index-Cm6yZxRJ.js` |
| Entry SHA256 | `25573f789c57ec25ba18efc951dd77612b598f247c7996fabbc4c1e1e25b636c` |
| index.html SHA256 | `48be97748993c2fe55178e96a9a3450020d0249464528a96f30a958c9d654c07` |
| index VersionId | `XoLp7k58JuZ8r22Xs1u1iZWxrxvoGD2_` |
| Last-Modified | `Sun, 27 Sep 2026 10:10:47 GMT` |
| Live source SHA | `a863f3b47946352637c0b2494d4ce1aa9b223d6a` |
| Live source branch | `cursor/branding-reconciled-staging-ff98` |

A no-overlay rebuild of that SHA reproduced the live entry and index hashes
byte-for-byte.

## Overlay

Accepted source SHA: `c0320125898aedfeb382df12d404cef8c4f97e7f`

Files only:

- `src/lib/mortgageDeskReturn.ts`
- `src/hooks/useMortgageDeskReturnAlert.ts`
- `src/components/loss-draft/MortgageDeskReturnedBanner.tsx`
- `src/pages/mortgage-ops/MortgageOpsQueue.tsx`
- `src/components/loss-draft/LossDraftDashboard.tsx`
- `src/components/loss-draft/LossDraftDetailPanel.tsx`
- `src/components/loss-draft/detail/LossDraftActionsTab.tsx`
- `src/components/loss-draft/SendToMortgageDeskButton.tsx`
- `src/components/checks/CheckMortgageMonitoring.tsx`
- `src/components/check-messages/CheckMessageThread.tsx`
- `tests/mortgage-desk-return.test.ts`

Build: `node scripts/build-production-aws-spa.mjs` (`vite --mode production`).
Deploy: `per_object_put` to `checksops-production-frontend-806168576068`,
CloudFront `E1B0ZWWO5559U5`. No Lambda write.
