/**
 * Frozen production SPA after the accepted signature check-file selector promotion.
 * Overlay only. API/Lambda unchanged.
 */
export const ACCEPTED_PRODUCTION_SIGNATURE_CHECK_FILE_SPA = Object.freeze({
  host: 'https://checksops.com',
  spa_bundle: '/assets/index-DRoG4LeT.js',
  spa_sha256: '97998b6014bdbd1ddc387bf18c68cd6347ca5fea0bdf85321f59a2a0d11e64aa',
  css_bundle: '/assets/index-CP4SLJzh.css',
  index_html_sha256: 'a21d4bfb3481978e1328c0d39ebf2a387901faa21810bd978be65e77900135d1',
  s3_version: 'nsdZAqxVImyWhdQSY8A.w_qGjbO_xhgM',
  last_modified: '2026-09-28T02:31:00Z',
  accepted_at: '2026-09-28T02:31:00Z',
  s3_bucket: 'checksops-production-frontend-806168576068',
  cloudfront_id: 'E1B0ZWWO5559U5',
  cloudfront_invalidation_id: 'I38CVD2TNENR6VXWNJ0CZXPZWL',
  deploy_mode: 'per_object_put',
  upload_count: 109,
  production_lambda: 'checksops-production-prep-api',
  production_lambda_sha: 'gHoAYTlh/WLTAovN7/hfwuvmBNuMjKZaC+zMzBsAOSw=',
  based_on_baseline: Object.freeze({
    spa_bundle: '/assets/index-BMBDIhiu.js',
    spa_sha256: '6308df1089d59ef1bb0a6a1a2c58b2772a01b18f0d0279160d20b9b23730ac45',
    index_html_sha256: 'd9e183e01851a7dd8624da1f7799073129cc0ca4e5934473016e65bcf3baacda',
    s3_version: 'XHWR4PV16nnmR7RJ7q8JIqSBjxLzq7qx',
    production_lambda_sha: 'gHoAYTlh/WLTAovN7/hfwuvmBNuMjKZaC+zMzBsAOSw=',
  }),
  overlay_files: Object.freeze([
    'src/lib/signature-source-files.ts',
    'src/components/claim-detail/SignatureRequests.tsx',
    'src/components/check-review/CheckFilesSection.tsx',
  ]),
  not_staging_wholesale: true,
  staging_spa_not_deployed: '/assets/index-gNnhTSog.js',
  branch: 'cursor/sig-check-file-selector-ad99',
});
