/**
 * Frozen production baseline after the controlled signature-workflow promotion.
 * Do not treat older production SPA/API pins as current.
 */
export const ACCEPTED_PRODUCTION_SIGNATURE_WORKFLOW = Object.freeze({
  host: 'https://checksops.com',
  spa_bundle: '/assets/index-BMBDIhiu.js',
  spa_sha256: '6308df1089d59ef1bb0a6a1a2c58b2772a01b18f0d0279160d20b9b23730ac45',
  css_bundle: '/assets/index-CP4SLJzh.css',
  css_sha256: 'b9024ef6d6d5022a94eb3cbe01d2fb90f8fb10b3d2ca19a3a62d8092cad7ef10',
  index_html_sha256: 'd9e183e01851a7dd8624da1f7799073129cc0ca4e5934473016e65bcf3baacda',
  s3_version: 'XHWR4PV16nnmR7RJ7q8JIqSBjxLzq7qx',
  last_modified: 'Sun, 27 Sep 2026 23:40:45 GMT',
  accepted_at: '2026-09-27T23:40:45Z',
  s3_bucket: 'checksops-production-frontend-806168576068',
  cloudfront_id: 'E1B0ZWWO5559U5',
  cloudfront_invalidation_id: 'I38G4JC88LWXEMIN1AAQFZR2EC',
  deploy_mode: 'per_object_put',
  upload_count: 109,
  production_lambda: 'checksops-production-prep-api',
  production_lambda_sha_before: '9OLR9DMhuDrAUp5/TmT6+8bfQC2I6USFk+zwFkluJLQ=',
  production_lambda_sha_after: 'gHoAYTlh/WLTAovN7/hfwuvmBNuMjKZaC+zMzBsAOSw=',
  live_baseline_git_sha: '355e404b727f1ecad19da5f3ed55c94bf90298ad',
  accepted_overlay_git_sha: '20b8177fafcb46adc9e1fe73f4ec7f01cbda95fd',
  based_on_baseline: Object.freeze({
    spa_bundle: '/assets/index-CNfFeGaT.js',
    spa_sha256: 'e203c755318928afd25a50e92525de819dd7550755a69ced110509646850676c',
    index_html_sha256: '2d5393baf7ecc3d9db8636d906eb4c8c01506f57cb075a8d5f659903d1ba78de',
    production_lambda_sha: '9OLR9DMhuDrAUp5/TmT6+8bfQC2I6USFk+zwFkluJLQ=',
  }),
  accepted_staging_candidate: Object.freeze({
    spa_bundle: '/assets/index-DKPj_vWc.js',
    spa_sha256: 'ea5936487a51104171ce5d8f9788cae63257ded36ecc3515951b025754ae21f7',
    index_html_sha256: 'f74323c721c73334c82966ea0cc79cd9df92826ba4f42dbc77dc63d0ba3476c1',
    api: 'nTisqcTLXpgw0Ej9kl7PosXn9a+BYcdBRSEvb5IIh5s=',
  }),
  lambda_files: Object.freeze([
    'esign.mjs',
    'homeowner.mjs',
    'signature-submit.mjs',
    'write-signature.mjs',
    'storage.mjs',
    'write-allowlist.mjs',
    'write-check-workflow.mjs',
  ]),
  spa_files: Object.freeze([
    'src/components/check-review/CheckFilesSection.tsx',
    'src/components/claim-detail/SignatureRequests.tsx',
    'src/pages/mortgage-ops/MortgageOpsRequestDetail.tsx',
    'src/integrations/aws/client.ts',
  ]),
  sql_files: Object.freeze([
    'aws/storage/sql/02_public_signature_write_helpers.sql',
    'aws/workflows/sql/69_homeowner_ledger_pending_and_sign_link.sql',
    'aws/rls/sql/39_mortgage_agent_signature_send.sql',
  ]),
  branch: 'cursor/signature-workflow-prod-ad99',
});
