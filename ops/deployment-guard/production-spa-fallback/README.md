# Production SPA fallback role (owner creates it; not created by this PR)

`ChecksOpsGitHubProductionSpaFallback` is the only identity `guarded-production-spa-fallback.yml`
uses (`ops/deployment-guard/PRODUCTION_SPA_FALLBACK.md`). It can read the production distribution,
read, test, update and publish the one CloudFront Function `checksops-production-spa-fallback`,
read the marketing page objects and `index.html` in the production bucket, and sign guard receipts
with the production deployment-guard key. Nothing else.

| File | What it is |
|---|---|
| `trust-policy.json` | GitHub OIDC trust: this repository, the `production` environment, `refs/heads/main`, and only this workflow file |
| `permissions-policy.json` | inline permissions (least privilege, explicit denies) |

## Trust

The same conditions as the production CSP headers role
(`ops/deployment-guard/production-csp-headers/README.md`), with the workflow file pinned to this
tool. STS validates GitHub's own claims as condition keys, so the role pins them directly with the
default subject:

- `aud` = `sts.amazonaws.com`, `sub` = `repo:michaelcarletta-cmd/ChecksOps:environment:production`;
- `repository_id` = `1231339992` and `repository_owner_id` = `248244651`;
- `environment` = `production`, `ref` = `refs/heads/main`;
- `job_workflow_ref` = `michaelcarletta-cmd/ChecksOps/.github/workflows/guarded-production-spa-fallback.yml@refs/heads/main`.

A run of any other workflow, branch or environment cannot assume it, on top of the production
environment's own rules (owner the only reviewer, `main` only, no administrator bypass).

## Permissions

- `cloudfront:GetDistribution` on `distribution/E1B0ZWWO5559U5` (the writer reads the config and
  the function association with get-distribution).
- `cloudfront:DescribeFunction`, `cloudfront:GetFunction`, `cloudfront:UpdateFunction`,
  `cloudfront:TestFunction`, `cloudfront:PublishFunction` on
  `function/checksops-production-spa-fallback` only.
- `s3:GetObject` on exactly these keys of `checksops-production-frontend-806168576068`: `pricing`,
  `vs/checksops-vs-iink-payments`, `vs/checksops-vs-snapsheet`,
  `vs/checksops-vs-guidewire-claimcenter`, `claim-check-tracking`, `index.html`. HeadObject is
  authorized by `s3:GetObject`. Without `s3:ListBucket`, a missing key answers 403 rather than
  404; the writer treats either as missing.
- `kms:Sign` (ECDSA_SHA_256) and `kms:GetPublicKey` on the key whose alias is
  `alias/checksops-production-deployment-guard`, by `kms:ResourceAliases`.
- Explicit denies: no function create or delete, no distribution create, update or delete (so no
  association change), no invalidation; nothing on the staging distribution or the staging bucket;
  no S3 write; no IAM.

The workflow narrows each session further with an inline session policy: inspect has no update,
test or publish and no KMS action.

When a marketing page is added to `MARKETING_PAGES`, its key must be added here, to both inline
session policies in the workflow and to `MARKETING_PATHS` in the writer (the tests fail until all
of them agree), and the owner re-runs `put-role-policy`.

## Create it (owner, once)

In account `806168576068`, as an administrator:

```bash
aws iam create-role --role-name ChecksOpsGitHubProductionSpaFallback \
  --description "ChecksOps guarded-production-spa-fallback.yml: CloudFront Function checksops-production-spa-fallback" \
  --assume-role-policy-document file://ops/deployment-guard/production-spa-fallback/trust-policy.json \
  --max-session-duration 3600
aws iam put-role-policy --role-name ChecksOpsGitHubProductionSpaFallback \
  --policy-name ChecksOpsProductionSpaFallback \
  --policy-document file://ops/deployment-guard/production-spa-fallback/permissions-policy.json
```

Then in GitHub, Settings, Environments, `production`, add the variable
`CHECKSOPS_PRODUCTION_SPA_FALLBACK_ROLE_ARN` =
`arn:aws:iam::806168576068:role/ChecksOpsGitHubProductionSpaFallback`.
`CHECKSOPS_PRODUCTION_DEPLOYMENT_GUARD_KMS_KEY_ARN` is already set for the other production tools.

The production deployment-guard key's policy must let this role sign. If it delegates to IAM, the
inline policy above is enough; if it names roles, add this role to it the same way the overlay role
is named. A failed `kms:Sign` stops the run before any write.

Check: a `mode: inspect` run reaches "Verify AWS identity" with
`assumed-role/ChecksOpsGitHubProductionSpaFallback/checksops-production-spa-fallback-<run id>`. If
STS refuses the web identity, compare the trust conditions with the run's token claims; do not
widen them without a reviewed PR.
