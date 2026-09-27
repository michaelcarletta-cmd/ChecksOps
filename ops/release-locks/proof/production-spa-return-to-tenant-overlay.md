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

## Accepted live production result

| Field | Value |
|---|---|
| Entry | `/assets/index-CNfFeGaT.js` |
| Entry SHA256 | `e203c755318928afd25a50e92525de819dd7550755a69ced110509646850676c` |
| CSS | `/assets/index-CP4SLJzh.css` |
| CSS SHA256 | `b9024ef6d6d5022a94eb3cbe01d2fb90f8fb10b3d2ca19a3a62d8092cad7ef10` |
| index.html SHA256 | `2d5393baf7ecc3d9db8636d906eb4c8c01506f57cb075a8d5f659903d1ba78de` |
| index VersionId | `eNIfUE7TgD037Efopz_SrevMKegKGjra` |
| index ETag | `9f705b44d277a818d83a62d62063db9e` |
| Last-Modified | `Sun, 27 Sep 2026 18:33:41 GMT` |
| Overlay git SHA | `355e404b727f1ecad19da5f3ed55c94bf90298ad` |
| CloudFront invalidation | `IBMLUOVDR25GQICK99QTADTDX2` |
| Upload count | 103 objects, `index.html` last |
| Production Lambda SHA | `9OLR9DMhuDrAUp5/TmT6+8bfQC2I6USFk+zwFkluJLQ=` (unchanged) |
