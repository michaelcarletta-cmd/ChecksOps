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

Templates are the reviewed Batch 5 files except two **name-collision
fixes** that do **not** touch `checksops-production-security-trail`:

- CloudTrail **#1 revised:** do **not** deploy `security-monitoring.yaml`
  / stack `checksops-production-cloudtrail` / trail name
  `checksops-production-management`. Use CLI `create-trail` with
  `checksops-production-mgmt-events` against the existing bucket.
- Config **#3 revised:** do **not** reuse recorder/channel name
  `checksops-production` (reserved on the failed trail stack). Use
  `checksops-production-config-items` and a new recorder role. **Do not
  deploy #3 until this correction is reviewed.**

## Recommended order

| # | Deployment | Why this position |
|---|---|---|
| **1** | CloudTrail management-event logging | Foundational evidence. Resolves leftover trail/bucket state before Config writes to the same bucket. |
| 2 | SNS security alerts | No traffic impact. Email confirm can complete before alarms. |
| 3 | AWS Config | **PASS.** CLI recorder/channel `checksops-production-config-items`. Existing bucket `config/` prefix. |
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
| Role `checksops-production-config-recorder` | **NoSuchEntity** | **Do not recreate this name.** #3 uses `checksops-production-config-items-recorder`. |
| Config channel/recorder `checksops-production` | Reserved on the failed trail stack (physical id `None`) | **Do not create this name.** Use `checksops-production-config-items`. |
| Roles `checksops-production-vpc-flow-logs`, `checksops-production-cloudtrail-logs` | vpc-flow-logs **NoSuchEntity** now; do not delete leftovers if they reappear | #5 can create `checksops-production-vpc-flow-logs` if still absent |
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
- Parameters: `AlertEmail` = `security@checksops.com`; `CreateEmailSubscription` = `true`; `TemporaryAlertEmail` = `support@checksops.com`
- IAM capability: **No**
- Resources: topic `checksops-production-security-alerts` + `security@` subscription + temporary `support@` subscription
- Cost: email notifies; first 1,000 SNS email notifications/month are typically free, then about $2.00 per 100,000
- PASS: `aws sns get-topic-attributes --topic-arn arn:aws:sns:us-east-1:806168576068:checksops-production-security-alerts` and subscription `PendingConfirmation` → operator confirms mail → `Confirmed`
- Stale pending repair (CloudFormation only; do not `sns unsubscribe` unless CFN cannot replace):
  1. Change set with `CreateEmailSubscription=false` — must **Remove** only `AlertSubscription`
  2. Change set with `CreateEmailSubscription=true` — must **Add** only `AlertSubscription`
  Topic ARN/name, protocol `email`, and endpoint stay `security@checksops.com`. A single same-property update or `sns subscribe` does **not** send a new confirmation.
  **AWS limitation (observed 2026-09-08):** CFN cannot delete a pending
  email subscription (it detaches). `sns unsubscribe` is also denied for
  pending ARNs. Recreating `AlertSubscription` reattaches the same pending
  ARN and does **not** send a new confirmation. Wait for SNS to auto-delete
  the unconfirmed subscription (~48 hours), then run step 2 (or false→true)
  when pending count is `0`. Do **not** delete the topic.
- Rollback: `delete-stack checksops-production-security-sns`
- Then pass `AlertTopicArn` into #6 (not into `security-monitoring.yaml`)

### #3 Config — **PASS** (CLI; do not retry CFN)

Same class of fix as CloudTrail `#1`: the CFN name
`checksops-production` is reserved on
`checksops-production-security-trail`. Do **not** delete or update that
stack. Do **not** recreate channel/recorder `checksops-production` or
role `checksops-production-config-recorder`.

| Field | Value |
|---|---|
| Recorder name | `checksops-production-config-items` |
| Delivery-channel name | `checksops-production-config-items` |
| IAM role name | `checksops-production-config-items-recorder` |
| IAM role ARN | `arn:aws:iam::806168576068:role/checksops-production-config-items-recorder` |
| Role template / stack | `aws/production/security-config-role.yaml` / `checksops-production-security-config-role` |
| Desired-state YAML | `aws/production/security-config.yaml` (**do not** `create-stack`) |
| Bucket / prefix | `checksops-production-security-logs-806168576068` / `config` |
| Recording | `AllSupported` + global types. Detection only. No remediation. |
| Cursor PassRole | **only** the new role ARN to `config.amazonaws.com` |

#### Config recorder IAM role permissions

Trust: `config.amazonaws.com` with `AWS:SourceAccount=806168576068`.

- AWS managed `arn:aws:iam::aws:policy/service-role/AWS_ConfigRole` — required read APIs for `AllSupported` recording. No remediation attach.
- Inline `DeliverConfigItemsToSecurityLogs`:
  - `s3:GetBucketAcl` / `GetBucketLocation` / `GetBucketVersioning` / `ListBucket` on the security-logs bucket
  - `s3:PutObject` on `…/config/*` with `s3:x-amz-acl=bucket-owner-full-control`

No SNS, no SQS, no SSM, no `config:PutRemediation*`. Does **not** edit
the live bucket policy (existing Config service-principal statements
already cover `config/`).

The temp Cursor role still **cannot** `CreateRole` for Config. It only
`PassRole` / `GetRole` this exact new ARN.

#### Operator prep (complete 2026-09-07)

Role stack `checksops-production-security-config-role` **CREATE_COMPLETE**.
Temp role stack **UPDATE_COMPLETE**. Empty failed Config stack deleted.
Trail stack not touched.

#### Why not CloudFormation

A single CFN stack cannot create both resources with current APIs:

1. `PutDeliveryChannel` → `NoAvailableConfigurationRecorderException`
   if no recorder exists.
2. CFN `AWS::Config::ConfigurationRecorder` then calls
   `StartConfigurationRecorder` → `NoAvailableDeliveryChannelException`
   if no channel exists.

Two `create-stack` attempts **ROLLBACK_COMPLETE**. Same class of fix as
CloudTrail `#1`: **CLI** against the existing bucket.

#### Deploy commands (historical; #3 is PASS — do not re-run)

Account limit: **one** recorder per region.

```bash
aws configservice put-configuration-recorder --region us-east-1 \
  --configuration-recorder '{"name":"checksops-production-config-items","roleARN":"arn:aws:iam::806168576068:role/checksops-production-config-items-recorder","recordingGroup":{"allSupported":true,"includeGlobalResourceTypes":true}}'

aws configservice put-delivery-channel --region us-east-1 \
  --delivery-channel '{"name":"checksops-production-config-items","s3BucketName":"checksops-production-security-logs-806168576068","s3KeyPrefix":"config"}'

aws configservice start-configuration-recorder --region us-east-1 \
  --configuration-recorder-name checksops-production-config-items
```

**#3 PASS** (2026-09-07): `recording: true`, `lastStatus: SUCCESS`,
object `config/AWSLogs/806168576068/Config/ConfigWritabilityCheckFile`
on the existing bucket. Trail stack still `CREATE_FAILED`. Money flags
still `false`. First full Config snapshot may continue writing under
`config/` after PASS.

Cost: configuration items ~$0.003 each; a small account with
`AllSupported` is commonly **$20–$150/month**.

#### Rollback

Stops recording; does not touch the bucket, trail stack, or temp role:

```bash
aws configservice stop-configuration-recorder --region us-east-1 \
  --configuration-recorder-name checksops-production-config-items
```

Only if the recorder/channel must be removed after stop:

```bash
aws configservice delete-delivery-channel --region us-east-1 \
  --delivery-channel-name checksops-production-config-items
aws configservice delete-configuration-recorder --region us-east-1 \
  --configuration-recorder-name checksops-production-config-items
```

Keep `checksops-production-config-items-recorder` unless the role itself
must be removed:

```bash
aws cloudformation delete-stack --region us-east-1 \
  --stack-name checksops-production-security-config-role
```

**Do not:**

- `delete-stack` / update `checksops-production-security-trail`
- Create recorder/channel `checksops-production`
- Recreate `checksops-production-config-recorder`
- Edit or replace the security-logs bucket or policy
- Enable Config remediation or SNS delivery
- Change Lambda env, WAF, or money flags

### #4 GuardDuty + Security Hub — `aws/production/security-posture-services.yaml`

Reviewed as a **single** stack (do not split the template).

- Stack: `checksops-production-security-posture`
- Region: `us-east-1`
- Parameters: none
- IAM capability: **No**
- Resources: GuardDuty detector (EBS malware **DISABLED**), Security Hub hub with default standards, `SECURITY_CONTROL` findings, no traffic block
- Cost: GuardDuty often **$10–$50/month** here (CloudTrail analysis; EBS malware off avoids snapshot cost). Security Hub default standards often **$20–$100/month** (many controls × resources). Findings only — no auto-remediate.
- **#4 PASS** (2026-09-07): detector `298dc17133dd46b1b2cf755bc1380e1f` ENABLED, `FIFTEEN_MINUTES`, EBS malware DISABLED. Hub enabled. Default CIS 1.2.0 + FSBP 1.0.0 subscriptions present (PENDING first enable).
- Rollback: `delete-stack` (disables Hub/detector created by the stack). Do not delete leftover staging roles.

### #5 VPC Flow Logs — `aws/production/security-vpc-flow.yaml`

- Stack: `checksops-production-security-flow`
- Region: `us-east-1`
- Parameters: `VpcId` = `vpc-09f2268778966ce97`
- IAM capability: **Yes — `CAPABILITY_NAMED_IAM`** (creates `checksops-production-vpc-flow-logs`)
- Conflict: that role name may already exist from Batch 5. If `EntityAlreadyExists`, **stop** and reuse/import — do not create a second role and do not delete the leftover without review.
- Resources: log group `/aws/vpc/checksops-production-flow` (90 days), role, flow log ALL traffic, 600s aggregation, no payloads
- Cost: CloudWatch Logs ingest ~$0.50/GB. Default-VPC Lambda ENIs are usually modest (**a few dollars to tens**/month). 90-day retention.
- **#5 PASS** (2026-09-07): stack `CREATE_COMPLETE`. Flow log `fl-0913268bc96a95205` ACTIVE, `DeliverLogsStatus=SUCCESS`, VPC `vpc-09f2268778966ce97`, ALL, destination `/aws/vpc/checksops-production-flow` (90 days), aggregation 600s. Role `checksops-production-vpc-flow-logs` trusts only `vpc-flow-logs.amazonaws.com`. ENI/NAT streams ingested.
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
- Note: CloudTrail → CloudWatch Logs for `IamSecurityChanges` is now
  attached (follow-up PASS). The alarm stays non-ALARM until a matching
  IAM event occurs. S3 4xx needs request metrics on the files bucket
  (optional later).

---

**STOP FOR REVIEW — #1–#6 PASS.** Follow-up CloudTrail → CloudWatch Logs
is also **PASS**. `#6` stack `checksops-production-security-alarms` is
**CREATE_COMPLETE** (2026-09-08). 14 alarms page the existing SNS topic.
`support@checksops.com` is Confirmed. `security@checksops.com` left
pending. Temporary CW Logs role stack is gone; hardening temp role stack
`cursor-security-hardening-role` is still live. Do not broaden staging.
Do not delete the trail stack. See
`aws/cutover/OPERATOR_SECURITY_HANDOFF_2TO6.md`.

### Proposed follow-up — CloudTrail to CloudWatch Logs (**PASS**)

`IamSecurityChanges` now has CloudTrail → CloudWatch Logs delivery on
`checksops-production-mgmt-events`. Stack
`checksops-production-security-trail-cwlogs` is **CREATE_COMPLETE**.
Template: `aws/production/security-cloudtrail-cwlogs.yaml`.
Do **not** use `security-monitoring.yaml` or recreate the trail.
Do **not** modify `ChecksOpsCursorSecurityHardeningTemp`.

Operator identity: `ChecksOpsCursorCloudTrailCwLogsTemp` (stack now gone;
assume AccessDenied). See `aws/cutover/OPERATOR_CLOUDTRAIL_CWLOGS_ROLE.md`.
Hardening temp role **still exists**. Do not broaden staging. Do not start
API-behind-CloudFront or financial activation.
