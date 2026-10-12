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
   - `CHECKSOPS_STAGING_SPA_INSPECT_ROLE_ARN` is already set for
     `inspect-staging-spa.yml` and is reused for `mode: inspect`.
   - `STAGING_SPA_VITE_APP_URL` = `https://staging.checksops.com`
   - `STAGING_SPA_VITE_AUTH_PROVIDER` = `cognito`
   - `STAGING_SPA_VITE_CHECKSOPS_API_URL`, `STAGING_SPA_VITE_AWS_REGION`,
     `STAGING_SPA_VITE_COGNITO_USER_POOL_ID`,
     `STAGING_SPA_VITE_COGNITO_USER_POOL_CLIENT_ID`: the staging values from
     the uncommitted `.env.aws`. These are public identifiers, not secrets.
   - `CHECKSOPS_STAGING_DEPLOYMENT_GUARD_KMS_KEY_ARN` is already used by the
     Lambda overlay workflow.
3. **Required:** lock the GitHub `staging` environment (Settings → Environments → staging):
   - **Deployment branches and tags:** "Selected branches and tags", allowing only `main`.
   - **Required reviewers:** keep them on.

   AWS can only check the token's `sub` (`repo:michaelcarletta-cmd/ChecksOps:environment:staging`)
   and `aud`; it cannot see which workflow file or branch is running. Without the
   branch rule, any workflow on any branch that requests the `staging`
   environment could assume `ChecksOpsGitHubStagingSpaUpload` and skip this
   workflow's checks. The workflow's inline session policy narrows every
   session to the actions in `permissions-policy.json`, but the branch rule is what keeps
   other branches out.

   Stricter option: customize the repository's OIDC subject claim to include
   `job_workflow_ref`, then pin the trust policy `sub` to
   `.github/workflows/guarded-staging-spa-upload.yml@refs/heads/main`. That
   changes the subject for **every** role this repository assumes
   (`ChecksOpsGitHubStagingLambdaOverlay`, `ChecksOpsGitHubStagingSpaInspect`,
   `ChecksOpsGitHubProductionReadOnlyInspect`), so those trust policies must
   be updated in the same change.

## Each upload

1. Run the workflow from `main` with `mode: inspect`. It uses only the
   read-only `ChecksOpsGitHubStagingSpaInspect` role (`s3:GetObject` on
   staging `index.html`). Note the live index.html SHA-256 and entry bundle
   in the run summary.
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
