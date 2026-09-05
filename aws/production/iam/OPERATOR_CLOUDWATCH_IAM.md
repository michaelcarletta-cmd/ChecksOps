# Operator CloudWatch inspect IAM

`ChecksOpsCursorCloudStaging` can create CloudFormation resources and describe the production-prep log group. It **cannot**:

- `cloudwatch:DescribeAlarms`
- `cloudwatch:PutMetricAlarm`
- `cloudwatch:GetMetricStatistics` / `ListMetrics`
- `iam:PutRolePolicy` / `iam:GetRole` / `iam:CreateRole` (including leftover `checksops-production-prep-api-role`)

This pass therefore:

1. Leaves a deployable alarm template (`aws/production/cloudwatch-alarms.yaml`). Live `cloudformation deploy` **failed** with `cloudwatch:PutMetricAlarm` denied; leftover stack was deleted.
2. Created metric filter `checksops-production-prep-api-errors-filter` on the prep log group (allowed).
3. Leaves a managed-policy template and JSON for a human to create/attach. `iam:CreatePolicy` / `PutRolePolicy` are denied on this agent.

The inspect policy also includes scoped `PutMetricAlarm` / `DeleteAlarms` so the operator can finish the alarm stack deploy.

## Attach (human)

Attach `ChecksOpsProductionPrepCloudWatchInspect` to **either**:

- `ChecksOpsCursorCloudStaging` (so later Cloud Agents can inspect), or
- a dedicated ops role used in the console / CLI during cutover night.

Do **not** grant `iam:*`, DNS, Cognito admin, SES send, or `cloudwatch:PutMetricAlarm` on `Resource: *` as part of this attach.

```bash
aws iam create-policy \
  --policy-name ChecksOpsProductionPrepCloudWatchInspect \
  --policy-document file://aws/production/iam/operator-cloudwatch-inspect.json

aws iam attach-role-policy \
  --role-name ChecksOpsCursorCloudStaging \
  --policy-arn arn:aws:iam::806168576068:policy/ChecksOpsProductionPrepCloudWatchInspect
```

Or deploy the policy-only stack (still does not attach):

```bash
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name checksops-production-prep-cw-inspect-policy \
  --template-file aws/production/iam/operator-cloudwatch-inspect.yaml \
  --capabilities CAPABILITY_NAMED_IAM
```

Inspect without DescribeAlarms (already allowed):

```bash
aws cloudformation describe-stacks --stack-name checksops-production-prep-alarms --query 'Stacks[0].Outputs'
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/checksops-production-prep
aws logs describe-metric-filters --log-group-name /aws/lambda/checksops-production-prep-api
```
