/**
 * Frozen staging SPA after the accepted signature check-file selector deploy.
 * Staging only. Do not promote to production until explicitly approved.
 */
export const ACCEPTED_STAGING_SIGNATURE_CHECK_FILE_SPA = Object.freeze({
  host: 'https://staging.checksops.com',
  spa_bundle: '/assets/index-gNnhTSog.js',
  spa_sha256: '2f469553856f1046c867c2a07fddeba324204bc0540a02a721773d773c90bf92',
  css_bundle: '/assets/index-iCMGPXk5.css',
  index_html_sha256: '873852c9912a70371b1b9f36a8ae1178e5069b7d4fe175334e3b3a2af2e425b1',
  check_files_chunk: '/assets/CheckFilesSection-BOoRJ0PD.js',
  s3_bucket: 'checksops-staging-frontend-c48b',
  cloudfront_id: 'E1CG52WRQZI7X1',
  cloudfront_invalidation_id: 'ICK8O66U8XOUQYVOK86A09I84N',
  accepted_at: '2026-09-28T02:18:00Z',
  spa_source_git_sha: 'eae3614fa041edc677ebcbcfe52568ed7e36af0f',
  branch: 'cursor/sig-check-file-selector-ad99',
  deploy_mode: 'per_object_put',
  staging_lambda: 'checksops-staging-api',
  staging_lambda_sha: 'nTisqcTLXpgw0Ej9kl7PosXn9a+BYcdBRSEvb5IIh5s=',
  overlay_from: '/assets/index-DKPj_vWc.js',
  production_untouched: Object.freeze({
    spa_bundle: '/assets/index-BMBDIhiu.js',
    spa_sha256: '6308df1089d59ef1bb0a6a1a2c58b2772a01b18f0d0279160d20b9b23730ac45',
    index_html_sha256: 'd9e183e01851a7dd8624da1f7799073129cc0ca4e5934473016e65bcf3baacda',
    api: 'gHoAYTlh/WLTAovN7/hfwuvmBNuMjKZaC+zMzBsAOSw=',
  }),
  files_included: Object.freeze([
    'src/lib/signature-source-files.ts',
    'tests/signature-source-files.test.ts',
    'src/components/claim-detail/SignatureRequests.tsx',
    'src/components/check-review/CheckFilesSection.tsx',
  ]),
});
