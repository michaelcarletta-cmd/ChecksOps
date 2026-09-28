/**
 * Frozen production SPA after the accepted signature Step 3 mobile promotion.
 * Overlay on BkzeBHTL only. API/Lambda unchanged.
 */
export const ACCEPTED_PRODUCTION_SIGNATURE_STEP3_MOBILE_SPA = Object.freeze({
  host: 'https://checksops.com',
  spa_bundle: '/assets/index-C5ku3IDF.js',
  spa_sha256: 'bd5428a1ff1ca99b0908a54200376bb6ca6afe0d2f61414e49b4cdea1f368c11',
  css_bundle: '/assets/index-DnXJ52tu.css',
  index_html_sha256: '495fce2d8733d422a8676a9a4008ea31a6126ec4ac5ed33106aa68596f693548',
  s3_version: '8Y_w37g4znTqBsFeg1QHezFHdFSO0nSE',
  last_modified: '2026-09-28T14:15:00Z',
  accepted_at: '2026-09-28T14:15:00Z',
  field_placement_chunk: '/assets/FieldPlacementEditor-D1Nz3L-a.js',
  check_files_chunk: '/assets/CheckFilesSection-CHseToMm.js',
  sign_chunk: '/assets/Sign-DZRbDh7Y.js',
  s3_bucket: 'checksops-production-frontend-806168576068',
  cloudfront_id: 'E1B0ZWWO5559U5',
  cloudfront_invalidation_id: 'IAR2Z1QDDEMF38VNEXU5EC6B7O',
  cloudfront_invalidation_status_at_create: 'InProgress',
  deploy_mode: 'per_object_put',
  upload_count: 109,
  production_lambda: 'checksops-production-prep-api',
  production_lambda_sha: 'gHoAYTlh/WLTAovN7/hfwuvmBNuMjKZaC+zMzBsAOSw=',
  based_on_baseline: Object.freeze({
    spa_bundle: '/assets/index-BkzeBHTL.js',
    spa_sha256: 'e6f1fd9d97aa31d1ad705bfaf14004dff004159c87027c4848b9793c2181e787',
    index_html_sha256: 'c85afc1a685e551810259d4bc179a06dd10043eaa9e05b2de272757ea3292de7',
    s3_version: 'cknrbiGObviCUsPCB58bSOyeLta87W2V',
    production_lambda_sha: 'gHoAYTlh/WLTAovN7/hfwuvmBNuMjKZaC+zMzBsAOSw=',
  }),
  overlay_files: Object.freeze([
    'src/components/claim-detail/SignatureRequests.tsx',
  ]),
  selector_preserved: true,
  step2_composer_preserved: true,
  signing_engine_untouched: true,
  not_staging_wholesale: true,
  staging_spa_not_deployed: '/assets/index-tfpHiJF1.js',
  branch: 'cursor/sig-step3-mobile-prod-ad99',
});
