# Production CSP headers role (owner creates it; not created by this PR)

`ChecksOpsGitHubProductionCspHeaders` is the only identity `guarded-production-csp-headers.yml`
uses (`ops/deployment-guard/PRODUCTION_CSP_HEADERS.md`). It can read the production distribution,
read and update the one production response headers policy, read the live production `index.html`,
and sign guard receipts with the production deployment-guard key. Nothing else.

| File | What it is |
|---|---|
| `trust-policy.json` | GitHub OIDC trust: this repository, the `production` environment, `refs/heads/main`, and only this workflow file |
| `permissions-policy.json` | inline permissions (least privilege, explicit denies) |

## Trust (finding 11)

Finding 11 (`ops/deployment-guard/github-oidc-trust/README.md`) noted that the existing roles trust
any run in their environment, and that pinning the workflow file would have needed a customized
OIDC subject claim. Since January 2026 STS validates GitHub's own claims as condition keys
(IAM User Guide, "Available keys for AWS OIDC federation", GitHub tab: `job_workflow_ref`,
`repository_id`, `repository_owner_id`, `ref`, `environment`), so this role pins them directly with
the default subject; no repository-wide subject customization (which would change the `sub` the
other three roles match):

- `aud` = `sts.amazonaws.com`, `sub` = `repo:michaelcarletta-cmd/ChecksOps:environment:production`;
- `repository_id` = `1231339992` and `repository_owner_id` = `248244651` (immutable ids, read
  2026-10-31 from the GitHub API: the repository record and the owner's account id);
- `environment` = `production`, `ref` = `refs/heads/main`;
- `job_workflow_ref` = `michaelcarletta-cmd/ChecksOps/.github/workflows/guarded-production-csp-headers.yml@refs/heads/main`.

A run of any other workflow, branch or environment cannot assume it, on top of the production
environment's own rules (owner the only reviewer, `main` only, no administrator bypass).

## Permissions

- `cloudfront:GetDistribution` on `distribution/E1B0ZWWO5559U5` (the writer reads the config with
  get-distribution; it never needs GetDistributionConfig).
- `cloudfront:GetResponseHeadersPolicy`, `cloudfront:UpdateResponseHeadersPolicy` on
  `response-headers-policy/756a8f23-68dd-4f8a-8293-5a2fd08f919a` only.
- `s3:GetObject` on `checksops-production-frontend-806168576068/index.html` only.
- `kms:Sign` (ECDSA_SHA_256) and `kms:GetPublicKey` on the key whose alias is
  `alias/checksops-production-deployment-guard` (the key behind
  `CHECKSOPS_PRODUCTION_DEPLOYMENT_GUARD_KMS_KEY_ARN`), by `kms:ResourceAliases`.
- Explicit denies: no distribution create, update or delete, no policy create or delete, no
  invalidation, nothing on the staging distribution or the staging policy. No IAM, no S3 write.

The workflow narrows each session further with an inline session policy: inspect has no update and
no KMS action.

## Create it (owner, once)

In account `806168576068`, as an administrator:

```bash
aws iam create-role --role-name ChecksOpsGitHubProductionCspHeaders \
  --description "ChecksOps guarded-production-csp-headers.yml: in-place CSP on policy 756a8f23" \
  --assume-role-policy-document file://ops/deployment-guard/production-csp-headers/trust-policy.json \
  --max-session-duration 3600
aws iam put-role-policy --role-name ChecksOpsGitHubProductionCspHeaders \
  --policy-name ChecksOpsProductionCspHeaders \
  --policy-document file://ops/deployment-guard/production-csp-headers/permissions-policy.json
```

Then in GitHub, Settings, Environments, `production`, add the variable
`CHECKSOPS_PRODUCTION_CSP_HEADERS_ROLE_ARN` =
`arn:aws:iam::806168576068:role/ChecksOpsGitHubProductionCspHeaders`.
`CHECKSOPS_PRODUCTION_DEPLOYMENT_GUARD_KMS_KEY_ARN` is already set for the other production tools.

The production deployment-guard key's policy must let this role sign. If it delegates to IAM (as
the staging key's does), the inline policy above is enough; if it names roles, add this role to
it the same way the overlay role is named. A failed `kms:Sign` stops the run before any write.

Check: a `mode: inspect` run reaches "Verify AWS identity" with
`assumed-role/ChecksOpsGitHubProductionCspHeaders/checksops-production-csp-<run id>`. If STS
refuses the web identity, compare the trust conditions with the run's token claims; do not widen
them without a reviewed PR.
