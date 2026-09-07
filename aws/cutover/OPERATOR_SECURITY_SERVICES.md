# Operator security services deployment package

**Account:** `806168576068`  
**Region:** `us-east-1`  
**Deployment #1 (CloudTrail):** **PASS** (2026-09-07) —
`checksops-production-mgmt-events`, `IsLogging=true`, multi-region, log-file
validation on, management events All, `DataResources=[]`, objects in
`checksops-production-security-logs-806168576068`. Money flags still
`false`. Do **not** create a second management trail.

**Role for #2–#6:** temporary Cursor OIDC role
`ChecksOpsCursorSecurityHardeningTemp` — see
`aws/cutover/OPERATOR_TEMPORARY_ROLE.md`. A privileged ops / Administrator
principal creates **that role only** (one Console CloudFormation stack).
Cursor then assumes it via existing OIDC. **Do not** use or broaden
`ChecksOpsCursorCloudStaging`. **Do not** create the role or deploy `#2`–`#6`
until that runbook is reviewed.

Detection only. No application change. No staging change. No
API-behind-CloudFront. Money/provider flags stay **OFF**.
`64_financial_activation_grants.sql` stays **NOT_APPLIED**.

Templates are the reviewed Batch 5 files except CloudTrail **#1
revised**: do **not** deploy `security-monitoring.yaml` / stack
`checksops-production-cloudtrail` / trail name
`checksops-production-management`. That name is poisoned by the
CREATE_FAILED stack. Use CLI `create-trail` with a **new** name against
the existing bucket.

## Recommended order

| # | Deployment | Why this position |
|---|---|---|
| **1** | CloudTrail management-event logging | Foundational evidence. Resolves leftover trail/bucket state before Config writes to the same bucket. |
| 2 | SNS security alerts | No traffic impact. Email confirm can complete before alarms. |
| 3 | AWS Config | Uses the live logs bucket + retained Config role. |
| 4 | GuardDuty + Security Hub | Reviewed as **one** template. Hub is more useful after Config exists. Detection only. |
| 5 | VPC Flow Logs | Network 5-tuple only. Independent of Hub. |
| 6 | CloudWatch security alarms | After SNS subscription is **Confirmed**. |

**#1 is PASS.** Next reviewed step is the temporary Cursor role
(`OPERATOR_TEMPORARY_ROLE.md`), then `#2`–`#6` in this order. Do **not**
start `#2` until that role exists and a later message opens those
deployments.

---

## Leftover Batch 5 state (read before #1)

| Resource | State | Action |
|---|---|---|
| Bucket `checksops-production-security-logs-806168576068` | **LIVE** (PAB, AES256, versioning, 365-day lifecycle, CloudTrail/Config bucket policy) | **Keep. Do not delete.** |
| Bucket policy | **CREATE_COMPLETE** on the failed stack | **Keep. Do not replace.** |
| Stack `checksops-production-security-trail` | **CREATE_FAILED** (owns bucket + policy) | **Leave in place.** `retain-resources` is illegal until `DELETE_FAILED`. A plain `delete-stack` would delete the bucket. |
| Trail `checksops-production-management` | **Not in CloudTrail** (`TrailNotFoundException`) but **reserved in CloudFormation** | **Do not create this name** (CLI or CFN). A future delete of the failed stack would DeleteTrail it. |
| Stack `checksops-production-cloudtrail` | Rolled back / must not be retried with the old trail name | Do not recreate |
| Role `checksops-production-config-recorder` | **Retained** | **Keep** for #3 |
| Roles `checksops-production-vpc-flow-logs`, `checksops-production-cloudtrail-logs` | Leftover failed creates | **Do not delete** |
| Metric filters on API/Lambda log groups | **LIVE** | Do not remove |

---

## Deployment #1 — CloudTrail management-event logging (revised)

**#1 is PASS.** Commands below are the historical card (do not re-run
`create-trail`). Do not start #2 until the temporary Cursor role is
reviewed and created.

**Do not** use CloudFormation for this step.  
**Do not** delete or update `checksops-production-security-trail`.  
**Do not** delete or replace `checksops-production-security-logs-806168576068` or its bucket policy.  
**Do not** create trail `checksops-production-management`.  
**Do not** retry stack `checksops-production-cloudtrail` with `security-monitoring.yaml` (same poisoned `TrailName`).

### Method

Privileged-ops **CLI** `create-trail` + `start-logging` against the
**existing** bucket. New trail name avoids the stale CloudFormation
logical/physical ID.

| Field | Value |
|---|---|
| Template | **None** (do not deploy `aws/production/security-monitoring.yaml` for #1) |
| Stack name | **None** |
| Region | `us-east-1` |
| Trail name | `checksops-production-mgmt-events` |
| Bucket | `checksops-production-security-logs-806168576068` (existing) |
| Prefix | `cloudtrail` (matches live bucket policy) |
| IAM capability | **Not applicable** |
| Expected resource | One multi-region management trail, log-file validation on, **no** data events |

The live bucket policy already allows `cloudtrail.amazonaws.com`
`s3:GetBucketAcl` / `s3:GetBucketLocation` and `s3:PutObject` on
`cloudtrail/AWSLogs/806168576068/*` with `bucket-owner-full-control`.
Do not edit that policy.

### Why not CFN / original name

CloudFormation reserved `checksops-production-management` on
`ProductionCloudTrail` even though CloudTrail returns
`TrailNotFoundException`. Creating that name via CLI would attach a
**live** trail to a CREATE_FAILED stack whose later delete would destroy
it. `retain-resources` cannot be used while the stack is CREATE_FAILED.
Leaving the failed stack in place **protects** the bucket.

### Duplicate-charge rule

AWS does not charge extra CloudTrail event fees for the **first**
management-event trail. A **second** trail that also captures management
events is ~$2.00 / 100k events.

`describe-trails` first. If **any** trail already logs management events
and is `IsLogging=true`, **stop** — reuse it (confirm no `DataResources`)
instead of creating `checksops-production-mgmt-events`.

If `describe-trails` is empty (expected: original name not found),
creating **one** new trail is the first copy → no duplicate event charge.
Never also create `checksops-production-management` later.

### Expected monthly cost

Same as before: first management trail ≈ S3 cents (SSE-S3, 365-day
lifecycle). Do **not** enable Insights or S3 data events (data events
would log check-image keys).

### Pre-flight

```bash
aws cloudtrail describe-trails --region us-east-1 \
  --query 'trailList[].[Name,S3BucketName,IsMultiRegionTrail,HomeRegion,LogFileValidationEnabled]'

aws cloudtrail get-trail --region us-east-1 --name checksops-production-mgmt-events
# expected first time: TrailNotFoundException

aws cloudtrail get-trail --region us-east-1 --name checksops-production-management
# expected: TrailNotFoundException — do not create this name

aws cloudformation describe-stacks --region us-east-1 \
  --stack-name checksops-production-security-trail \
  --query 'Stacks[0].StackStatus'
# expected: CREATE_FAILED — leave it

aws s3api head-bucket --bucket checksops-production-security-logs-806168576068
aws s3api get-bucket-policy --bucket checksops-production-security-logs-806168576068
aws s3api get-public-access-block --bucket checksops-production-security-logs-806168576068
```

If `describe-trails` lists an already-logging management trail: **Path A**
(reuse). Otherwise **Path B** (create the new name).

#### Path A — a live management trail already exists

Do not create a second trail. Confirm selectors have
`IncludeManagementEvents=true` and **no** `DataResources`. If logging is
off, `start-logging` that existing name only. Then PASS-verify using
**that** name.

#### Path B — no live trails (expected)

```bash
aws cloudtrail create-trail --region us-east-1 \
  --name checksops-production-mgmt-events \
  --s3-bucket-name checksops-production-security-logs-806168576068 \
  --s3-key-prefix cloudtrail \
  --is-multi-region-trail \
  --enable-log-file-validation

aws cloudtrail put-event-selectors --region us-east-1 \
  --trail-name checksops-production-mgmt-events \
  --event-selectors '[{"ReadWriteType":"All","IncludeManagementEvents":true}]'

aws cloudtrail start-logging --region us-east-1 \
  --name checksops-production-mgmt-events
```

Do **not** pass `--s3-data-events` / Insight selectors.  
`put-event-selectors` above has **no** `DataResources`.

### PASS verification (all must hold)

```bash
aws cloudtrail get-trail --region us-east-1 \
  --name checksops-production-mgmt-events \
  --query 'Trail.{Name:Name,Bucket:S3BucketName,Prefix:S3KeyPrefix,Multi:IsMultiRegionTrail,Global:IncludeGlobalServiceEvents,Validation:LogFileValidationEnabled}'

aws cloudtrail get-trail-status --region us-east-1 \
  --name checksops-production-mgmt-events \
  --query '{IsLogging:IsLogging,LatestDeliveryTime:LatestDeliveryTime,LatestDeliveryError:LatestDeliveryError}'

aws cloudtrail get-event-selectors --region us-east-1 \
  --name checksops-production-mgmt-events

aws cloudtrail describe-trails --region us-east-1 \
  --query 'length(trailList)'
```

Required:

- `Name` = `checksops-production-mgmt-events`
- `IsLogging` = `true`
- `S3BucketName` = `checksops-production-security-logs-806168576068`
- `S3KeyPrefix` = `cloudtrail`
- `IsMultiRegionTrail` = `true`
- `LogFileValidationEnabled` = `true`
- `IncludeManagementEvents` = `true`
- **No** `DataResources`
- **Exactly one** trail in `describe-trails` (no duplicate management copies)
- Failed stack still `CREATE_FAILED` (bucket still owned there)
- Bucket still exists

Generate one harmless management event, wait **15 minutes**, confirm
delivery:

```bash
aws sts get-caller-identity --region us-east-1
# wait ~15 minutes
aws cloudtrail get-trail-status --region us-east-1 \
  --name checksops-production-mgmt-events \
  --query 'LatestDeliveryTime'
aws s3api list-objects-v2 --bucket checksops-production-security-logs-806168576068 \
  --prefix cloudtrail/AWSLogs/806168576068/ --max-keys 10
```

PASS requires at least one object under
`cloudtrail/AWSLogs/806168576068/` and `LatestDeliveryTime` within the
last hour with **no** `LatestDeliveryError`.

Holds (read only):

```bash
aws lambda get-function-configuration --region us-east-1 \
  --function-name checksops-production-prep-api \
  --query 'Environment.Variables.{MOOV:AWS_MOOV_ENABLED,CHECKALT:AWS_CHECKALT_ENABLED,PROVIDER:AWS_PROVIDER_EXECUTION_ENABLED,FINANCIAL:AWS_FINANCIAL_PERMISSIONS_ACTIVATED}'

aws rds describe-db-instances --region us-east-1 \
  --db-instance-identifier checksops-staging \
  --query 'DBInstances[0].{BackupRetentionPeriod:BackupRetentionPeriod,DeletionProtection:DeletionProtection}'
```

Expected: flags `false`. Backup retention `35`. Deletion protection `true`.

**#1 PASS** when logging + S3 objects + no data events + single trail +
bucket untouched + flags OFF. Then stop. Do not start #2 yet.

### Rollback

Stops new writes; does not touch the bucket or failed stack:

```bash
aws cloudtrail stop-logging --region us-east-1 \
  --name checksops-production-mgmt-events
```

Only if the new trail must be removed (after stop-logging):

```bash
aws cloudtrail delete-trail --region us-east-1 \
  --name checksops-production-mgmt-events
```

**Do not:**

- `delete-stack` on `checksops-production-security-trail` (would delete the bucket)
- `--retain-resources` while status is CREATE_FAILED (API rejects it)
- `create-trail` / CFN using name `checksops-production-management`
- Recreate stack `checksops-production-cloudtrail` with `security-monitoring.yaml`
- Delete or replace the logs bucket or bucket policy
- Delete leftover IAM roles
- Enable S3 data events
- Change Lambda env, WAF, or money flags

### Later stack cleanup (not #1)

Leave `checksops-production-security-trail` as the bucket’s CloudFormation
owner. Optional future cleanup (only after a dedicated review): force
`DELETE_FAILED` without losing the bucket (for example a Deny on
`s3:DeleteBucket`, then `delete-stack`, then
`delete-stack --retain-resources SecurityLogsBucket,SecurityLogsBucketPolicy`).
Do **not** do that in this deployment.

---

## Later deployments (do not run yet)

Full cards for #2–#6 are in this file so the package is complete.
**#1 is PASS.** Do **not** execute `#2`–`#6` until
`ChecksOpsCursorSecurityHardeningTemp` is reviewed, created, and a later
message opens those deployments. Use the reviewed templates below as-is.

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

**STOP FOR REVIEW — managed-policy redesign; do not deploy.** The third
create uploaded the old five-inline YAML (`483adcec`), not HEAD
`5e07501f`. See `aws/cutover/OPERATOR_ROLE_TEMPLATE_MISMATCH.md`. Delete
the `ROLLBACK_COMPLETE` stack and upload only the current GitHub
template. Do not start #2–#6.
