# Staging HTTPS + Cognito WebAuthn — DNS checkpoint

**STOP before Cloudflare changes by the agent.** Do not test WebAuthn until `https://staging.checksops.com` is valid HTTPS with RP ID `staging.checksops.com`.

## Status summary (2026-09-04)

| Item | Status |
| --- | --- |
| Cognito `WEB_AUTHN` + `EMAIL_OTP` | Applied on staging pool `us-east-1_vPmQ7cL1F` |
| WebAuthn RP ID | `staging.checksops.com` |
| Stack `checksops-staging-frontend-https` | `CREATE_IN_PROGRESS` |
| ACM certificate | `PENDING_VALIDATION` — ARN `arn:aws:acm:us-east-1:806168576068:certificate/cfcfe403-a34a-4272-96c6-e5e266b0b315` |
| CloudFront OAC | Created (`E2XTTU80R3S3GR`) |
| CloudFront distribution | **Not created yet** (waits on certificate) — expected |
| Cloudflare DNS | **Untouched by agent** — human must add ACM validation CNAME |
| Apex / www | **Untouched** |

## 1. Exact ACM DNS validation record (add in Cloudflare now)

| Field | Value |
| --- | --- |
| **Type** | `CNAME` |
| **Name** | `_e0ab4c83610d32c1136f19206d48d643.staging.checksops.com.` |
| **Target / Value** | `_6c16c4ba91c5c9f2f6b4db7a68abc7b1.jkddzztszm.acm-validations.aws.` |

Cloudflare UI tip: if the zone is `checksops.com`, the Name field is often entered as:

`_e0ab4c83610d32c1136f19206d48d643.staging`

Proxy: **DNS-only** (grey cloud / orange cloud OFF) for this validation CNAME.

Do **not** edit `checksops.com` or `www.checksops.com`.

## 2. Cloudflare staging → CloudFront CNAME

**Not available yet.** Distribution creation is blocked until the certificate validates. After the stack completes, use output `CloudFrontDomainName` for:

| Field | Value |
| --- | --- |
| Type | `CNAME` |
| Name | `staging` |
| Target | `<distribution>.cloudfront.net` (TBD) |
| Proxy | DNS-only initially |

## 3–7. Checkpoint answers

3. Cloudflare proxy for ACM validation CNAME: **DNS-only**
4. Certificate status: **`PENDING_VALIDATION`**
5. CloudFront distribution: **waiting on ACM** (OAC already created)
6. IAM: `ChecksOpsStagingHttpsWebAuthn` on `ChecksOpsCursorCloudStaging` — verified working for ACM/CloudFront/CloudFormation
7. Apex / www: **untouched**

## What not to do yet

- Do not test WebAuthn
- Do not run Moov/CheckAlt / production webhooks / financial activation
- Do not apply `64_financial_activation_grants.sql`
- Agent will not modify Cloudflare
