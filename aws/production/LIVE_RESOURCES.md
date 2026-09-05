# Production-prep live resources (no cutover)

Snapshot of AWS objects created for production **prep**. None of these are wired to `checksops.com` DNS or Lovable auth.

Account `806168576068`, region `us-east-1`. Verified 2026-09-05.

| Resource | Id / name | Cutover status |
|---|---|---|
| Cognito pool | `us-east-1_h00WorYMT` (`checksops-production`) | Prepared, **0 users**, not switched |
| Staging Cognito (do not reuse) | `us-east-1_vPmQ7cL1F` | Live staging only |
| Cognito client | `3ja9fqaq2fjkv3i6up2varcqpe` (`checksops-production-web`) | Prepared, not in `.env.production` |
| Frontend bucket | `checksops-production-frontend-806168576068` | Prepared; placeholder `index.html` only |
| CloudFront | `E1B0ZWWO5559U5` / `dmgs35lzv89ms.cloudfront.net` | **Aliases quantity 0.** Deployed |
| ACM | `arn:aws:acm:us-east-1:806168576068:certificate/5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3` | `PENDING_VALIDATION` |
| API log group | `/aws/lambda/checksops-production-prep-api` | Retention 30d; inspect via `DescribeLogGroups` |
| API Lambda/HTTP | not created | Agent IAM denied `iam:GetRole` / `iam:DetachRolePolicy`. Templates `api-template.yaml` (SAM) and `api-cfn.yaml` (vanilla) are ready. Flags false. |
| Artifacts bucket | `checksops-production-prep-artifacts-806168576068` | Private; holds Lambda zip for a later operator deploy |
| Leftover OAC | `checksops-production-frontend-oac` | Unused; live OAC is `checksops-production-frontend-oac-prep2` |
| Possible leftover IAM role | `checksops-production-prep-api-role` | CREATE_FAILED / rollback could not detach policies. Operator with IAM should delete or import before the next API deploy. |

Apex/`www` A records remain `185.158.133.1` (Lovable). Staging CloudFront `E1CG52WRQZI7X1` still aliases only `staging.checksops.com`.

## CloudWatch inspectability

`ChecksOpsCursorCloudStaging` is denied `cloudwatch:DescribeAlarms` / `PutMetricAlarm` / `GetMetricStatistics`. Inspect instead:

```bash
aws cloudformation describe-stacks --stack-name checksops-production-prep \
  --query 'Stacks[0].Outputs'
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/checksops-production-prep
```

Grant a dedicated **ops** role (not this Cloud Agent role) CloudWatch alarm APIs **and** `iam:CreateRole` / `iam:GetRole` / `iam:PassRole` for the production-prep Lambda role.
