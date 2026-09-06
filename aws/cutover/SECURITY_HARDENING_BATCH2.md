# SECURITY HARDENING BATCH 2: FAIL

**Generated:** 2026-09-06T20:39:26Z  
**STOP FOR REVIEW.**

Financial and provider activation remains **NOT AUTHORIZED**. This batch did
not enable Moov, CheckAlt, provider execution, financial execution, MFA /
WebAuthn, RLS, S3/KMS on the files bucket, GuardDuty / Security Hub, secrets
rotation, or `64_financial_activation_grants.sql`.

The Cloud Agent staging role cannot create WAFv2 ACLs
(`wafv2:CreateWebACL` denied). Failed WAF stacks were deleted so an
operator can deploy the reviewed templates cleanly. Do **not** broaden
the agent role. See `SECURITY_HARDENING_BATCH2_WAF_OPERATOR.md`.

## Verdict

| Control | Result |
|---|---|
| AWS WAF on production CloudFront + API | **FAIL** — templates reviewed; live attach denied |
| API Gateway throttling | **PASS** — 50 rps / 100 burst on `prep` |
| Production CORS allow-list | **PASS** — no `*`; staging still `*` |
| Access logging | **PASS** — API and CloudFront logs writing; 90-day retention |
| Application regression | **PASS** |
| Financial / provider holds | **PASS** (still OFF / NOT_APPLIED) |

**SECURITY HARDENING BATCH 2: FAIL**

Stop here. Operator WAF deploy is required before this batch can PASS.
Do not enable financial or provider execution.

## Exact settings applied

### WAF (reviewed, not live)

CloudFront ACL name `checksops-production-cloudfront-waf` (scope
CLOUDFRONT). Regional ACL name `checksops-production-api-waf` (associates
to `arn:aws:apigateway:us-east-1::/apis/kiqojucc02/stages/prep`).

| Surface | Priority | Rule | Limit | Mode |
|---|---|---|---|---|
| CloudFront | 0 | `AWSManagedRulesCommonRuleSet` | n/a | **COUNT** |
| CloudFront | 1 | `AWSManagedRulesKnownBadInputsRuleSet` | n/a | **COUNT** |
| CloudFront | 2 | `AWSManagedRulesAmazonIpReputationList` | n/a | **COUNT** |
| CloudFront | 10 | General flood / IP | 2000 / 5 min | **COUNT** |
| CloudFront + API | 20 | URI contains `/auth` | 100 / 5 min / IP | **BLOCK** |
| CloudFront + API | 21 | URI contains `/storage` | 300 / 5 min / IP | **BLOCK** |
| CloudFront + API | 22 | URI contains `/public` | 200 / 5 min / IP | **BLOCK** |

Managed rules stay in COUNT until an operator reviews sampled matches.
Do not flip them to BLOCK in this batch.

Live `E1B0ZWWO5559U5` `WebACLId` is still empty.

### API throttling

HTTP API `kiqojucc02` stage `prep`:

- `ThrottlingRateLimit` = **50** requests/second
- `ThrottlingBurstLimit` = **100**
- No API keys / usage plans (HTTP API authenticated app traffic unchanged)

Staging `psr19uhop4` was not modified.

### CORS

| API | Origins | Methods |
|---|---|---|
| Production `kiqojucc02` | `https://checksops.com`, `https://www.checksops.com` | GET, POST, OPTIONS |
| Staging `psr19uhop4` | `*` (unchanged) | GET, POST, PUT, PATCH, DELETE, OPTIONS |

Prep Lambda (`CHECKSOPS_ENV=production-prep`) now uses `cors.mjs`: allowed
origins are echoed; unknown origins are not echoed (`https://checksops.com`
fallback on Lambda, and API Gateway omits ACAO for disallowed origins).

Live probes:

- OPTIONS `/public/endorsement` from `https://checksops.com` → 204,
  `access-control-allow-origin: https://checksops.com`
- OPTIONS `/public/signature-submit` from `https://www.checksops.com` → 204,
  www origin
- OPTIONS from `https://evil.example` → 204, **no** ACAO (not `*`)
- Staging OPTIONS still returns `*`
- POST `/public/endorsement`, `/public/signature-submit`,
  `/public/signature-document` remain reachable (400 token validation, not
  403/CORS)

### Access logging

| Channel | Destination | Retention | Contents |
|---|---|---|---|
| API Gateway HTTP | CloudWatch `/aws/apigateway/checksops-production-prep-http` | **90 days** | requestId, ip, method, path, status, protocol, responseLength, integrationStatus, error |
| CloudFront legacy | S3 `checksops-production-access-logs-806168576068` prefix `cloudfront/E1B0ZWWO5559U5/` | **90 days** lifecycle | `IncludeCookies=false` |

API log sample (2026-09-06T20:29Z) has **no** query string, headers,
authorization, cookies, tokens, or bodies. Example path only:
`/prep/storage/sign`.

CloudFront objects were present at 20:39Z under
`s3://checksops-production-access-logs-806168576068/cloudfront/E1B0ZWWO5559U5/`.
`IncludeCookies=false`. A sampled file had empty `cs-uri-query` and
`cs(Cookie)` values. Legacy format still *defines* those columns, so
operator v2 logging (omit cookie / query / referer) remains preferred.
v2 create was denied on
`cloudfront:AllowVendedLogDeliveryForResource`.

Log bucket SSE-S3, deny insecure transport, not publicly readable
(`BlockPublicPolicy` + `RestrictPublicBuckets`). `BlockPublicAcls` is
`false` so legacy CloudFront delivery can write.

## Validation

| Check | Result |
|---|---|
| Public `https://checksops.com` | PASS (200, CloudFront) |
| Public `https://www.checksops.com` | PASS (200, CloudFront) |
| Public API `/health` | PASS (200) |
| `/db-health` | PASS (connected, PostgreSQL 18.3, transaction read-only) |
| Cognito login | PASS |
| Authenticated API / RDS read | PASS (tester 194 intake rows) |
| Non-financial write (`check_message_reads` upsert) | PASS |
| Tenant isolation | PASS (tester vs C1C tenants differ; C1C check rows 0) |
| Historical / current image signing | PASS |
| Public endorsement / signature endpoints reachable | PASS |
| WAF attached and active | **FAIL** |
| Throttling configured | PASS (50 / 100) |
| CORS no longer wildcard in production | PASS |
| Access logs being written | PASS (API streams + CloudFront S3 objects) |
| New CloudWatch / Lambda errors | PASS (0 ERROR events, 0 Errors metric in last 20 minutes) |
| Moov | OFF |
| CheckAlt | OFF |
| Provider execution | OFF |
| Financial execution | OFF |
| `64_financial_activation_grants.sql` | NOT_APPLIED |

Prep role remains `checksops-production-api-execution`. Staging role and
staging sandbox execution `true` are unchanged.

## Operator remaining (do not expand the agent role)

1. Deploy `aws/production/waf-cloudfront.yaml` and
   `aws/production/waf-api.yaml` (see
   `SECURITY_HARDENING_BATCH2_WAF_OPERATOR.md`).
2. Attach the CloudFront WebACL ARN to `E1B0ZWWO5559U5`.
3. Optional: enable CloudFront standard logging v2 without cookies/query
   once `cloudfront:AllowVendedLogDeliveryForResource` is available on an
   operator principal.

After that, re-verify read-only. Do not flip managed WAF rules from COUNT
to BLOCK in this batch.
