# Monitoring / CloudWatch / health checks (cutover window)

Inspect-only production-prep alarms live in `aws/production/cloudwatch-alarms.yaml` (`ActionsEnabled=false`).  
The older example file remains unused: `production/cloudwatch-alarms.example.yaml` (**DO NOT DEPLOY**).

Operator inspect IAM: `aws/production/iam/OPERATOR_CLOUDWATCH_IAM.md`. The Cloud Agent role cannot `DescribeAlarms` until a human attaches that policy.

## What is live today (staging + prep)

| Signal | Status |
|---|---|
| `GET /health` | **GO** — 200, `productionSupabaseChanged=false` |
| `GET /db-health` | **GO** — RDS private, `checksops` / `transactionReadOnly=on` |
| Lambda tracing | **GO** — SAM `Tracing: Active` |
| `GET /ops/readiness` | **PARTIAL** — implemented in git; live staging Lambda still 404 until a later overlay (do **not** overlay from this branch) |
| Production-prep log group | **GO (inspectable)** — `/aws/lambda/checksops-production-prep-api` plus metric filter `checksops-production-prep-api-errors-filter` |
| CloudWatch alarms | **PARTIAL** — template ready; stack `checksops-production-prep-alarms` absent. Metric filters on prep log group exist. **Step 5**. |
| Operator inspect | **PARTIAL** — policy JSON ready; `iam:CreatePolicy` / `AttachRolePolicy` denied on this agent. **Step 5**. |
| Production cutover alarms / SNS | **BLOCKED** (no paging topic; ActionsEnabled false) |

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

## IAM gap (human attach)

Grant `ChecksOpsProductionPrepCloudWatchInspect` to `ChecksOpsCursorCloudStaging` or a dedicated ops role. Do not broaden the Cloud Agent role with DNS, Cognito admin, or SES send.

Inspect production-prep health without DescribeAlarms:

```bash
aws cloudformation describe-stacks --stack-name checksops-production-prep --query 'Stacks[0].Outputs'
aws cloudformation describe-stacks --stack-name checksops-production-prep-alarms --query 'Stacks[0].Outputs'
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/checksops-production-prep
```
