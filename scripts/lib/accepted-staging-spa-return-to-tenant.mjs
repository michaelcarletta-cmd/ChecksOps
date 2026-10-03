/**
 * Frozen staging SPA after the accepted Mortgage Desk return-to-tenant deploy.
 * Use this pin for any later production promotion. Do not treat an older
 * staging bundle as the accepted artifact.
 *
 * Staging only. Production remains untouched.
 */
export const ACCEPTED_STAGING_RETURN_TO_TENANT_SPA = Object.freeze({
  host: 'https://staging.checksops.com',
  spa_bundle: '/assets/index-CsINqV3T.js',
  spa_sha256: '29994d35d5d3402b3ad7822c52e9a103dfd62ad172cfbce2e1a04ef18cbc6229',
  css_bundle: '/assets/index-iCMGPXk5.css',
  index_html_sha256: '5be397647cb6baf7b82cadaf3df32ae8c7963012faf38e0cae5cc446538d8357',
  s3_etag: '81e2f78937ce902df3587455133d2f4b',
  s3_bucket: 'checksops-staging-frontend-c48b',
  cloudfront_id: 'E1CG52WRQZI7X1',
  last_modified: 'Sun, 27 Sep 2026 18:09:39 GMT',
  accepted_at: '2026-09-27T18:09:39Z',
  source_git_sha: 'c0320125898aedfeb382df12d404cef8c4f97e7f',
  branch: 'cursor/mortgage-desk-return-tenant-ad99',
  deploy_mode: 'per_object_put',
  staging_lambda_sha: '/E0seEu57bvTZ9RuVQgQ8obE684BHCF4mQqqUfsMQC8=',
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
