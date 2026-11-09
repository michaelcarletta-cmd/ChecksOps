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

## Phase 2 — the KMS-encrypted compliance documents (CloudShell)

**What it adds.** Compliance documents under `files/verification-docs/` (Moov onboarding uploads)
are SSE-KMS with the compliance documents key `59d713da-72f3-43a6-8a48-a826d432d53f`
(`alias/checksops-production-compliance-documents`), per object, without an S3 Bucket Key
(`aws/functions/api/providers/onboarding/documents.mjs`), so each object's KMS encryption context
is its own ARN. Phase 1 copies everything else. Phase 2 copies these with their own key in
`us-east-2`:

| Piece | Change |
|---|---|
| Source key policy | **Done 2026-11-09** (guarded update run 42618763202, `ops/production-onboarding-keys.md`): the replication role may `kms:Decrypt` through S3 in `us-east-1`, only under `files/verification-docs/*`. |
| `us-east-2` key | New customer managed key `alias/checksops-production-compliance-documents-dr`, rotation on. Its policy mirrors the source key: the account may administer it (the same 24 administration actions, no use), and the replication role may only `kms:Encrypt` through S3 in `us-east-2` under `files/verification-docs/*` of the copy bucket. **Nobody can decrypt the copies** until a recovery adds a statement for the restore role (the administration statement allows that `PutKeyPolicy`). |
| Replication role | Two statements added to `FilesReplication`: `kms:Decrypt` on the source key and `kms:Encrypt` on the new key, each with the same S3 and prefix conditions as the key policies. |
| Replication rule | `CopyToUsEast2` gains `SourceSelectionCriteria.SseKmsEncryptedObjects` Enabled and `Destination.EncryptionConfiguration.ReplicaKmsKeyID` = the new key. SSE-S3 objects keep replicating as SSE-S3. Delete markers stay off. |
| Existing documents | A second S3 Batch Replication job, only `files/verification-docs/`, only objects not yet copied. |

Live state read 2026-11-09 13:20 UTC as `claude-code`: the rule is the phase 1 rule (no
`SourceSelectionCriteria`, no `EncryptionConfiguration`); the role has only the five phase 1
statements; no `checksops` alias in `us-east-2` other than `alias/checksops-production-rds-dr`.

Run as `michael-admin` (access portal, not root). Each step stops on the first surprise.

### Phase 2 step 0 — read the current state (read-only)

```bash
export AWS_REGION=us-east-1
SRC=checksops-production-privatefiles-806168576068
DST=checksops-production-privatefiles-dr-806168576068
ACCOUNT=806168576068
ROLE=checksops-production-files-replication
SRC_KEY=arn:aws:kms:us-east-1:$ACCOUNT:key/59d713da-72f3-43a6-8a48-a826d432d53f
DR_ALIAS=alias/checksops-production-compliance-documents-dr
aws kms get-key-policy --key-id "$SRC_KEY" --policy-name default --output text | grep -q FilesReplicationRoleDecryptViaS3 && echo "OK: source key policy lets the role decrypt"
aws kms describe-key --region us-east-2 --key-id "$DR_ALIAS" 2>&1 | grep -q NotFoundException && echo "OK: no us-east-2 documents key yet"
aws s3api get-bucket-replication --bucket "$SRC" --output json | python3 -c '
import json,sys; r=json.load(sys.stdin)["ReplicationConfiguration"]["Rules"]
assert len(r)==1 and r[0]["ID"]=="CopyToUsEast2" and "SourceSelectionCriteria" not in r[0] and "EncryptionConfiguration" not in r[0]["Destination"]
print("OK: phase 1 rule, no KMS settings yet")'
aws iam get-role-policy --role-name "$ROLE" --policy-name FilesReplication --query PolicyDocument --output json | python3 -c '
import json,sys; s=[x["Sid"] for x in json.load(sys.stdin)["Statement"]]
assert s==["ReadSourceConfig","ReadSourceVersions","WriteReplicas","BatchReports","BatchReportsBucket"], s
print("OK: role has the five phase 1 statements")'
# How the compliance documents are encrypted (counts only; keys contain tenant ids, never print them):
aws s3api list-object-versions --bucket "$SRC" --prefix files/verification-docs/ --query 'Versions[].[Key,VersionId]' --output text \
 | while read -r k v; do aws s3api head-object --bucket "$SRC" --key "$k" --version-id "$v" \
     --query '[ServerSideEncryption,SSEKMSKeyId,BucketKeyEnabled,ReplicationStatus]' --output text; done | sort | uniq -c
```

Stop unless all four print OK, and every line of the count reads
`aws:kms  arn:aws:kms:us-east-1:806168576068:key/59d713da-…  None  FAILED` (or `None` as the last
field). `BucketKeyEnabled` must be `None` or `False`: with a Bucket Key the encryption context would
be the bucket, and the key policies would refuse it.

### Phase 2 step 1 — the `us-east-2` key

```bash
python3 - <<'PY' > /tmp/dr-key-policy.json
import json
acct = "806168576068"
admin = ["kms:DescribeKey","kms:GetKeyPolicy","kms:PutKeyPolicy","kms:ListKeyPolicies","kms:ListResourceTags",
  "kms:ListAliases","kms:ListGrants","kms:GetKeyRotationStatus","kms:EnableKeyRotation","kms:DisableKeyRotation",
  "kms:RotateKeyOnDemand","kms:ListKeyRotations","kms:EnableKey","kms:DisableKey","kms:UpdateKeyDescription",
  "kms:CreateAlias","kms:UpdateAlias","kms:DeleteAlias","kms:RevokeGrant","kms:RetireGrant","kms:TagResource",
  "kms:UntagResource","kms:ScheduleKeyDeletion","kms:CancelKeyDeletion"]
print(json.dumps({"Version": "2012-10-17", "Statement": [
  {"Sid": "KeyAdministrationOnly", "Effect": "Allow", "Principal": {"AWS": f"arn:aws:iam::{acct}:root"},
   "Action": admin, "Resource": "*"},
  {"Sid": "FilesReplicationRoleEncryptViaS3", "Effect": "Allow",
   "Principal": {"AWS": f"arn:aws:iam::{acct}:role/checksops-production-files-replication"},
   "Action": "kms:Encrypt", "Resource": "*",
   "Condition": {"StringEquals": {"kms:ViaService": "s3.us-east-2.amazonaws.com"},
                 "StringLike": {"kms:EncryptionContext:aws:s3:arn":
                   f"arn:aws:s3:::checksops-production-privatefiles-dr-{acct}/files/verification-docs/*"}}}]}))
PY
DR_KEY=$(aws kms create-key --region us-east-2 \
  --description "ChecksOps production compliance documents copy (us-east-2). Encrypt-only for S3 replication; no decrypt until a recovery adds it." \
  --key-spec SYMMETRIC_DEFAULT --key-usage ENCRYPT_DECRYPT --no-multi-region \
  --policy file:///tmp/dr-key-policy.json \
  --tags TagKey=checksops-purpose,TagValue=files-replication-dr \
  --query KeyMetadata.Arn --output text)
echo "DR_KEY=$DR_KEY"
aws kms enable-key-rotation --region us-east-2 --key-id "$DR_KEY"
aws kms create-alias --region us-east-2 --alias-name "$DR_ALIAS" --target-key-id "$DR_KEY"
aws kms get-key-rotation-status --region us-east-2 --key-id "$DR_KEY" --query KeyRotationEnabled --output text
```

Keep the printed `DR_KEY` for the next steps. Rotation must print `True`.

### Phase 2 step 2 — the role's KMS rights (read, add two statements, write)

```bash
aws iam get-role-policy --role-name "$ROLE" --policy-name FilesReplication --query PolicyDocument --output json > /tmp/repl.json
SRC_KEY="$SRC_KEY" DR_KEY="$DR_KEY" python3 - <<'PY'
import json, os
d = json.load(open('/tmp/repl.json'))
sids = [s["Sid"] for s in d["Statement"]]
assert "DecryptSourceComplianceDocuments" not in sids and "EncryptReplicaComplianceDocuments" not in sids, "already there"
src = "checksops-production-privatefiles-806168576068"; dst = "checksops-production-privatefiles-dr-806168576068"
d["Statement"] += [
  {"Sid": "DecryptSourceComplianceDocuments", "Effect": "Allow", "Action": "kms:Decrypt", "Resource": os.environ["SRC_KEY"],
   "Condition": {"StringEquals": {"kms:ViaService": "s3.us-east-1.amazonaws.com"},
                 "StringLike": {"kms:EncryptionContext:aws:s3:arn": f"arn:aws:s3:::{src}/files/verification-docs/*"}}},
  {"Sid": "EncryptReplicaComplianceDocuments", "Effect": "Allow", "Action": "kms:Encrypt", "Resource": os.environ["DR_KEY"],
   "Condition": {"StringEquals": {"kms:ViaService": "s3.us-east-2.amazonaws.com"},
                 "StringLike": {"kms:EncryptionContext:aws:s3:arn": f"arn:aws:s3:::{dst}/files/verification-docs/*"}}}]
json.dump(d, open('/tmp/repl-new.json', 'w'))
print("statements", len(sids), "->", len(d["Statement"]))
PY
aws iam put-role-policy --role-name "$ROLE" --policy-name FilesReplication --policy-document file:///tmp/repl-new.json
sleep 15   # IAM propagation before S3 uses the role
```

It must print `statements 5 -> 7`.

### Phase 2 step 3 — the rule copies KMS objects with the new key

```bash
aws s3api put-bucket-replication --bucket "$SRC" --replication-configuration "{
  \"Role\":\"arn:aws:iam::$ACCOUNT:role/$ROLE\",
  \"Rules\":[{\"ID\":\"CopyToUsEast2\",\"Priority\":1,\"Status\":\"Enabled\",
    \"Filter\":{\"Prefix\":\"\"},
    \"SourceSelectionCriteria\":{\"SseKmsEncryptedObjects\":{\"Status\":\"Enabled\"}},
    \"DeleteMarkerReplication\":{\"Status\":\"Disabled\"},
    \"Destination\":{\"Bucket\":\"arn:aws:s3:::$DST\",\"StorageClass\":\"STANDARD\",
      \"EncryptionConfiguration\":{\"ReplicaKmsKeyID\":\"$DR_KEY\"}}}]}"
aws s3api get-bucket-replication --bucket "$SRC" --query 'ReplicationConfiguration.Rules[0].[ID,Status,SourceSelectionCriteria.SseKmsEncryptedObjects.Status,DeleteMarkerReplication.Status,Destination.EncryptionConfiguration.ReplicaKmsKeyID]' --output text
```

It must print `CopyToUsEast2 Enabled Enabled Disabled <DR_KEY>`. Only the two KMS fields differ from
the phase 1 rule.

### Phase 2 step 4 — copy the existing compliance documents

```bash
JOB2=$(aws s3control create-job --region us-east-1 --account-id "$ACCOUNT" \
  --operation '{"S3ReplicateObject":{}}' \
  --priority 10 --no-confirmation-required \
  --role-arn "arn:aws:iam::$ACCOUNT:role/$ROLE" \
  --report "{\"Bucket\":\"arn:aws:s3:::$DST\",\"Prefix\":\"_replication-reports\",\"Format\":\"Report_CSV_20180820\",\"Enabled\":true,\"ReportScope\":\"FailedTasksOnly\"}" \
  --manifest-generator "{\"S3JobManifestGenerator\":{\"ExpectedBucketOwner\":\"$ACCOUNT\",\"SourceBucket\":\"arn:aws:s3:::$SRC\",
     \"EnableManifestOutput\":false,
     \"Filter\":{\"EligibleForReplication\":true,\"ObjectReplicationStatuses\":[\"NONE\",\"FAILED\"],
       \"KeyNameConstraint\":{\"MatchAnyPrefix\":[\"files/verification-docs/\"]}}}}" \
  --description "files bucket compliance documents copy to us-east-2" --query JobId --output text)
echo "JOB2=$JOB2"
# Check every minute or two until Status is Complete:
aws s3control describe-job --region us-east-1 --account-id "$ACCOUNT" --job-id "$JOB2" \
  --query 'Job.[Status,ProgressSummary.TotalNumberOfTasks,ProgressSummary.NumberOfTasksSucceeded,ProgressSummary.NumberOfTasksFailed]' --output text
```

Expect a few dozen tasks (phase 1 left about 49 versions, some of them delete markers, which the job
skips) and **0 failed**. If any fail, stop: the report under `_replication-reports/` says why. Do not
paste it into the record (keys contain tenant ids); count the error codes instead.

### Phase 2 step 5 — check (read-only)

```bash
aws s3api list-object-versions --bucket "$DST" --region us-east-2 --prefix files/verification-docs/ --query 'length(Versions)' --output text
aws s3api list-object-versions --bucket "$DST" --region us-east-2 --prefix files/verification-docs/ --query 'Versions[].[Key,VersionId]' --output text \
 | while read -r k v; do aws s3api head-object --bucket "$DST" --region us-east-2 --key "$k" --version-id "$v" \
     --query '[ServerSideEncryption,SSEKMSKeyId,ReplicationStatus]' --output text; done | sort | uniq -c
```

Every replica must read `aws:kms  <DR_KEY>  REPLICA`. Then tell Claude: it re-reads the rule, the
role, the new key's policy and rotation, and the CloudTrail events read-only, and opens the record PR.

### Phase 2 rollback

- **Rule:** put back the phase 1 rule (step 3 of phase 1). KMS objects stop copying; the copies stay.
- **Role:** remove the two statements (read, delete those two Sids, write).
- **Key:** keep it. Scheduling its deletion makes every compliance document copy unreadable; that is
  an owner decision with its own record, never part of a rollback.
