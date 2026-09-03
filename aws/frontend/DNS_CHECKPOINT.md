# Staging HTTPS + Cognito WebAuthn — DNS checkpoint

**STOP before Cloudflare.** Do not test WebAuthn until `https://staging.checksops.com` is valid HTTPS with RP ID `staging.checksops.com`.

## Status summary

| Item | Status |
| --- | --- |
| Cognito `WEB_AUTHN` + `EMAIL_OTP` | Applied on staging pool `us-east-1_vPmQ7cL1F` |
| WebAuthn RP ID | `staging.checksops.com` |
| API passkey routes (repo) | Added under `/auth/passkey/*` (origin fail-closed) |
| Frontend AWS HTTPS gate | Enabled only at `https://staging.checksops.com` |
| ACM certificate | **Not created** — IAM denied `acm:RequestCertificate` |
| CloudFront distribution | **Not created** — IAM denied CloudFront APIs |
| Cloudflare DNS | **Untouched** (by design) |
| Apex / www | **Untouched** |

## 1. Exact ACM DNS validation record

**Unavailable until ACM permissions are granted and the certificate is requested.**

After an admin with ACM access deploys `aws/frontend/https-cloudfront.yaml` (or runs `acm request-certificate`), copy from ACM console / CLI:

```bash
aws acm describe-certificate --region us-east-1 --certificate-arn <arn> \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
```

Expected shape (values TBD after request):

| Field | Value |
| --- | --- |
| Type | `CNAME` |
| Name | `_xxxxx.staging.checksops.com` (ACM-generated) |
| Value | `_yyyyy.acm-validations.aws.` (ACM-generated) |

## 2. Exact Cloudflare staging DNS record

**Unavailable until CloudFront distribution exists.**

After stack create:

| Field | Value |
| --- | --- |
| Type | `CNAME` |
| Name | `staging` (→ `staging.checksops.com`) |
| Target | `<distribution-id>.cloudfront.net` (stack output `CloudFrontDomainName`) |

```bash
aws cloudformation describe-stacks --stack-name checksops-staging-frontend-https \
  --query 'Stacks[0].Outputs'
```

## 3. Cloudflare proxy initially

**DNS-only (orange cloud OFF / grey cloud).**

Proxy ON can interfere with ACM validation and with WebAuthn origin/RP ID expectations during first bring-up. Turn proxy on later only if deliberately evaluated.

## 4. Certificate status

`PENDING_VALIDATION` cannot be observed yet — certificate was not created (IAM).

## 5. CloudFront distribution status / domain

Not created (IAM). Expected after deploy: status `InProgress` → `Deployed`, domain `xxxx.cloudfront.net`, alias `staging.checksops.com`.

## 6. Additional IAM permissions required

Role `ChecksOpsCursorCloudStaging` lacks (exact denials observed):

```
acm:RequestCertificate
acm:DescribeCertificate
acm:ListCertificates
acm:AddTagsToCertificate
acm:DeleteCertificate
cloudfront:CreateOriginAccessControl
cloudfront:GetOriginAccessControl
cloudfront:ListDistributions
cloudfront:CreateDistribution
cloudfront:GetDistribution
cloudfront:UpdateDistribution
cloudfront:TagResource
cloudfront:CreateInvalidation
s3:GetBucketPolicy
s3:PutBucketPolicy
cloudformation:CreateStack
cloudformation:UpdateStack
cloudformation:DescribeStacks
cloudformation:DescribeStackEvents
```

Do **not** broaden the Cursor role automatically. Use a dedicated staging HTTPS deploy path / human admin.

Also needed to ship API routes live (separate from ACM/CF): `lambda:UpdateFunctionCode` on `checksops-staging-api` (in-place overlay; do not SAM-replace the thin stack).

## 7. Apex / www confirmation

- Template aliases only `staging.checksops.com`
- No Cloudflare changes were made
- `checksops.com` and `www.checksops.com` were not modified

## What was prepared in-repo / on Cognito (no DNS)

- `aws/frontend/https-cloudfront.yaml` + `HTTPS_CLOUDFRONT.md`
- Cognito pool: `AllowedFirstAuthFactors` includes `EMAIL_OTP`, `PASSWORD`, `WEB_AUTHN`; MFA `OFF`; `RelyingPartyId=staging.checksops.com`
- Lambda source: `auth-webauthn.mjs` routes (deploy separately after IAM/session)
- Frontend: `isAwsStagingHttpsPasskeysEnabled()`, `awsPasskeys.ts`, login + PasskeyManagerCard Cognito path
- Production Supabase/SimpleWebAuthn untouched
- No Moov/CheckAlt/financial activation; `64_financial_activation_grants.sql` not applied
