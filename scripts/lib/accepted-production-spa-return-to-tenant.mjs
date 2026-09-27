/**
 * Frozen production SPA after the accepted Mortgage Desk return-to-tenant
 * frontend overlay. Do not treat an older production bundle as current.
 *
 * Frontend only. Lambda / DB / RLS / billing were not modified.
 */
export const ACCEPTED_PRODUCTION_RETURN_TO_TENANT_SPA = Object.freeze({
  host: 'https://checksops.com',
  spa_bundle: '/assets/index-CNfFeGaT.js',
  spa_sha256: 'e203c755318928afd25a50e92525de819dd7550755a69ced110509646850676c',
  css_bundle: '/assets/index-CP4SLJzh.css',
  css_sha256: 'b9024ef6d6d5022a94eb3cbe01d2fb90f8fb10b3d2ca19a3a62d8092cad7ef10',
  index_html_sha256: '2d5393baf7ecc3d9db8636d906eb4c8c01506f57cb075a8d5f659903d1ba78de',
  s3_etag: '9f705b44d277a818d83a62d62063db9e',
  s3_version: 'eNIfUE7TgD037Efopz_SrevMKegKGjra',
  s3_bucket: 'checksops-production-frontend-806168576068',
  cloudfront_id: 'E1B0ZWWO5559U5',
  cloudfront_invalidation_id: 'IBMLUOVDR25GQICK99QTADTDX2',
  last_modified: 'Sun, 27 Sep 2026 18:33:41 GMT',
  accepted_at: '2026-09-27T18:33:41Z',
  overlay_git_sha: '355e404b727f1ecad19da5f3ed55c94bf90298ad',
  live_baseline_git_sha: 'a863f3b47946352637c0b2494d4ce1aa9b223d6a',
  accepted_source_git_sha: 'c0320125898aedfeb382df12d404cef8c4f97e7f',
  based_on_baseline: Object.freeze({
    spa_bundle: '/assets/index-Cm6yZxRJ.js',
    spa_sha256: '25573f789c57ec25ba18efc951dd77612b598f247c7996fabbc4c1e1e25b636c',
    index_html_sha256: '48be97748993c2fe55178e96a9a3450020d0249464528a96f30a958c9d654c07',
    s3_version: 'XoLp7k58JuZ8r22Xs1u1iZWxrxvoGD2_',
  }),
  branch: 'cursor/mortgage-desk-return-prod-spa-ad99',
  deploy_mode: 'per_object_put',
  upload_count: 103,
  production_lambda_sha: '9OLR9DMhuDrAUp5/TmT6+8bfQC2I6USFk+zwFkluJLQ=',
  files_included: Object.freeze([
    'src/lib/mortgageDeskReturn.ts',
    'src/hooks/useMortgageDeskReturnAlert.ts',
    'src/components/loss-draft/MortgageDeskReturnedBanner.tsx',
    'src/pages/mortgage-ops/MortgageOpsQueue.tsx',
    'src/components/loss-draft/LossDraftDashboard.tsx',
    'src/components/loss-draft/LossDraftDetailPanel.tsx',
    'src/components/loss-draft/detail/LossDraftActionsTab.tsx',
    'src/components/loss-draft/SendToMortgageDeskButton.tsx',
    'src/components/checks/CheckMortgageMonitoring.tsx',
    'src/components/check-messages/CheckMessageThread.tsx',
    'tests/mortgage-desk-return.test.ts',
  ]),
});
