/**
 * Frozen staging SPA after the accepted signature Step 3 mobile layout fix.
 * Staging only. Do not promote to production until explicitly approved.
 */
export const ACCEPTED_STAGING_SIGNATURE_STEP3_MOBILE_SPA = Object.freeze({
  host: 'https://staging.checksops.com',
  spa_bundle: '/assets/index-tfpHiJF1.js',
  spa_sha256: '999ea45beff8b5c8ba37af838d50278b7f3442f1e63a5af05025f4dc83ee4134',
  css_bundle: '/assets/index-B3qBpKXU.css',
  index_html_sha256: 'e817f24de17dab920c4f3114cf9d1a3991b69ac31f9dd46258358ced3b7b3a82',
  field_placement_chunk: '/assets/FieldPlacementEditor-Cd9gg67z.js',
  check_files_chunk: '/assets/CheckFilesSection-BWAq5PEq.js',
  sign_chunk: '/assets/Sign-Dyd1WkSg.js',
  s3_bucket: 'checksops-staging-frontend-c48b',
  cloudfront_id: 'E1CG52WRQZI7X1',
  cloudfront_invalidation_id: 'I5MOXCJO9YXKHCJVVW5RDKP5WU',
  accepted_at: '2026-09-28T14:10:00Z',
  branch: 'cursor/sig-step3-mobile-ad99',
  deploy_mode: 'per_object_put',
  upload_count: 108,
  staging_lambda: 'checksops-staging-api',
  staging_lambda_sha: 'nTisqcTLXpgw0Ej9kl7PosXn9a+BYcdBRSEvb5IIh5s=',
  overlay_from: '/assets/index-BgpqIBFW.js',
  production_untouched: Object.freeze({
    spa_bundle: '/assets/index-BkzeBHTL.js',
    spa_sha256: 'e6f1fd9d97aa31d1ad705bfaf14004dff004159c87027c4848b9793c2181e787',
    index_html_sha256: 'c85afc1a685e551810259d4bc179a06dd10043eaa9e05b2de272757ea3292de7',
    index_version_id: 'cknrbiGObviCUsPCB58bSOyeLta87W2V',
    api: 'gHoAYTlh/WLTAovN7/hfwuvmBNuMjKZaC+zMzBsAOSw=',
  }),
  files_included: Object.freeze([
    'src/components/claim-detail/SignatureRequests.tsx',
    'tests/signature-field-coordinates.test.ts',
    'scripts/sig-wizard-mobile-fixture.html',
    'scripts/capture-sig-wizard-mobile-fixture.mjs',
  ]),
  selector_preserved: true,
  step2_composer_preserved: true,
  signing_engine_untouched: true,
  production_untouched_flag: true,
});
