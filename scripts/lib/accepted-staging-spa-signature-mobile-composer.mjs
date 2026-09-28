/**
 * Frozen staging SPA after the accepted signature mobile composer deploy.
 * Staging only. Do not promote to production until explicitly approved.
 */
export const ACCEPTED_STAGING_SIGNATURE_MOBILE_COMPOSER_SPA = Object.freeze({
  host: 'https://staging.checksops.com',
  spa_bundle: '/assets/index-BgpqIBFW.js',
  spa_sha256: '62597d9ee64708dc0acec6f472508beb9e3b85dcafc6068e1fe124b9958d2315',
  css_bundle: '/assets/index-ZNQ1RHaw.css',
  index_html_sha256: '199bdb6cf52641d4313e326bb5bbd7cb6746728f2ed3707182e1072365a62b07',
  field_placement_chunk: '/assets/FieldPlacementEditor-B-deROnA.js',
  check_files_chunk: '/assets/CheckFilesSection-B6G18llN.js',
  sign_chunk: '/assets/Sign-DB3IeKYI.js',
  s3_bucket: 'checksops-staging-frontend-c48b',
  cloudfront_id: 'E1CG52WRQZI7X1',
  cloudfront_invalidation_id: 'I5V9Z3QJQ02M0WD7WJDPX0MS5E',
  accepted_at: '2026-09-28T12:02:00Z',
  spa_source_git_sha: 'c5508d8a0a27b49ca96f409b17a28ed67cfb8f44',
  branch: 'cursor/sig-mobile-composer-ad99',
  deploy_mode: 'per_object_put',
  staging_lambda: 'checksops-staging-api',
  staging_lambda_sha: 'nTisqcTLXpgw0Ej9kl7PosXn9a+BYcdBRSEvb5IIh5s=',
  overlay_from: '/assets/index-gNnhTSog.js',
  production_untouched: Object.freeze({
    spa_bundle: '/assets/index-DRoG4LeT.js',
    spa_sha256: '97998b6014bdbd1ddc387bf18c68cd6347ca5fea0bdf85321f59a2a0d11e64aa',
    index_html_sha256: 'a21d4bfb3481978e1328c0d39ebf2a387901faa21810bd978be65e77900135d1',
    index_version_id: 'nsdZAqxVImyWhdQSY8A.w_qGjbO_xhgM',
    api: 'gHoAYTlh/WLTAovN7/hfwuvmBNuMjKZaC+zMzBsAOSw=',
  }),
  files_included: Object.freeze([
    'src/lib/signature-field-coordinates.ts',
    'tests/signature-field-coordinates.test.ts',
    'src/components/claim-detail/FieldPlacementEditor.tsx',
    'src/components/claim-detail/SignatureRequests.tsx',
    'scripts/deploy-staging-signature-mobile-composer-spa.mjs',
  ]),
  selector_preserved: true,
  signing_engine_untouched: true,
  production_untouched_flag: true,
});
