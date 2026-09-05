# Staging HTTPS frontend (CloudFront + ACM)

Staging-only. Production DNS / Lovable / Supabase are out of scope.

## Goal

Serve the AWS vite build at **https://staging.checksops.com** with:

- ACM certificate in `us-east-1`
- CloudFront distribution + S3 Origin Access Control
- SPA fallback (`403`/`404` → `/index.html`)
- Existing HTTPS API Gateway URL (`VITE_CHECKSOPS_API_URL`)

Template: `aws/frontend/https-cloudfront.yaml`  
DNS checkpoint: `aws/frontend/DNS_CHECKPOINT.md`

## IAM required on the deploy role (not present on ChecksOpsCursorCloudStaging)

Observed denials on `ChecksOpsCursorCloudStaging` (do **not** broaden automatically):

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

Grant a dedicated staging HTTPS deploy role or temporary admin path.

## Deploy (after IAM)

```bash
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name checksops-staging-frontend-https \
  --template-file aws/frontend/https-cloudfront.yaml \
  --parameter-overrides \
    FrontendBucketName=checksops-staging-frontend-c48b \
    StagingHostname=staging.checksops.com
```

Then **STOP** for Cloudflare DNS (ACM validation + `staging` CNAME → CloudFront domain, **DNS-only** proxy). Never edit apex/`www`.

Note: deploying this stack replaces the staging frontend bucket policy with CloudFront OAC-only access. The temporary HTTP S3 website endpoint will stop serving after that change (expected for HTTPS cutover).

## Cognito WebAuthn (already prepared on staging pool)

- `AllowedFirstAuthFactors`: `EMAIL_OTP`, `PASSWORD`, `WEB_AUTHN`
- `WebAuthnConfiguration.RelyingPartyId`: `staging.checksops.com`
- `UserVerification`: `preferred`
- MFA remains `OFF`
- API routes: `/auth/passkey/*` (require configured HTTPS Origin; default `https://staging.checksops.com`, overridable via `COGNITO_WEBAUTHN_ORIGIN` — staging template keeps the default)
- Frontend gate: `isAwsStagingHttpsPasskeysEnabled()` — fail closed on HTTP / unexpected host
