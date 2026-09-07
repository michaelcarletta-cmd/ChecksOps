# Operator security services deployment package

**Account:** `806168576068`  
**Region:** `us-east-1`  
**Role to use:** a privileged ops / Administrator role.  
**Do not** use or broaden `ChecksOpsCursorCloudStaging`.

Detection only. No application change. No staging change. No
API-behind-CloudFront. Money/provider flags stay **OFF**.
`64_financial_activation_grants.sql` stays **NOT_APPLIED**.

Templates are the reviewed Batch 5 files. Do not invent a new trail
name, bucket, or detector if the named resource already exists — audit
first, then create or start-logging.

## Recommended order

| # | Deployment | Why this position |
|---|---|---|
| **1** | CloudTrail management-event logging | Foundational evidence. Resolves leftover trail/bucket state before Config writes to the same bucket. |
| 2 | SNS security alerts | No traffic impact. Email confirm can complete before alarms. |
| 3 | AWS Config | Uses the live logs bucket + retained Config role. |
| 4 | GuardDuty + Security Hub | Reviewed as **one** template. Hub is more useful after Config exists. Detection only. |
| 5 | VPC Flow Logs | Network 5-tuple only. Independent of Hub. |
| 6 | CloudWatch security alarms | After SNS subscription is **Confirmed**. |

Deploy and **PASS-verify #1** before starting #2.  
This document stops the operator at **#1**.

---

## Leftover Batch 5 state (read before #1)

| Resource | State | Action |
|---|---|---|
| Bucket `checksops-production-security-logs-806168576068` | **LIVE** (PAB, AES256, versioning, 365-day lifecycle, CloudTrail/Config bucket policy) | **Keep** |
| Stack `checksops-production-security-trail` | **CREATE_FAILED** (owns the bucket + policy; may have reserved trail name) | Do **not** delete without `--retain-resources` |
| Trail `checksops-production-management` | Name reserved; logging **not confirmed** (0 objects under `cloudtrail/` at Batch 5 close) | Audit, then start-logging **or** create |
| Role `checksops-production-config-recorder` | **Retained** | **Keep** for #3 |
| Roles `checksops-production-vpc-flow-logs`, `checksops-production-cloudtrail-logs` | Leftover failed creates | **Do not delete** |
| Metric filters on API/Lambda log groups | **LIVE** | Do not remove |

---

## Deployment #1 — CloudTrail management-event logging

**STOP after this deployment.** Do not start #2 until #1 is PASS.

### Template

`aws/production/security-monitoring.yaml`

Creates **only** `AWS::CloudTrail::Trail`. Does **not** create the S3
bucket (already live). Does **not** add `DataResources` (no S3 object-key
/ check-image logging). Does **not** create IAM roles.

### Stack name

`checksops-production-cloudtrail`

Use this name only if the trail does **not** already exist. If the trail
already exists, do **not** create a second stack — follow Path A or B.

### Region

`us-east-1`

### Required parameters

| Parameter | Value |
|---|---|
| `SecurityLogsBucketName` | `checksops-production-security-logs-806168576068` (template default) |

No other parameters.

### IAM capability acknowledgement

**Not required.** Template contains no `AWS::IAM::*` resources.  
Do **not** pass `--capabilities CAPABILITY_IAM` or `CAPABILITY_NAMED_IAM`.

### Expected resources

| Logical ID | Type | Physical name |
|---|---|---|
| `ProductionCloudTrail` | `AWS::CloudTrail::Trail` | `checksops-production-management` |

Expected properties:

- `IsLogging`: true
- `IsMultiRegionTrail`: true
- `IncludeGlobalServiceEvents`: true
- `EnableLogFileValidation`: true
- `S3BucketName`: `checksops-production-security-logs-806168576068`
- `S3KeyPrefix`: `cloudtrail`
- Event selector: management events **All**, **no** `DataResources`

Does **not** create: GuardDuty, Security Hub, Config, Flow Logs, SNS,
alarms, Lambda/API changes, WAF changes.

### Expected monthly cost

Estimates for this account/region. Not a quote.

| Item | Consideration |
|---|---|
| Management events (first trail) | AWS includes one copy of management events at no extra CloudTrail event charge for the first trail in the account. This **is** intended to be that trail. |
| Multi-region + global IAM | Still management events. Expect low volume in a single-app account (typically well under 100k events/month unless Console/API chatter is high). |
| Extra trail copies | Do **not** create a second management trail. A second copy is charged (~$2.00 per 100k events). |
| S3 storage | SSE-S3 in `us-east-1` ~$0.023/GB-month. 365-day lifecycle. Management-only logs are usually well under 5 GB/month here. |
| S3 PUTs / LIST | Small; trail writes compressed files every few minutes when activity exists. |
| Insight / data events | **Do not enable.** S3 data events would log check-image keys and add ~$0.10/100k data events. |

If this is the account’s first CloudTrail, incremental cost is mostly S3
cents. If another management trail already exists, **stop** and reuse it
instead of paying for a second copy.

### Pre-flight (required — audit, do not skip)

Run from a privileged ops role in `us-east-1`:

```bash
aws cloudtrail describe-trails --region us-east-1 \
  --query 'trailList[].[Name,S3BucketName,IsLogging,IsMultiRegionTrail,HomeRegion]'

aws cloudtrail get-trail --region us-east-1 \
  --name checksops-production-management

aws cloudtrail get-trail-status --region us-east-1 \
  --name checksops-production-management

aws cloudtrail get-event-selectors --region us-east-1 \
  --name checksops-production-management

aws cloudformation describe-stacks --region us-east-1 \
  --stack-name checksops-production-security-trail \
  --query 'Stacks[0].StackStatus'

aws s3api head-bucket --bucket checksops-production-security-logs-806168576068
aws s3api get-public-access-block --bucket checksops-production-security-logs-806168576068
aws s3api get-bucket-encryption --bucket checksops-production-security-logs-806168576068
aws s3api list-objects-v2 --bucket checksops-production-security-logs-806168576068 \
  --prefix cloudtrail/ --max-keys 5
```

Choose **exactly one** path:

#### Path A — trail exists and `IsLogging` is true

Do **not** create stack `checksops-production-cloudtrail`.  
Jump to **PASS verification**. If selectors include `DataResources`,
**stop** and remove data events (do not leave check-image keys in the
trail).

#### Path B — trail exists, `IsLogging` is false

Do **not** create a second trail.

```bash
aws cloudtrail start-logging --region us-east-1 \
  --name checksops-production-management
```

If event selectors are missing or include data events, set management-only
(no `DataResources`):

```bash
aws cloudtrail put-event-selectors --region us-east-1 \
  --trail-name checksops-production-management \
  --event-selectors '[{"ReadWriteType":"All","IncludeManagementEvents":true}]'
```

Then PASS-verify.

#### Path C — trail does not exist (`TrailNotFoundException`)

1. Leave stack `checksops-production-security-trail` in place **or**, if
   you must remove the CREATE_FAILED record, retain the bucket:

   ```bash
   aws cloudformation delete-stack --region us-east-1 \
     --stack-name checksops-production-security-trail \
     --retain-resources SecurityLogsBucket SecurityLogsBucketPolicy ProductionCloudTrail
   aws cloudformation wait stack-delete-complete --region us-east-1 \
     --stack-name checksops-production-security-trail
   ```

   If `ProductionCloudTrail` is not a resource on that stack, omit it from
   `--retain-resources`. **Never** omit `SecurityLogsBucket`.

2. Deploy the reviewed template:

   ```bash
   aws cloudformation create-stack --region us-east-1 \
     --stack-name checksops-production-cloudtrail \
     --template-body file://aws/production/security-monitoring.yaml \
     --parameters ParameterKey=SecurityLogsBucketName,ParameterValue=checksops-production-security-logs-806168576068

   aws cloudformation wait stack-create-complete --region us-east-1 \
     --stack-name checksops-production-cloudtrail
   ```

   No `--capabilities`. `--on-failure ROLLBACK` is acceptable here (trail
   only; bucket is not in this stack).

### PASS verification (all must hold)

```bash
# 1) Trail logging
aws cloudtrail get-trail --region us-east-1 \
  --name checksops-production-management \
  --query 'Trail.{Name:Name,Bucket:S3BucketName,Prefix:S3KeyPrefix,Multi:IsMultiRegionTrail,Global:IncludeGlobalServiceEvents,Validation:LogFileValidationEnabled}'

aws cloudtrail get-trail-status --region us-east-1 \
  --name checksops-production-management \
  --query '{IsLogging:IsLogging,LatestDeliveryTime:LatestDeliveryTime,LatestDeliveryError:LatestDeliveryError}'

# 2) Management events only — DataResources must be absent/empty
aws cloudtrail get-event-selectors --region us-east-1 \
  --name checksops-production-management
```

Required values:

- `IsLogging` = `true`
- `S3BucketName` = `checksops-production-security-logs-806168576068`
- `S3KeyPrefix` = `cloudtrail`
- `IsMultiRegionTrail` = `true`
- `LogFileValidationEnabled` = `true`
- `IncludeManagementEvents` = `true`
- **No** `DataResources`

Generate one harmless management event, wait **15 minutes**, then confirm
delivery:

```bash
aws sts get-caller-identity --region us-east-1

# wait ~15 minutes
aws cloudtrail get-trail-status --region us-east-1 \
  --name checksops-production-management \
  --query 'LatestDeliveryTime'

aws s3api list-objects-v2 --bucket checksops-production-security-logs-806168576068 \
  --prefix cloudtrail/AWSLogs/806168576068/ \
  --max-keys 10
```

PASS requires **at least one** object under
`cloudtrail/AWSLogs/806168576068/` and `LatestDeliveryTime` within the
last hour with **no** `LatestDeliveryError`.

Holds (must still be true — read only):

```bash
aws lambda get-function-configuration --region us-east-1 \
  --function-name checksops-production-prep-api \
  --query 'Environment.Variables.{MOOV:AWS_MOOV_ENABLED,CHECKALT:AWS_CHECKALT_ENABLED,PROVIDER:AWS_PROVIDER_EXECUTION_ENABLED,FINANCIAL:AWS_FINANCIAL_PERMISSIONS_ACTIVATED}'

aws rds describe-db-instances --region us-east-1 \
  --db-instance-identifier checksops-staging \
  --query 'DBInstances[0].{BackupRetentionPeriod:BackupRetentionPeriod,DeletionProtection:DeletionProtection}'
```

Expected: all four flags `false` (or `"false"`). Backup retention `35`.
Deletion protection `true`.

**#1 PASS** only when logging + S3 objects + no data events + flags still
OFF. Then stop. Do not start deployment #2 until the next operator prompt.

### Rollback

Preferred (keeps the trail definition, stops new writes):

```bash
aws cloudtrail stop-logging --region us-east-1 \
  --name checksops-production-management
```

If you created stack `checksops-production-cloudtrail` and must remove it:

```bash
aws cloudformation delete-stack --region us-east-1 \
  --stack-name checksops-production-cloudtrail
aws cloudformation wait stack-delete-complete --region us-east-1 \
  --stack-name checksops-production-cloudtrail
```

That delete removes **only** the trail. It does **not** delete
`checksops-production-security-logs-806168576068`.

**Do not:**

- Delete the security-logs bucket
- Delete `checksops-production-security-trail` without retain
- Delete leftover IAM roles
- Enable S3 data events “to debug”
- Change Lambda env, WAF, or money flags

---

## Later deployments (do not run yet)

Full cards for #2–#6 are in this file so the package is complete.
**Do not execute them until #1 is PASS and the next stop is opened.**

### #2 SNS — `aws/production/security-alerts-sns.yaml`

- Stack: `checksops-production-security-sns`
- Region: `us-east-1`
- Parameters: `AlertEmail` = `security@checksops.com`
- IAM capability: **No**
- Resources: topic `checksops-production-security-alerts` + email subscription
- Cost: email notifies; first 1,000 SNS email notifications/month are typically free, then about $2.00 per 100,000
- PASS: `aws sns get-topic-attributes --topic-arn arn:aws:sns:us-east-1:806168576068:checksops-production-security-alerts` and subscription `PendingConfirmation` → operator confirms mail → `Confirmed`
- Rollback: `delete-stack checksops-production-security-sns`
- Then pass `AlertTopicArn` into #6 (not into `security-monitoring.yaml`)

### #3 Config — `aws/production/security-config.yaml`

- Stack: `checksops-production-security-config`
- Region: `us-east-1`
- Parameters: `SecurityLogsBucketName` (default bucket), `ConfigRoleArn` = `arn:aws:iam::806168576068:role/checksops-production-config-recorder`
- IAM capability: **No** (reuses existing role)
- Resources: delivery channel + recorder `checksops-production`, `AllSupported` + global types
- Cost: often the largest item. Configuration items ~$0.003 each; a small account with `AllSupported` is commonly **$20–$150/month**. No auto-remediation.
- PASS: `aws configservice describe-configuration-recorder-status` shows `recording: true` and `lastStatus: SUCCESS`; objects under `s3://…/config/`
- Rollback: `stop-configuration-recorder --configuration-recorder-name checksops-production` then `delete-stack`. **Keep** the Config role.
- Account limit: **one** recorder per region. If a `default` recorder already exists, **stop** and do not create a second.

### #4 GuardDuty + Security Hub — `aws/production/security-posture-services.yaml`

Reviewed as a **single** stack (do not split the template).

- Stack: `checksops-production-security-posture`
- Region: `us-east-1`
- Parameters: none
- IAM capability: **No**
- Resources: GuardDuty detector (EBS malware **DISABLED**), Security Hub hub with default standards, `SECURITY_CONTROL` findings, no traffic block
- Cost: GuardDuty often **$10–$50/month** here (CloudTrail analysis; EBS malware off avoids snapshot cost). Security Hub default standards often **$20–$100/month** (many controls × resources). Findings only — no auto-remediate.
- PASS: `aws guardduty list-detectors` + `get-detector` shows `Status=ENABLED` and `EBS_MALWARE_PROTECTION` DISABLED; `aws securityhub describe-hub` succeeds; `get-enabled-standards` non-empty
- Rollback: `delete-stack` (disables Hub/detector created by the stack). Do not delete leftover staging roles.

### #5 VPC Flow Logs — `aws/production/security-vpc-flow.yaml`

- Stack: `checksops-production-security-flow`
- Region: `us-east-1`
- Parameters: `VpcId` = `vpc-09f2268778966ce97`
- IAM capability: **Yes — `CAPABILITY_NAMED_IAM`** (creates `checksops-production-vpc-flow-logs`)
- Conflict: that role name may already exist from Batch 5. If `EntityAlreadyExists`, **stop** and reuse/import — do not create a second role and do not delete the leftover without review.
- Resources: log group `/aws/vpc/checksops-production-flow` (90 days), role, flow log ALL traffic, 600s aggregation, no payloads
- Cost: CloudWatch Logs ingest ~$0.50/GB. Default-VPC Lambda ENIs are usually modest (**a few dollars to tens**/month). 90-day retention.
- PASS: `aws ec2 describe-flow-logs --filter Name=resource-id,Values=vpc-09f2268778966ce97` shows `Active`; log group exists
- Rollback: `delete-stack`. If delete fails on the named role, retain the role.

### #6 CloudWatch alarms — `aws/production/security-alarms.yaml`

- Stack: `checksops-production-security-alarms`
- Region: `us-east-1`
- Parameters: `AlertTopicArn` = ARN from #2 (required for paging). Defaults for prep Lambda, API `kiqojucc02`/`prep`, files bucket, RDS `checksops-staging`, Cognito pool, WAF metric `checksopsProductionCloudFrontWaf`
- IAM capability: **No**
- Resources: 14 alarms, `TreatMissingData=notBreaching`
- Cost: ~$0.10/alarm/month → about **$1.40/month** plus SNS
- PASS: `aws cloudwatch describe-alarms --alarm-name-prefix checksops-prod` returns the set; missing metrics do **not** go ALARM
- Rollback: `delete-stack`
- Note: `IamSecurityChanges` stays quiet until CloudTrail is also delivered to CloudWatch Logs (not in #1). S3 4xx needs request metrics on the files bucket (optional later).

---

**STOP FOR OPERATOR DEPLOYMENT #1.**
