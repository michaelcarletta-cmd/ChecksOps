# Operator runbook: KMS encryption for security alerts and CloudTrail

**Account:** `806168576068`  
**Region:** `us-east-1`  
**Status:** PROPOSED. Nothing in this runbook has been applied.

Encrypts two production resources with one new customer managed key:

| resource | live state read 2026-11-18 (read-only) |
|---|---|
| SNS topic `checksops-production-security-alerts` (stack `checksops-production-security-sns`) | no `KmsMasterKeyId` |
| CloudTrail trail `checksops-production-mgmt-events` (created by CLI, owned by no stack) | no `KmsKeyId`; multi-region, log-file validation on, CloudWatch Logs delivery on |

Detection only. No application change. No staging change. Money/provider
flags stay **OFF**. Run from a privileged ops / Administrator principal,
one step at a time, each step with the owner's approval for that step.
Stop at the first check that does not match and report it.

Why a customer managed key: CloudWatch alarms cannot publish to a topic
encrypted with the AWS managed key `alias/aws/sns`, because its key policy
cannot be edited. A wrong key policy stops security alert emails without
any visible error outside the alarm history, so step 2 ends with a
delivery test. Cost: one KMS key (about $1 a month) plus request charges.

Do **not** deploy `security-monitoring.yaml`, and do **not** touch the
stacks `checksops-production-cloudtrail` or
`checksops-production-security-trail`.

## Step 1: create the key

```bash
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name checksops-production-security-kms \
  --template-file aws/production/security-kms.yaml \
  --no-fail-on-empty-changeset
```

```bash
aws cloudformation describe-stacks \
  --region us-east-1 \
  --stack-name checksops-production-security-kms \
  --query 'Stacks[0].Outputs'
```

Record `SecurityMonitoringKeyArn`. Check:

- `aws kms describe-key --key-id alias/checksops-production-security-monitoring`
  shows `KeyState: Enabled` and `KeyManager: CUSTOMER`.
- `aws kms get-key-rotation-status --key-id <key arn>` shows
  `KeyRotationEnabled: true`.

Nothing uses the key yet.

Rollback: leave the stack in place (the key is retained on stack deletion
by design); an unused key can be scheduled for deletion separately.

## Step 2: encrypt the SNS topic

Update the existing stack with the new template and the key ARN. Keep every
other parameter at its current value.

```bash
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name checksops-production-security-sns \
  --template-file aws/production/security-alerts-sns.yaml \
  --parameter-overrides AlertTopicKmsKeyArn=<SecurityMonitoringKeyArn>
```

Review the change set before executing: the only change is `Modify` on
`AlertTopic` with **Replacement: False**. A replacement, or any change to a
subscription, is a stop.

Check:

```bash
aws sns get-topic-attributes \
  --region us-east-1 \
  --topic-arn arn:aws:sns:us-east-1:806168576068:checksops-production-security-alerts \
  --query 'Attributes.[KmsMasterKeyId,SubscriptionsConfirmed,SubscriptionsPending]'
```

`KmsMasterKeyId` is the key ARN and the subscription counts are unchanged.

Delivery test (required). Force one alarm into ALARM; it returns to its real
state at its next evaluation:

```bash
aws cloudwatch set-alarm-state \
  --region us-east-1 \
  --alarm-name checksops-prod-lambda-throttles \
  --state-value ALARM \
  --state-reason "Operator test: encrypted security alerts topic"
```

```bash
aws cloudwatch describe-alarm-history \
  --region us-east-1 \
  --alarm-name checksops-prod-lambda-throttles \
  --history-item-type Action \
  --max-records 3
```

Pass: the newest action entry says the SNS action was executed
successfully, and the alert email arrives. Fail: an entry containing
`does not have authorization to access the SNS topic encryption key`.

Rollback: run the same `deploy` with `AlertTopicKmsKeyArn=` (empty), then
repeat the delivery test.

## Step 3: encrypt CloudTrail log files

The trail is not owned by a stack, so this is one CLI call.

```bash
aws cloudtrail update-trail \
  --region us-east-1 \
  --name checksops-production-mgmt-events \
  --kms-key-id <SecurityMonitoringKeyArn>
```

Check, about 15 minutes later:

```bash
aws cloudtrail describe-trails \
  --region us-east-1 \
  --trail-name-list checksops-production-mgmt-events \
  --query 'trailList[0].[KmsKeyId,IsMultiRegionTrail,LogFileValidationEnabled,CloudWatchLogsLogGroupArn,S3BucketName,S3KeyPrefix]'
```

```bash
aws cloudtrail get-trail-status \
  --region us-east-1 \
  --name checksops-production-mgmt-events \
  --query '[IsLogging,LatestDeliveryError,LatestDeliveryTime,LatestCloudWatchLogsDeliveryError]'
```

Pass: `KmsKeyId` is the key ARN, every other field is as before,
`IsLogging` is `true`, both error fields are empty, and
`LatestDeliveryTime` is after the update. A new object under
`s3://checksops-production-security-logs-806168576068/cloudtrail/` has
`ServerSideEncryption: aws:kms` in `aws s3api head-object`.

Existing log files stay as they are; only new files use the key. Reading
new log files now needs `kms:Decrypt` on the key in the reader's IAM
policy.

Rollback:

```bash
aws cloudtrail update-trail \
  --region us-east-1 \
  --name checksops-production-mgmt-events \
  --kms-key-id ""
```

Do not disable or delete the key while any log file encrypted with it must
stay readable.

## Record

After each step, record in the PR that reports it: the stack event or
request id, the checked values above, and the time. A step that was not
run is reported as not run.
