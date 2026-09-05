# Monitoring / CloudWatch / health checks (cutover window)

**Do not deploy a production alarm stack from this PR.**  
Example template (not attached to production): `production/cloudwatch-alarms.example.yaml`.

## What is live today (staging)

| Signal | Status |
|---|---|
| `GET /health` | **GO** — 200, `productionSupabaseChanged=false` |
| `GET /db-health` | **GO** — RDS private, `checksops` / `transactionReadOnly=on` |
| Lambda tracing | **GO** — SAM `Tracing: Active` |
| `GET /ops/readiness` | **PARTIAL** — implemented; live staging Lambda still 404 until a later overlay (do **not** overlay from this branch; CheckAlt work is separate) |
| CloudWatch alarms | **PARTIAL** — example YAML plus production-prep Errors alarm (optional CFN). Agent role `ChecksOpsCursorCloudStaging` is denied `cloudwatch:DescribeAlarms` and `cloudwatch:GetMetricStatistics` |
| Production-prep log group | **GO (inspectable)** — `/aws/lambda/checksops-production-prep-api` via `logs:DescribeLogGroups` / stack outputs |
| Production alarms | **PARTIAL** — inspect via CloudFormation outputs, not DescribeAlarms |

## Cutover-night dashboard (operator)

Watch, in order:

1. Lambda `checksops-*-api` Errors, Throttles, Duration (p99 vs 29s timeout).
2. HTTP API 5xx / 4xx on `/auth/*`, `/webhooks/*`, `/health`.
3. Cognito `UserAuthentication` failures + `/identity/me` `identity_not_linked`.
4. RDS CPU / connections / `transaction_read_only` unexpected changes.
5. Webhook receipts vs `applied` (must stay false until T7).
6. Financial aggregate query vs T0 snapshot.

## Health gates that must stay green

- `/health` 200 after any Lambda code change
- Flags remain false until T7
- If `/health` goes 500: roll back **that** Lambda `CodeSha256` immediately (do not continue cutover)

## IAM gap to close later (not this PR)

Grant a dedicated ops role (not the Cloud Agent staging role) `cloudwatch:DescribeAlarms`, `cloudwatch:GetMetricStatistics`, and SNS publish for the production alarm topic. Do not broaden `ChecksOpsCursorCloudStaging` automatically.

Inspect production-prep health without those APIs:

```bash
aws cloudformation describe-stacks --stack-name checksops-production-prep --query 'Stacks[0].Outputs'
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/checksops-production-prep
```
