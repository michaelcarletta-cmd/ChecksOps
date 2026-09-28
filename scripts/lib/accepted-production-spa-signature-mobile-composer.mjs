/**
 * Frozen production SPA after the accepted mobile signature composer promotion.
 * Overlay on DRoG4LeT only. API/Lambda unchanged.
 */
export const ACCEPTED_PRODUCTION_SIGNATURE_MOBILE_COMPOSER_SPA = Object.freeze({
  host: 'https://checksops.com',
  spa_bundle: '/assets/index-BkzeBHTL.js',
  spa_sha256: 'e6f1fd9d97aa31d1ad705bfaf14004dff004159c87027c4848b9793c2181e787',
  css_bundle: '/assets/index-DdHcyR0B.css',
  index_html_sha256: 'c85afc1a685e551810259d4bc179a06dd10043eaa9e05b2de272757ea3292de7',
  s3_version: 'cknrbiGObviCUsPCB58bSOyeLta87W2V',
  last_modified: '2026-09-28T12:40:16Z',
  accepted_at: '2026-09-28T12:40:16Z',
  field_placement_chunk: '/assets/FieldPlacementEditor-ByL2YiaU.js',
  check_files_chunk: '/assets/CheckFilesSection-COf93xa4.js',
  sign_chunk: '/assets/Sign-DTAgtqLn.js',
  s3_bucket: 'checksops-production-frontend-806168576068',
  cloudfront_id: 'E1B0ZWWO5559U5',
  cloudfront_invalidation_id: 'IBUGUIU4C9TIFEU0AD2WOEIUQC',
  cloudfront_invalidation_status_at_create: 'InProgress',
  deploy_mode: 'per_object_put',
  upload_count: 109,
  production_lambda: 'checksops-production-prep-api',
  production_lambda_sha: 'gHoAYTlh/WLTAovN7/hfwuvmBNuMjKZaC+zMzBsAOSw=',
  based_on_baseline: Object.freeze({
    spa_bundle: '/assets/index-DRoG4LeT.js',
    spa_sha256: '97998b6014bdbd1ddc387bf18c68cd6347ca5fea0bdf85321f59a2a0d11e64aa',
    index_html_sha256: 'a21d4bfb3481978e1328c0d39ebf2a387901faa21810bd978be65e77900135d1',
    s3_version: 'nsdZAqxVImyWhdQSY8A.w_qGjbO_xhgM',
    production_lambda_sha: 'gHoAYTlh/WLTAovN7/hfwuvmBNuMjKZaC+zMzBsAOSw=',
  }),
  overlay_files: Object.freeze([
    'src/lib/signature-field-coordinates.ts',
    'src/components/claim-detail/FieldPlacementEditor.tsx',
    'src/components/claim-detail/SignatureRequests.tsx',
  ]),
  selector_preserved: true,
  signing_engine_untouched: true,
  not_staging_wholesale: true,
  staging_spa_not_deployed: '/assets/index-BgpqIBFW.js',
  branch: 'cursor/sig-mobile-composer-prod-ad99',
});
