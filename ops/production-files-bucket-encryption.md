# Production files bucket: turn S3 Bucket Keys off (compliance document uploads)

**What breaks today.** After the CORS fix (`ops/production-files-bucket-cors.md`, applied
2026-11-04T15:01:52Z), Compliance & Docs uploads in production reach the bucket and fail with
"Upload failed (403)." (tenant Condition One, three bank statements, 2026-11-04 15:11Z).

**Evidence (read-only, 2026-11-04).**
- API Gateway access log: `moov-document-upload-url` 200 at 15:11:02Z, then no finalize: the
  browser's presigned PUT was refused.
- CloudTrail: `GenerateDataKey` **AccessDenied** at 15:11:03Z (request id
  `e5882379-206a-43f2-ad6d-f691dd772f77`), caller
  `checksops-production-api-execution/checksops-production-prep-api`, invoked by S3, on the
  compliance documents key `59d713da-72f3-43a6-8a48-a826d432d53f`
  (`alias/checksops-production-compliance-documents`).
- That key's policy (`aws/production/onboarding-keys.yaml`, statement `ProductionApiRoleViaS3`)
  allows the API role `kms:GenerateDataKey` and `kms:Decrypt` only via S3 and only when
  `kms:EncryptionContext:aws:s3:arn` is like
  `arn:aws:s3:::checksops-production-privatefiles-806168576068/files/verification-docs/*`.
- The production bucket's default encryption has `BucketKeyEnabled: true`. With an S3 Bucket Key,
  S3 asks KMS with the **bucket** ARN as the encryption context, not the object ARN, so the
  condition can never match and every SSE-KMS write is refused.
- The staging bucket has `BucketKeyEnabled: false` (staging key policy has the same per-object
  condition), and staging uploads work.

**The change.** `ops/production-files-bucket-encryption/before-2026-11-04.json` is the live
default encryption as read (`GetBucketEncryption`). `after.json` is the same with
`BucketKeyEnabled: false`, which equals the staging bucket's rules exactly. Default encryption stays
SSE-S3 (`AES256`) and SSE-C stays blocked. Existing objects are not changed (Bucket Key only affects
new SSE-KMS writes; only compliance documents are written with SSE-KMS). KMS request volume for
these documents is a handful per upload.

No Lambda, IAM, key policy, CORS, bucket policy or SQL change. The owner chose to apply bucket
settings by hand (as for CORS on 2026-11-04 and staging on 2026-10-19): no guarded workflow manages
them and the deploy role cannot change them.

## Steps (the owner, as `michael-admin`, from an LF checkout of main after this PR merges)

Sign in first if needed (`aws sso login`, then `aws sts get-caller-identity`). Paste as one block;
it stops at the first problem.

```bash
cd /home/carle/ChecksOps && git checkout main && git pull --ff-only && bash -euo pipefail -c '
B=checksops-production-privatefiles-806168576068
aws s3api get-bucket-encryption --bucket "$B" --query ServerSideEncryptionConfiguration --output json > /tmp/enc-live.json
diff <(python3 -m json.tool --sort-keys /tmp/enc-live.json) <(python3 -m json.tool --sort-keys ops/production-files-bucket-encryption/before-2026-11-04.json)
echo "LIVE MATCHES BEFORE"
aws s3api put-bucket-encryption --bucket "$B" --server-side-encryption-configuration file://ops/production-files-bucket-encryption/after.json
aws s3api get-bucket-encryption --bucket "$B" --query ServerSideEncryptionConfiguration --output json > /tmp/enc-live.json
diff <(python3 -m json.tool --sort-keys /tmp/enc-live.json) <(python3 -m json.tool --sort-keys ops/production-files-bucket-encryption/after.json)
echo "LIVE MATCHES AFTER"'
```

Then tell Claude: a read-only check re-reads the setting and the CloudTrail event, and a record PR
adds the result here. Then the tenant retries the upload (document type **Bank statement**).

**Rollback.** Run the `put-bucket-encryption` line with `before-2026-11-04.json`. That brings back
the refused uploads.
