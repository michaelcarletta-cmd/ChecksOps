# AWS public production cutover

**Generated:** 2026-09-06T15:30:59Z  
**Decision:** **AWS PUBLIC PRODUCTION CUTOVER: PASS**  
**STOP FOR REVIEW.**

Cloudflare grey-cloud CNAMEs now publish to CloudFront. Public apex and www were validated via 1.1.1.1 / 8.8.8.8 / Cloudflare DoH and live HTTPS to `https://checksops.com` and `https://www.checksops.com` (not the CloudFront hostname alone). This wave did not change DNS and did not activate providers or financial execution.

## Rollback recommendation

**NO_ROLLBACK.**

Public DNS has left Lovable. The production site is healthy on CloudFront + ACM. Keep `185.158.133.1` documented as the rollback A target only. Do not restore those A records unless a later review finds a production outage.

## Public site

| Check | Result |
|---|---|
| `checksops.com` A @1.1.1.1 | CloudFront `18.238.25.x` (not `185.158.133.1`) |
| `checksops.com` A @8.8.8.8 | CloudFront `13.249.141.x` |
| `www.checksops.com` CNAME | `dmgs35lzv89ms.cloudfront.net` |
| `https://checksops.com` | 200, `AmazonS3`, `x-amz-cf-id`, `Hit from cloudfront` |
| `https://www.checksops.com` | 200, same CloudFront/S3 origin |
| Public TLS | Amazon RSA 2048 M01, CN `checksops.com`, valid through 2027-03-21 (ACM) |
| Production SPA from AWS | **YES** — bundle `index-C24V_ODo.js`, Cognito + prep API, no `/~flock.js` |
| CloudFront `E1B0ZWWO5559U5` | **Deployed**, aliases apex + www, ACM attached |

## Authenticated AWS application

| Check | Result |
|---|---|
| Cognito production login | **PASS** |
| Authenticated API | **PASS** |
| Tenant isolation | **PASS** (tester 194 checks; C1C 0) |
| RDS / database reads | **PASS** |
| Non-financial write (`check_message_reads`) | **PASS** |
| Historical check + front/rear images | **PASS** |
| Current check + front/rear images | **PASS** |
| Endorsement workflow | **PASS** (live; `Token required`; no submit) |
| Signature workflow | **PASS** (live; `validate_token`; 2 requests readable) |
| Prep API / Lambda | **PASS** (`production-prep`, DB `checksops`) |
| CloudWatch errors (30 min) | **0** |

## Holds confirmed

- Moov OFF
- CheckAlt OFF
- Provider execution OFF
- Financial execution OFF
- `64_financial_activation_grants.sql` **NOT_APPLIED**
- Both migration bridges preserved (`read_only` / `sign_only`)
- Lovable `185.158.133.1` retained as rollback target

## Next

STOP. Do not activate Moov, CheckAlt, provider execution, financial execution, or financial grants.
