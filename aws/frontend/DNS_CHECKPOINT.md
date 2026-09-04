# Staging HTTPS + Cognito WebAuthn — DNS checkpoint

**STOP.** Agent does not modify Cloudflare. Do not test WebAuthn until `https://staging.checksops.com` resolves via the staging CNAME below.

## Verified status (2026-09-04)

| Item | Value |
| --- | --- |
| ACM certificate | **`ISSUED`** — `arn:aws:acm:us-east-1:806168576068:certificate/cfcfe403-a34a-4272-96c6-e5e266b0b315` |
| CloudFormation stack | **`UPDATE_COMPLETE`** — `checksops-staging-frontend-https` (recovered after bucket-policy create failure; same stack name; same cert + distribution retained) |
| CloudFront distribution ID | **`E1CG52WRQZI7X1`** |
| CloudFront domain | **`d2p55gobpvrxya.cloudfront.net`** |
| CloudFront status | **Deployed**, Enabled, alias `staging.checksops.com`, cert attached |
| Apex / www | **Untouched** |
| Cloudflare | **Untouched by agent** |

Note on stack status: the first create rolled back when `AWS::S3::BucketPolicy` failed (bucket already had a policy). After retain/import recovery, the healthy terminal state is `UPDATE_COMPLETE` (not a fresh `CREATE_COMPLETE`). No second ACM certificate was requested.

## Cloudflare record to create now (staging hostname)

| Field | Value |
| --- | --- |
| **Type** | `CNAME` |
| **Name** | `staging` (→ `staging.checksops.com`) |
| **Target** | `d2p55gobpvrxya.cloudfront.net` |
| **Proxy** | **DNS-only** (grey cloud / orange cloud OFF) |

Do **not** edit `checksops.com` or `www.checksops.com`.

## Already done (do not redo)

ACM validation CNAME (already added):

| Type | Name | Target |
| --- | --- | --- |
| CNAME | `_e0ab4c83610d32c1136f19206d48d643.staging` | `_6c16c4ba91c5c9f2f6b4db7a68abc7b1.jkddzztszm.acm-validations.aws.` |

## Template note

`aws/frontend/https-cloudfront.yaml` uses the existing ISSUED cert ARN parameter and does **not** manage the S3 bucket policy in CFN. OAC bucket policy is applied with `s3:PutBucketPolicy`.
