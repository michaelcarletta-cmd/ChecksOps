# Production-prep live resources (no cutover)

Account `806168576068`, region `us-east-1`. Verified 2026-09-05.

| Resource | Id / name | Cutover status |
|---|---|---|
| Cognito pool | `us-east-1_h00WorYMT` | Prepared, **0 users**, MFA OFF, WebAuthn RP `checksops.com`, EMAIL `COGNITO_DEFAULT` |
| Staging Cognito (do not reuse) | `us-east-1_vPmQ7cL1F` | WebAuthn RP still `staging.checksops.com` |
| Cognito client | `3ja9fqaq2fjkv3i6up2varcqpe` | Not in `.env.production` |
| Frontend bucket | `checksops-production-frontend-806168576068` | Placeholder only |
| CloudFront | `E1B0ZWWO5559U5` / `dmgs35lzv89ms.cloudfront.net` | Aliases **0** |
| ACM | `5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3` | `PENDING_VALIDATION` — validation CNAMEs not in DNS; apex A unchanged |
| Prep API | `checksops-production-prep-api` | `https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep` |
| Prep API role | `checksops-staging-ApiFunctionRole-7E7XRyLe3nyi` (live, shared until Batch 1 IAM grant) | Intended dedicated role `checksops-production-api-execution` in `api-execution-role.yaml` |
| Log group | `/aws/lambda/checksops-production-prep-api` | Metric filters attached |
| Artifacts bucket | `checksops-production-prep-artifacts-806168576068` | Private Lambda zip |

Apex/`www` A records remain `185.158.133.1`. Staging Lambda **not** overlaid.

## CloudWatch inspectability

`ChecksOpsCursorCloudStaging` is denied `cloudwatch:PutMetricAlarm` / `DescribeAlarms` / `DeleteAlarms`. Inspect:

```bash
curl -sS https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep/health
curl -sS https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep/ops/readiness
aws logs describe-metric-filters --log-group-name /aws/lambda/checksops-production-prep-api
aws cloudformation describe-stacks --stack-name checksops-production-prep-api --query 'Stacks[0].Outputs'
```
