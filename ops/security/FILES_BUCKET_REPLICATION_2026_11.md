# Production files bucket: copy to `us-east-2` (S3 replication)

**Owner:** Michael Carletta, CEO — runs the commands in CloudShell as `michael-admin`. The
`claude-code` IAM user is denied changes to this bucket and to IAM.
**Matrix rows:** CC9.1, A1.2 (`docs/compliance/SOC2_CONTROL_MATRIX.md`); risk R7
(`docs/compliance/RISK_REGISTER.md`); `docs/compliance/BCP_DR.md` §1 ("Files: not covered").
**Why:** the database has been copied to `us-east-2` since 2026-11-06, but uploaded files (check
images, endorsement and signature documents, compliance documents) live only in `us-east-1`. Losing
the region or the bucket would lose them.

## Live state this runbook was written against (read-only as `claude-code`, 2026-11-08 22:24 UTC)

| Setting | Value |
|---|---|
| Source bucket | `checksops-production-privatefiles-806168576068` (`us-east-1`), about 1,641 objects, 2.75 GB (CloudWatch, 2026-11-07) |
| Versioning | Enabled (replication requires it) |
| Default encryption | SSE-S3 (`AES256`), Bucket Key off, SSE-C blocked (`ops/production-files-bucket-encryption.md`) |
| KMS-encrypted objects | Compliance documents under `files/verification-docs/` are written with SSE-KMS (`alias/checksops-production-compliance-documents`) |
| Replication | none |
| Object Lock | none |
| Ownership | BucketOwnerEnforced; Block Public Access all four on |
| Bucket policy | denies the staging API role; allows the production API role read, write and delete. No statement denies other principals |
| `us-east-2` | no bucket yet; KMS alias `alias/checksops-production-rds-dr` exists (database copies) |

Re-read it in step 0. If anything differs, stop.

## What this sets up

**Phase 1 (this runbook): every object that is not KMS-encrypted.**
1. A new private bucket `checksops-production-privatefiles-dr-806168576068` in `us-east-2`:
   versioning on, Block Public Access on, bucket owner enforced, SSE-S3 default with SSE-C
   blocked, and a policy that refuses non-TLS requests.
2. An IAM role `checksops-production-files-replication` that S3 and S3 Batch Operations use. It
   can read the source bucket's versions and write replicas into the new bucket, and nothing else.
3. A replication rule on the source bucket that copies new and changed objects. **Deletes are not
   copied** (delete marker replication off), so a deletion or a ransomware wipe in `us-east-1`
   cannot remove the `us-east-2` copy.
4. A one-time S3 Batch Replication job that copies the objects already in the bucket.

**Phase 2 (separate, later): the KMS-encrypted compliance documents.** Copying these needs:
- a `us-east-2` KMS key for the replicas;
- the replication role added to the compliance-documents key policy. That key is managed by
  `aws/production/onboarding-keys.yaml` through the guarded workflow
  `guarded-production-onboarding-keys.yml`, so it gets its own reviewed PR and run.
- `SseKmsEncryptedObjects` turned on in the rule.

Until then, Batch Replication reports those objects as failed. That is expected, and the record
says how many.

**Cost (estimate, `us-east-2` list prices):** about 2.75 GB of storage, roughly $0.06 a month; a
one-time transfer of about $0.06 (inter-region $0.02/GB); Batch Operations about $0.25 per job plus
$1 per million objects. New uploads add the same per GB.

## Step 0 — read the current state (CloudShell, read-only)

```bash
export AWS_REGION=us-east-1
SRC=checksops-production-privatefiles-806168576068
DST=checksops-production-privatefiles-dr-806168576068
ACCOUNT=806168576068
aws s3api get-bucket-versioning --bucket "$SRC"
aws s3api get-bucket-replication --bucket "$SRC" 2>&1 | grep -q ReplicationConfigurationNotFoundError && echo "OK: no replication yet"
aws s3api head-bucket --bucket "$DST" 2>&1 | grep -qE '404|Not Found' && echo "OK: destination does not exist yet"
aws iam get-role --role-name checksops-production-files-replication 2>&1 | grep -q NoSuchEntity && echo "OK: role does not exist yet"
```

Stop unless versioning is `Enabled` and all three print OK.

## Step 1 — the destination bucket (CloudShell)

```bash
aws s3api create-bucket --bucket "$DST" --region us-east-2 \
  --create-bucket-configuration LocationConstraint=us-east-2 --object-ownership BucketOwnerEnforced
aws s3api put-public-access-block --bucket "$DST" --region us-east-2 \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket "$DST" --region us-east-2 --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$DST" --region us-east-2 --server-side-encryption-configuration '{
  "Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":false,
            "BlockedEncryptionTypes":{"EncryptionType":["SSE-C"]}}]}'
aws s3api put-bucket-policy --bucket "$DST" --region us-east-2 --policy "{
  \"Version\":\"2012-10-17\",
  \"Statement\":[{\"Sid\":\"DenyInsecureTransport\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",
    \"Resource\":[\"arn:aws:s3:::$DST\",\"arn:aws:s3:::$DST/*\"],
    \"Condition\":{\"Bool\":{\"aws:SecureTransport\":\"false\"}}}]}"
aws s3api put-bucket-lifecycle-configuration --bucket "$DST" --region us-east-2 --lifecycle-configuration '{
  "Rules":[{"ID":"AbortIncompleteMultipartUploads","Filter":{"Prefix":""},"Status":"Enabled",
            "AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}}]}'
```

## Step 2 — the replication role (CloudShell)

```bash
aws iam create-role --role-name checksops-production-files-replication \
  --description "S3 replication and batch replication of the production files bucket to us-east-2" \
  --assume-role-policy-document "{
  \"Version\":\"2012-10-17\",
  \"Statement\":[{\"Effect\":\"Allow\",
    \"Principal\":{\"Service\":[\"s3.amazonaws.com\",\"batchoperations.s3.amazonaws.com\"]},
    \"Action\":\"sts:AssumeRole\",
    \"Condition\":{\"StringEquals\":{\"aws:SourceAccount\":\"$ACCOUNT\"}}}]}"
aws iam put-role-policy --role-name checksops-production-files-replication --policy-name FilesReplication --policy-document "{
  \"Version\":\"2012-10-17\",
  \"Statement\":[
    {\"Sid\":\"ReadSourceConfig\",\"Effect\":\"Allow\",
     \"Action\":[\"s3:GetReplicationConfiguration\",\"s3:ListBucket\",\"s3:PutInventoryConfiguration\"],
     \"Resource\":\"arn:aws:s3:::$SRC\"},
    {\"Sid\":\"ReadSourceVersions\",\"Effect\":\"Allow\",
     \"Action\":[\"s3:GetObjectVersionForReplication\",\"s3:GetObjectVersionAcl\",\"s3:GetObjectVersionTagging\",\"s3:InitiateReplication\"],
     \"Resource\":\"arn:aws:s3:::$SRC/*\"},
    {\"Sid\":\"WriteReplicas\",\"Effect\":\"Allow\",
     \"Action\":[\"s3:ReplicateObject\",\"s3:ReplicateDelete\",\"s3:ReplicateTags\"],
     \"Resource\":\"arn:aws:s3:::$DST/*\"},
    {\"Sid\":\"BatchReports\",\"Effect\":\"Allow\",
     \"Action\":[\"s3:PutObject\",\"s3:GetObject\",\"s3:GetObjectVersion\"],
     \"Resource\":\"arn:aws:s3:::$DST/_replication-reports/*\"},
    {\"Sid\":\"BatchReportsBucket\",\"Effect\":\"Allow\",
     \"Action\":[\"s3:GetBucketLocation\"],\"Resource\":\"arn:aws:s3:::$DST\"}]}"
sleep 15   # IAM propagation before S3 uses the role
```

`s3:ReplicateDelete` is needed for the API's version handling, but the rule below keeps delete
marker replication **off**, so deletes are not copied.

## Step 3 — the replication rule (CloudShell)

```bash
aws s3api put-bucket-replication --bucket "$SRC" --replication-configuration "{
  \"Role\":\"arn:aws:iam::$ACCOUNT:role/checksops-production-files-replication\",
  \"Rules\":[{\"ID\":\"CopyToUsEast2\",\"Priority\":1,\"Status\":\"Enabled\",
    \"Filter\":{\"Prefix\":\"\"},
    \"DeleteMarkerReplication\":{\"Status\":\"Disabled\"},
    \"Destination\":{\"Bucket\":\"arn:aws:s3:::$DST\",\"StorageClass\":\"STANDARD\"}}]}"
aws s3api get-bucket-replication --bucket "$SRC" --query 'ReplicationConfiguration.Rules[0].[ID,Status,DeleteMarkerReplication.Status,Destination.Bucket]' --output text
```

New uploads now copy within minutes. Existing objects need step 4.

## Step 4 — copy the existing objects (S3 Batch Replication, CloudShell)

```bash
JOB=$(aws s3control create-job --region us-east-1 --account-id "$ACCOUNT" \
  --operation '{"S3ReplicateObject":{}}' \
  --priority 10 --no-confirmation-required \
  --role-arn "arn:aws:iam::$ACCOUNT:role/checksops-production-files-replication" \
  --report "{\"Bucket\":\"arn:aws:s3:::$DST\",\"Prefix\":\"_replication-reports\",\"Format\":\"Report_CSV_20180820\",\"Enabled\":true,\"ReportScope\":\"FailedTasksOnly\"}" \
  --manifest-generator "{\"S3JobManifestGenerator\":{\"ExpectedBucketOwner\":\"$ACCOUNT\",\"SourceBucket\":\"arn:aws:s3:::$SRC\",
     \"EnableManifestOutput\":false,
     \"Filter\":{\"EligibleForReplication\":true,\"ObjectReplicationStatuses\":[\"NONE\",\"FAILED\"]}}}" \
  --description "files bucket initial copy to us-east-2" --query JobId --output text)
echo "JOB=$JOB"
# Check every few minutes until Status is Complete:
aws s3control describe-job --region us-east-1 --account-id "$ACCOUNT" --job-id "$JOB" \
  --query 'Job.[Status,ProgressSummary.TotalNumberOfTasks,ProgressSummary.NumberOfTasksSucceeded,ProgressSummary.NumberOfTasksFailed]' --output text
```

With about 1,600 objects it should finish in minutes. Failed tasks should only be the KMS-encrypted
compliance documents (Phase 2); the failure report under `_replication-reports/` lists their keys.
**Do not paste the report into the record**: keys can contain tenant ids. Count them instead.

## Step 5 — check (CloudShell, read-only)

```bash
aws s3api get-bucket-replication --bucket "$SRC" --query 'ReplicationConfiguration.Rules[0].Status' --output text
aws s3api get-bucket-versioning --bucket "$DST" --region us-east-2 --query Status --output text
aws s3api get-public-access-block --bucket "$DST" --region us-east-2 --output text
# Spot-check one new upload: after any user uploads a file, its replication status turns COMPLETED.
aws s3api list-object-versions --bucket "$DST" --region us-east-2 --max-items 5 --query 'Versions[].[Key,LastModified]' --output text | cut -c1-40
```

Tell Claude when it's done. Claude re-reads the configuration read-only, then opens the record PR,
which updates this runbook's Applied section, `BCP_DR.md` §1 and the matrix row CC9.1.

## Rollback

Each piece can be removed without touching the source objects:
- `aws s3api delete-bucket-replication --bucket "$SRC"` stops copying (source unchanged).
- The destination bucket and the role can then be deleted. Only do this on purpose: the copy is
  the point.

## Applied 2026-11-09 (phase 1)

Run by the owner in CloudShell as `michael-admin` (IAM Identity Center, permission set
`AdministratorAccess`, not root), from main `4b4c05863`. Step 0 printed all four OK lines.

| Step | CloudTrail (UTC, event id, caller `michael-admin`, no error code) |
|---|---|
| 1. Destination bucket | `CreateBucket` (us-east-2) 11:13:45, `c83f873b-5872-464c-bb4f-8e99fa34a3c5`; `PutBucketPolicy` 11:13:49, `b7ebc0de-1a8b-4375-9845-e7245ecfbf00` |
| 2. Replication role | `CreateRole` 11:17:02, `83f2accd-7cf9-4188-9bec-82b3828d311d`; `PutRolePolicy` 11:17:03, `8f97a401-7ac8-4d50-b3e8-d42f0c2ad6d0` |
| 3. Replication rule | `PutBucketReplication` 11:18:19, `443e6541-7fc6-4a71-a944-33886b615c42` |
| 4. Existing objects | `CreateJob` 11:19:08, `f33da9d6-8c7e-41d5-9df2-1dd12cd4d61a`: S3 Batch Replication job `465449a6-41df-4ed5-a36f-694da9d1a4c7`, **Complete, 1,592 tasks, 1,592 succeeded, 0 failed**, 144 s active |

**Read-only checks afterwards (as `claude-code`):**
- **Destination bucket** `checksops-production-privatefiles-dr-806168576068`: region `us-east-2`; versioning Enabled; Block Public Access all four on; SSE-S3 with Bucket Key off and SSE-C blocked; BucketOwnerEnforced; policy `DenyInsecureTransport` only; lifecycle aborts incomplete uploads after 7 days.
- **Role** `checksops-production-files-replication`: trust limited to `s3.amazonaws.com` and `batchoperations.s3.amazonaws.com` with `aws:SourceAccount` 806168576068; one inline policy `FilesReplication` with exactly the five statements in step 2; no managed policies.
- **Source rule**: `CopyToUsEast2` Enabled, delete marker replication Disabled, role `checksops-production-files-replication`.
- **Copy**: 1,572 current objects (2.72 GB) in the destination, plus 2 batch report objects. The job's 1,592 tasks are object versions. The source held 1,641 versions (CloudWatch `NumberOfObjects`, 2026-11-07); the 49 not copied are the SSE-KMS compliance documents (no `files/verification-docs/` keys in the copy) and delete markers, which the rule leaves out by design.

**Still open (phase 2):** the SSE-KMS compliance documents. They need a `us-east-2` KMS key, the replication role in the compliance-documents key policy, and `SseKmsEncryptedObjects` on the rule. That is a separate reviewed change. The key policy part is done: the replication role may decrypt `files/verification-docs/*` through S3 since 2026-11-09 12:40 UTC (guarded update run 42618763202, recorded in `ops/production-onboarding-keys.md`, "Applied 2026-11-09").
