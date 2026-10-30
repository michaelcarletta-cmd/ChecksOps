# Guarded staging CSP headers

`.github/workflows/guarded-staging-csp-headers.yml` is SPA CSP rollout steps 1 and 3
(`ops/security/SPA_CSP_ROLLOUT.md`): a report-only, then an enforcing, Content-Security-Policy on
`https://staging.checksops.com`. It touches only staging distribution `E1CG52WRQZI7X1`:

- **inspect** reads the distribution, the policy `checksops-staging-browser-security-headers` (if it
  exists) and the live staging `index.html`, and prints the state (`READY`, `ATTACHED_CURRENT`,
  `ATTACHED_STALE`, `ENFORCING_CURRENT`, `ENFORCING_STALE` or `BLOCKED`), the snapshot SHA-256 and
  the exact `Content-Security-Policy-Report-Only` and enforcing `Content-Security-Policy` values a
  change would set.
- **apply** ("ATTACH REPORT-ONLY CSP TO STAGING") creates or updates that policy from
  `aws/staging/cloudfront-security-headers.yaml`, with the CSP built by
  `scripts/deployment-guard/lib/spa-csp.mjs` from the live `index.html` (so the inline-script hash
  matches what is served), and sets it on the default behavior. If the policy is already attached but
  out of date (for example a new inline script), apply updates the policy only. Refused while the
  policy is enforcing.
- **enforce** ("ENFORCE CSP ON STAGING", from `ATTACHED_CURRENT` or `ENFORCING_STALE`) updates the
  attached policy only: the same directives plus `upgrade-insecure-requests` in
  `SecurityHeadersConfig.ContentSecurityPolicy` (Override true), no
  `Content-Security-Policy-Report-Only` header, comment "Production baseline headers plus an
  enforcing CSP (staging step 3)." The enforcing config is derived from the template
  (`desiredPolicyConfig(indexHtml, template, { enforce: true })`), not a second template.
- **revert** ("REVERT CSP TO REPORT-ONLY ON STAGING", from `ENFORCING_CURRENT` or `ENFORCING_STALE`)
  updates the attached policy only, back to exactly the report-only config apply sets.
- **rollback** ("DETACH CSP FROM STAGING", from any attached state of ours, enforcing included) puts
  the default behavior back to no response headers policy, its state before the first attach (read
  2026-10-30). The policy object stays.

The writer `scripts/deployment-guard/staging-csp-headers.mjs` refuses any other distribution and the
production policy `756a8f23-68dd-4f8a-8293-5a2fd08f919a`, sets an enforcing `ContentSecurityPolicy`
only on enforce and only equal to `buildCsp(..., { enforce: true })` of the live `index.html`, sends
If-Match ETags, and fails if the distribution config changed in anything but
`DefaultCacheBehavior.ResponseHeadersPolicyId` (enforce and revert: in anything at all). An enforcing
CSP that is not ours (any other value, `Override` false, an extra field) is `BLOCKED`. Test:
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
   `Content-Security-Policy-Report-Only` (and no enforcing `Content-Security-Policy`); after enforce,
   exactly the enforcing `Content-Security-Policy` from the preflight and no report-only header;
   after rollback, neither.

Enforce, revert and rollback are the same with their mode and phrase: `ENFORCE CSP ON STAGING`,
`REVERT CSP TO REPORT-ONLY ON STAGING`, `DETACH CSP FROM STAGING`. The role needs no change for
enforce or revert: `permissions-policy.json` already allows `cloudfront:UpdateResponseHeadersPolicy`
on `response-headers-policy/*` and denies it on the production policy.

## Run log

- **2026-10-30, apply run 41067994638** (main `ee57c5ec2`, owner: "ATTACH REPORT-ONLY CSP TO STAGING",
  after inspect run 41067803191 reported `READY`, snapshot `c29a036e…`). The writer created policy
  `d3f84b15-c4db-481c-98cb-64eb541619fe` (`checksops-staging-browser-security-headers`, 14:01:08Z)
  and attached it to the default behavior (distribution ETag `E1VC38T7YXB528`); its check that the
  distribution changed only in `ResponseHeadersPolicyId` passed. It then stopped with
  `policy_post_verify_failed`: CloudFront returns the headers the policy does not set as empty
  objects (`XSSProtection: {}`, `ContentSecurityPolicy: {}`), which the template omits, and the
  comparison counted them as a difference. Every set field matched. The same echo made inspect read
  the empty `ContentSecurityPolicy` as an enforcing one (`BLOCKED`, `policy_has_unowned_settings`),
  which also refused rollback. The owner kept the policy attached; the comparison now drops empty
  sections (an enforcing CSP or any other set field still counts). The public header check of that
  run did not run; the next read-only inspect is the confirmation (expected `ATTACHED_CURRENT`).
