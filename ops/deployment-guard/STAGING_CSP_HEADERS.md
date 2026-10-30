# Guarded staging CSP headers

`.github/workflows/guarded-staging-csp-headers.yml` is SPA CSP rollout step 1
(`ops/security/SPA_CSP_ROLLOUT.md`): a report-only Content-Security-Policy on
`https://staging.checksops.com`. It touches only staging distribution `E1CG52WRQZI7X1`:

- **inspect** reads the distribution, the policy `checksops-staging-browser-security-headers` (if it
  exists) and the live staging `index.html`, and prints the state, the snapshot SHA-256 and the exact
  `Content-Security-Policy-Report-Only` value the apply would set.
- **apply** ("ATTACH REPORT-ONLY CSP TO STAGING") creates or updates that policy from
  `aws/staging/cloudfront-security-headers.yaml`, with the CSP built by
  `scripts/deployment-guard/lib/spa-csp.mjs` from the live `index.html` (so the inline-script hash
  matches what is served), and sets it on the default behavior. If the policy is already attached but
  out of date (for example a new inline script), apply updates the policy only.
- **rollback** ("DETACH CSP FROM STAGING") puts the default behavior back to no response headers
  policy, its state before the first attach (read 2026-10-30). The policy object stays.

The writer `scripts/deployment-guard/staging-csp-headers.mjs` refuses any other distribution and the
production policy `756a8f23-68dd-4f8a-8293-5a2fd08f919a`, never sets an enforcing
`ContentSecurityPolicy`, sends If-Match ETags, and fails if the distribution config changed in
anything but `DefaultCacheBehavior.ResponseHeadersPolicyId`. Test:
`aws/tests/github-staging-csp-headers.test.mjs`.

## One-time setup (owner)

The role does not exist yet (`NoSuchEntity`, read 2026-10-30); none of the existing staging roles can
read or change CloudFront configuration.

1. Create IAM role `ChecksOpsGitHubStagingCspHeaders` in account `806168576068`:
   - trust policy: `aws/staging-csp-headers/policies/trust-policy.json` (GitHub OIDC,
     `repo:michaelcarletta-cmd/ChecksOps:environment:staging` only, as every staging role);
   - permissions: `aws/staging-csp-headers/policies/permissions-policy.json`. It allows Get/Update on
     the staging distribution only, creating and updating response headers policies, reading the
     staging `index.html` and signing staging guard receipts with the staging key (its key policy
     delegates to IAM). It denies any action on the production distribution and any update or
     delete of the production policy. No IAM, no other distribution, no S3 write.
2. In the GitHub `staging` environment, add the variable
   `CHECKSOPS_STAGING_CSP_HEADERS_ROLE_ARN` =
   `arn:aws:iam::806168576068:role/ChecksOpsGitHubStagingCspHeaders`.
   `CHECKSOPS_STAGING_DEPLOYMENT_GUARD_KMS_KEY_ARN` is already set.
3. The `staging` environment's branch rule (main only) is what keeps other branches from assuming the
   role, as for the staging SPA upload (`STAGING_SPA_UPLOAD.md`). The workflow also narrows every
   session with an inline policy: read-only for inspect.

## Each change

1. Run the workflow from `main` with `mode: inspect`. Note the state (`READY` before the first
   attach), the snapshot SHA-256 and the CSP value in the run summary.
2. Run it with `mode: apply`, `approved_commit` = the current `main` SHA, `expected_snapshot_sha256`
   = the value from step 1 and `approval_phrase` = `ATTACH REPORT-ONLY CSP TO STAGING`.
3. The run stops before any write if `main` moved, the phrase differs, or the distribution, the
   policy or the live `index.html` changed since the inspect (`DEPLOYMENT_COLLISION`). It shares the
   staging SPA upload's concurrency group and lease (`staging-frontend`).
4. After the write it re-reads and verifies, then checks that `https://staging.checksops.com/` serves
   `Content-Security-Policy-Report-Only` (and no enforcing `Content-Security-Policy`).

Rollback is the same with `mode: rollback` and `DETACH CSP FROM STAGING`.
