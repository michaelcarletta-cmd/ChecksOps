# Step 5 — CloudWatch inspect IAM + disabled alarms

**Operator only.** This Cloud Agent cannot `iam:CreatePolicy`, `iam:AttachRolePolicy`, `cloudwatch:PutMetricAlarm`, or `cloudwatch:DescribeAlarms`. Do **not** enable alarm actions. Do **not** add SNS. Do **not** overlay `checksops-staging-api`. Do **not** change DNS, Cognito, or flags.

Live `cloudformation deploy` of `checksops-production-prep-alarms` previously failed with `cloudwatch:PutMetricAlarm` denied; that stack is **absent**. Metric filters on `/aws/lambda/checksops-production-prep-api` already exist.

**5A verified 2026-09-05T23:09:58Z:** stack `checksops-production-prep-api` is `UPDATE_COMPLETE`. `ExistingExecutionRoleArn` and output `ExecutionRoleArn` are `arn:aws:iam::806168576068:role/checksops-production-prep-api-role`. `EnableErrorsAlarm=false`. Lambda still that role, `/prep/health` 200, no VPC (`VpcId` empty), flags false.

The policy JSON (`operator-cloudwatch-inspect.json`) / YAML (`operator-cloudwatch-inspect.yaml`) **does not attach** itself. A human must attach after create.

## 5A. Align CloudFormation — **done**

1. CloudFormation → Stacks → **`checksops-production-prep-api`**.
2. **Update** → **Use existing template**. Do **not** upload `api-cfn.yaml`.
3. Change **only** `ExistingExecutionRoleArn` to:

   `arn:aws:iam::806168576068:role/checksops-production-prep-api-role`

4. Keep:
   - `Environment=production-prep`
   - `CognitoUserPoolId=us-east-1_h00WorYMT`
   - `CognitoClientId=3ja9fqaq2fjkv3i6up2varcqpe`
   - `EnableErrorsAlarm=false`
   - Code bucket/key unchanged
5. Review changeset: Lambda `Role` property only. No VPC. No new resources on staging.
6. Execute. Wait for `UPDATE_COMPLETE`.
7. Confirm stack output `ExecutionRoleArn` is the dedicated role, not `checksops-staging-ApiFunctionRole-7E7XRyLe3nyi`.

## 5B. Create the inspect policy (does not attach)

**Console**

1. IAM → **Policies** → **Create policy** → **JSON**.
2. Paste the document in `aws/production/iam/operator-cloudwatch-inspect.json` (scoped to the five named alarms below; `PutMetricAlarm` is **not** `Resource: *`).
3. Policy name: `ChecksOpsProductionPrepCloudWatchInspect` (exact).
4. Description: `Inspect production-prep CloudWatch alarms. No DNS/auth/SES/financial grants.`
5. Create policy. Do **not** attach yet on this screen if you prefer the next step.

**Or CLI** (from this repo, your admin credentials — not the Cloud Agent role):

```bash
aws iam create-policy \
  --policy-name ChecksOpsProductionPrepCloudWatchInspect \
  --policy-document file://aws/production/iam/operator-cloudwatch-inspect.json
```

**Or** deploy the policy-only stack (still **does not attach**):

```bash
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name checksops-production-prep-cw-inspect-policy \
  --template-file aws/production/iam/operator-cloudwatch-inspect.yaml \
  --capabilities CAPABILITY_NAMED_IAM
```

## 5C. Attach the policy

IAM → Roles → **`ChecksOpsCursorCloudStaging`** (so later Cloud Agents can verify) **or** a dedicated ops role you will use in console/CLI.

- Add permissions → Attach policies → `ChecksOpsProductionPrepCloudWatchInspect`.

Do **not** grant `iam:*`, Route 53 / Cloudflare DNS, Cognito admin, SES send, or `cloudwatch:PutMetricAlarm` on `Resource: *`.

## 5D. Deploy inspect-only alarms (`ActionsEnabled=false`)

1. CloudFormation → **Create stack** → With new resources.
2. Upload `aws/production/cloudwatch-alarms.yaml`.
3. Stack name: `checksops-production-prep-alarms` (exact).
4. Parameters: leave defaults (`checksops-production-prep-api`, `checksops-staging-api`).
5. Tags: `Environment=production-prep`, `DoNotCutover=true`.
6. Create stack. Wait for `CREATE_COMPLETE`.

Confirm each alarm shows **Actions enabled = false** and **no SNS / no Auto Scaling actions**:

| Alarm name |
|---|
| `checksops-production-prep-api-errors` |
| `checksops-production-prep-api-throttles` |
| `checksops-production-prep-api-duration-p99` |
| `checksops-production-prep-api-logged-errors` |
| `checksops-staging-api-errors-inspect` |

The staging alarm **only watches** `checksops-staging-api` Errors. It must not change staging code, VPC, or flags.

Do **not** set `ActionsEnabled=true`. Do **not** add an SNS topic in this step.

## What to send back (current: 5B only)

1. **Done:** API stack `UPDATE_COMPLETE` and `ExistingExecutionRoleArn` = `checksops-production-prep-api-role`.
2. After 5B: policy ARN for `ChecksOpsProductionPrepCloudWatchInspect`. Do **not** attach yet (5C). Do **not** create the alarm stack yet (5D).
3. After 5C–5D (later): attach target; alarm stack `CREATE_COMPLETE`; **Actions enabled = false** on all five names.
4. Confirmation you did not edit staging Lambda, production DNS, Cognito, or flags.
