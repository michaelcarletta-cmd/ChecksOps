# Guarded staging SPA upload

`.github/workflows/guarded-staging-spa-upload.yml` builds `main` for
`https://staging.checksops.com` and uploads it through the official
receipt-gated writer `scripts/deployment-guard/staging-spa-upload.mjs`.
It never targets production and never syncs or deletes bucket objects.

## One-time setup (owner)

1. Create IAM role `ChecksOpsGitHubStagingSpaUpload` in account `806168576068`:
   - trust policy: `aws/staging-spa-upload/policies/trust-policy.json`
     (GitHub OIDC, `repo:michaelcarletta-cmd/ChecksOps:environment:staging` only)
   - permissions: `aws/staging-spa-upload/policies/permissions-policy.json`,
     replacing `REPLACE_WITH_CHECKSOPS_STAGING_DEPLOYMENT_GUARD_KMS_KEY_ARN`
     with the staging deployment-guard KMS key ARN. The key policy must also
     allow this role `kms:Sign` and `kms:GetPublicKey`.
2. In the GitHub `staging` environment, add variables:
   - `CHECKSOPS_STAGING_SPA_DEPLOY_ROLE_ARN` =
     `arn:aws:iam::806168576068:role/ChecksOpsGitHubStagingSpaUpload`
   - `STAGING_SPA_VITE_APP_URL` = `https://staging.checksops.com`
   - `STAGING_SPA_VITE_AUTH_PROVIDER` = `cognito`
   - `STAGING_SPA_VITE_CHECKSOPS_API_URL`, `STAGING_SPA_VITE_AWS_REGION`,
     `STAGING_SPA_VITE_COGNITO_USER_POOL_ID`,
     `STAGING_SPA_VITE_COGNITO_USER_POOL_CLIENT_ID`: the staging values from
     the uncommitted `.env.aws`. These are public identifiers, not secrets.
   - `CHECKSOPS_STAGING_DEPLOYMENT_GUARD_KMS_KEY_ARN` is already used by the
     Lambda overlay workflow.
3. Keep required reviewers on the `staging` environment.

## Each upload

1. Run the workflow from `main` with `mode: inspect`. Note the live
   index.html SHA-256 and entry bundle in the run summary.
2. Run it again with `mode: apply`, `approved_commit` = the current `main`
   SHA and `expected_live_index_sha256` = the value from step 1.
3. The apply job stops before any write if:
   - `main` moved or the commit is not the approved one
   - live index.html changed since the inspect (`DEPLOYMENT_COLLISION`)
   - the build is not for `staging.checksops.com` with Cognito, or has Supabase settings
   - the candidate entry bundle equals the live one
   - any accepted `staging-frontend` `spa-promote` contract test fails
     (`REGRESSION_DETECTED`); every contract test is executed, none assumed
4. Otherwise it takes the `staging-frontend` lease, issues a KMS-signed
   receipt, uploads assets then index.html, invalidates the staging
   distribution, and confirms the public site serves the new entry bundle.

Never re-run apply to put an older build back. A newer `main` build is the
only forward path.
