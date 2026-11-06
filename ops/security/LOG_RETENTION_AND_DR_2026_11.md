# Log retention to policy, and database backups in a second region

Owner, 2026-11-06: "Log retention, AWS settings match policy" and "Recovery outside - copy
database to second region".

This runbook changes nothing by itself. The `claude-code` IAM user is denied every change below
(`iam:SimulatePrincipalPolicy`, 2026-11-06: `logs:PutRetentionPolicy`, `s3:PutLifecycleConfiguration`,
`rds:StartDBInstanceAutomatedBackupsReplication` and `kms:CreateKey` are all `implicitDeny`), so the
owner runs each step in AWS CloudShell, signed in as the named admin login, not root. Each step is a
read-only pre-check, the change, and a read-only verification. Stop if a pre-check differs.

Policy: `docs/DATA_RETENTION.md` §2 (cloud audit logs 7 years; application logs 90 days) and
`docs/compliance/BCP_DR.md` §4.

## Live state (read-only, 2026-11-06 18:20–18:40 UTC, `user/claude-code`)

| Item | Live |
|---|---|
| `checksops-production-security-logs-806168576068` | Prefixes `cloudtrail/` and `config/`. Versioning on, no Object Lock. One lifecycle rule `retain-365`: expire all objects after 365 days. |
| CloudTrail log group `/aws/cloudtrail/checksops-production-mgmt-events` | 365 days |
| CloudWatch log groups | 325 in total. 319 never expire: 318 under `/aws/lambda/` (210 of them staging), plus `/aws/rds/instance/checksops-production/postgresql`. Six have a retention set: API access log 90, CloudTrail 365, prep-api Lambda 30, VPC flow log 90, a staging test harness 1, `RDSOSMetrics` 30. |
| RDS `checksops-production` | Encrypted with the AWS-managed key `aws/rds` (`ce55869a-…`), Multi-AZ, 35-day backups. No replicated automated backups in `us-east-2`. |

## Step 1 — cloud audit logs kept 7 years (S3)

The S3 copy of CloudTrail and AWS Config is the 7-year record. The CloudWatch copy of CloudTrail
stays at 365 days for searching.

Change: move objects to Glacier Flexible Retrieval after 90 days, delete them after 2,557 days
(7 years), and delete old versions 30 days after they are replaced.

```bash
B=checksops-production-security-logs-806168576068

# Pre-check: exactly one rule, ID retain-365, Expiration Days 365
aws s3api get-bucket-lifecycle-configuration --bucket "$B"

# Change
aws s3api put-bucket-lifecycle-configuration --bucket "$B" --lifecycle-configuration '{
  "Rules": [{
    "ID": "audit-logs-7-years",
    "Filter": {"Prefix": ""},
    "Status": "Enabled",
    "Transitions": [{"Days": 90, "StorageClass": "GLACIER"}],
    "Expiration": {"Days": 2557},
    "NoncurrentVersionExpiration": {"NoncurrentDays": 30}
  }]
}'

# Verify: one rule, audit-logs-7-years, Expiration 2557, Transition 90 GLACIER
aws s3api get-bucket-lifecycle-configuration --bucket "$B"
```

Rollback: put the old rule back
(`{"Rules":[{"ID":"retain-365","Filter":{"Prefix":""},"Status":"Enabled","Expiration":{"Days":365}}]}`).
Objects already older than 365 days were deleted under the old rule; this change cannot recover
them. Logs from 2026-09-07 onward (when the trail started) are all still inside the window.

Cost: Glacier storage for a few GB a year; reading old logs back takes hours and costs a retrieval
fee.

## Step 2 — application logs kept 90 days (CloudWatch)

Setting a retention deletes events older than the period straight away. Every group in scope is
operational logging; the evidence for each production change is recorded in the repository (run
ids, command ids, CloudTrail events), not only in these logs.

```bash
# Pre-check: list what will change (expect 319 lines today)
aws logs describe-log-groups --query 'logGroups[?retentionInDays==`null`].logGroupName' --output text | tr '\t' '\n' | wc -l

# Change: every group with no retention gets 90 days
for g in $(aws logs describe-log-groups --query 'logGroups[?retentionInDays==`null`].logGroupName' --output text); do
  aws logs put-retention-policy --log-group-name "$g" --retention-in-days 90
done
# The production API Lambda is at 30 days, below the policy
aws logs put-retention-policy --log-group-name /aws/lambda/checksops-production-prep-api --retention-in-days 90

# Verify: 0 groups without retention, and prep-api at 90
aws logs describe-log-groups --query 'length(logGroups[?retentionInDays==`null`])'
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/checksops-production-prep-api --query 'logGroups[].retentionInDays'
```

Left as they are: the CloudTrail log group (365, see step 1), the API access log and VPC flow log
(90), `RDSOSMetrics` (30, metrics), and the staging test harness (1).

New log groups are created with no retention. The monthly security review (evidence calendar row
V-1) repeats the verification command and fixes any group it finds.

Rollback: `aws logs delete-retention-policy --log-group-name <group>` (events already deleted stay
deleted).

## Step 3 — database backups copied to `us-east-2`

RDS cross-region automated backup replication copies the snapshots and transaction logs to
`us-east-2`, so the database can be restored there to any point in the retention window if
`us-east-1` is lost. KMS keys are regional, so the copies need a key in `us-east-2`.

```bash
SRC=arn:aws:rds:us-east-1:806168576068:db:checksops-production

# Pre-check: empty list
aws rds describe-db-instance-automated-backups --region us-east-2 --query 'DBInstanceAutomatedBackups[].DBInstanceArn'

# 3a: a customer-managed key in us-east-2 for the replicated backups
KEY=$(aws kms create-key --region us-east-2 \
  --description "checksops-production RDS backups replicated from us-east-1" \
  --query KeyMetadata.Arn --output text)
aws kms create-alias --region us-east-2 --alias-name alias/checksops-production-rds-dr --target-key-id "$KEY"
echo "$KEY"   # record the ARN below

# 3b: start replication, same 35-day window as the source
aws rds start-db-instance-automated-backups-replication --region us-east-2 \
  --source-db-instance-arn "$SRC" --backup-retention-period 35 --kms-key-id "$KEY"

# Verify (status moves from pending to replicating; can take a while for the first copy)
aws rds describe-db-instance-automated-backups --region us-east-2 \
  --query 'DBInstanceAutomatedBackups[].[DBInstanceArn,Status,BackupRetentionPeriod,KmsKeyId,RestoreWindow.LatestTime]'
```

The source instance does not restart. Cost: backup storage in `us-east-2` plus cross-region data
transfer for the snapshot and transaction logs; check the next bill.

Rollback: `aws rds stop-db-instance-automated-backups-replication --region us-east-2
--source-db-instance-arn "$SRC"`. The KMS key can then be scheduled for deletion (7–30 days).

**Not in this step:** the private-files bucket (check images, documents) stays in `us-east-1` only.
Copying it to a second region (S3 Cross-Region Replication) is a separate decision.

After step 3, the first restore test (evidence calendar row B-1) should restore into `us-east-2`
from the replicated backups, to prove the copy works.

## Applied

Record each step: who, when (UTC), the verification output, and anything that differed. For step 3,
the KMS key ARN.
