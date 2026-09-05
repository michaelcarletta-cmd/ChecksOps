# Production-prep live resources (no cutover)

Snapshot of AWS objects created for production **prep**. None of these are wired to `checksops.com` DNS or Lovable auth.

Account `806168576068`, region `us-east-1`.

| Resource | Id / name | Cutover status |
|---|---|---|
| Cognito pool | `us-east-1_h00WorYMT` (`checksops-production`) | Prepared, **0 users**, not switched |
| Staging Cognito (do not reuse) | `us-east-1_vPmQ7cL1F` | Live staging only |
| Cognito client | `checksops-production-web` (stack output `ProductionUserPoolClientId`) | Prepared, not in `.env.production` |
| Frontend bucket | `checksops-production-frontend-806168576068` | Prepared, no SPA upload required for this PR |
| CloudFront | stack output `ProductionCloudFrontId` / `ProductionCloudFrontDomain` | **No** `checksops.com` / `www` aliases |
| ACM | `arn:aws:acm:us-east-1:806168576068:certificate/5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3` | `PENDING_VALIDATION` — operator DNS CNAMEs later |
| API log group | `/aws/lambda/checksops-production-prep-api` | Inspectable via `logs:DescribeLogGroups` |
| API stack | `checksops-production-prep-api` | Separate from `checksops-staging`; flags false |
| Leftover OAC | `checksops-production-frontend-oac` | Unused; new OAC is `checksops-production-frontend-oac-prep2` |

Apex/`www` A records remain `185.158.133.1` (Lovable).

## CloudWatch inspectability

`ChecksOpsCursorCloudStaging` is denied `cloudwatch:DescribeAlarms` / `PutMetricAlarm` / `GetMetricStatistics`. Inspect instead:

```bash
aws cloudformation describe-stacks --stack-name checksops-production-prep \
  --query 'Stacks[0].Outputs'
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/checksops-production-prep
# After API stack:
aws cloudformation describe-stacks --stack-name checksops-production-prep-api \
  --query 'Stacks[0].Outputs'
```

Grant a dedicated **ops** role (not this Cloud Agent role) CloudWatch alarm APIs later.
