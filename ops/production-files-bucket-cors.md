# Production files bucket: allow the compliance document upload headers

**What breaks today.** On Compliance & Docs in production, every upload fails in the browser with
"Network error while uploading." (`src/lib/payments/moovOnboarding.ts` `xhrPut`). The presigned PUT
built by `aws/functions/api/providers/onboarding/documents.mjs` carries `Content-Type`,
`x-amz-server-side-encryption` and `x-amz-server-side-encryption-aws-kms-key-id` (the compliance
documents KMS key). The browser asks the bucket first (CORS preflight) whether it may send those
headers. The production bucket `checksops-production-privatefiles-806168576068` allows only
`content-type` on PUT, so the preflight is refused and the file is never sent. Reported by tenant
Condition One on 2026-11-04 (three bank statements).

**Why staging works.** The staging bucket's PUT rule allows `content-type`, `content-length` and both
SSE-KMS headers (`aws/template.yaml` `SpaPresignedUploads`), set 2026-10-19 (CloudTrail
PutBucketCors by `michael-admin`). The production bucket's CORS was last set 2026-09-22
(CloudTrail PutBucketCors by `checksops-p5-create`), before the production compliance documents
key existed (alias `alias/checksops-production-compliance-documents`, created 2026-10-30). The
production onboarding keys runbook (`ops/production-onboarding-keys.md`) had no bucket CORS step;
its step 6 test upload would have shown this.

**Why not drop the headers instead.** The bucket's default encryption is AES256 (SSE-S3), and
finalize refuses any document that is not SSE-KMS under the compliance documents key, so the
browser must send the SSE-KMS headers.

**Why a one-time owner change.** No guarded workflow manages bucket CORS, and the production deploy
role `ChecksOpsGitHubProductionLambdaOverlay` may not read or change it (IAM policy simulation
2026-11-04: `s3:GetBucketCORS` and `s3:PutBucketCORS` implicitDeny). The owner chose this path on
2026-11-04 ("Option 1"), as for staging on 2026-10-19.

## The change

`ops/production-files-bucket-cors/before-2026-11-04.json` is the live configuration read on
2026-11-04 (`GetBucketCors`, written as returned). `ops/production-files-bucket-cors/after.json`
is the same configuration with one difference: the PUT rule's `AllowedHeaders` becomes
`content-type`, `content-length`, `x-amz-server-side-encryption`,
`x-amz-server-side-encryption-aws-kms-key-id`. The allowed origins (`https://checksops.com`,
`https://www.checksops.com`), the PUT method, the GET/HEAD rule, the exposed headers and the max
ages are unchanged. `aws/tests/production-files-bucket-cors.test.mjs` proves that is the only
difference and that the headers are the ones the presigned upload sends.

No Lambda, IAM, bucket policy, encryption, lifecycle or SQL change.

## Steps (the owner, as `michael-admin`, from an LF checkout of main after this PR merges)

On the Windows desktop, run each command inside WSL (`wsl -d Ubuntu -- bash -ic 'cd /home/carle/ChecksOps && ...'`).

1. Confirm the live configuration is still the recorded before state. Stop if `diff` prints anything.

   ```bash
   B=checksops-production-privatefiles-806168576068
   aws s3api get-bucket-cors --bucket "$B" --output json > /tmp/cors-live.json
   diff <(python3 -m json.tool --sort-keys /tmp/cors-live.json) \
        <(python3 -m json.tool --sort-keys ops/production-files-bucket-cors/before-2026-11-04.json) \
     && echo "LIVE MATCHES BEFORE"
   ```

2. Apply the after state (S3 replaces the whole CORS configuration with this file).

   ```bash
   aws s3api put-bucket-cors --bucket "$B" \
     --cors-configuration file://ops/production-files-bucket-cors/after.json
   ```

3. Confirm the live configuration is now the after state.

   ```bash
   aws s3api get-bucket-cors --bucket "$B" --output json > /tmp/cors-live.json
   diff <(python3 -m json.tool --sort-keys /tmp/cors-live.json) \
        <(python3 -m json.tool --sort-keys ops/production-files-bucket-cors/after.json) \
     && echo "LIVE MATCHES AFTER"
   ```

4. Tell Claude it is done. A read-only check re-reads the bucket CORS and the PutBucketCors
   CloudTrail event, and a record PR adds the result here.

5. Test upload: the tenant retries on Compliance & Docs in production, choosing **Bank statement**.
   The upload shows "Submitted, in review" (sent to Moov as `merchant_underwriting`).

**Rollback.** Run step 2 with `before-2026-11-04.json`. That brings back the refused uploads.

## Applied 2026-11-04 (record)

- The owner ran steps 1 to 3 as `michael-admin` (SSO role
  `AWSReservedSSO_AdministratorAccess_e5a8a8393214f964`) from main `4bf662235`. A first attempt
  changed nothing: every `aws` call failed with "Token has expired and refresh failed" before the
  SSO login was renewed.
- CloudTrail `PutBucketCors` on `checksops-production-privatefiles-806168576068` at
  2026-11-04T15:01:52Z, request id `WW1RDNV6ZT00ZW8J`, no error code.
- Read-only check afterwards (`GetBucketCors` as `claude-code`): the live configuration equals
  `ops/production-files-bucket-cors/after.json` and no longer equals
  `before-2026-11-04.json`. The PUT rule allows `content-type`, `content-length`,
  `x-amz-server-side-encryption` and `x-amz-server-side-encryption-aws-kms-key-id`. Origins,
  methods, the GET/HEAD rule, exposed headers and max ages are unchanged.
- Remaining: step 5, the tenant's test upload on Compliance & Docs in production.
