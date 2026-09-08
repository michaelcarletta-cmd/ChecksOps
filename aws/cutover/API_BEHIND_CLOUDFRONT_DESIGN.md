# API-behind-CloudFront design — STOP FOR REVIEW

**DO NOT DEPLOY FROM THIS DOCUMENT.**  
**READ-ONLY INSPECTION ONLY.** Inspected **2026-09-08T14:21Z** as
`ChecksOpsCursorCloudStaging/checksops-t0-run`.

Do **not** modify CloudFront, API Gateway, SPA, WAF, DNS, Cognito, Lambda,
RDS, IAM, Secrets Manager, S3, or staging. Do **not** disable execute-api.
Do **not** convert HTTP API `kiqojucc02` to REST. Do **not** recreate the
deleted temporary security roles. Do **not** enable Moov, CheckAlt, provider
execution, or financial execution. `64_financial_activation_grants.sql`
stays **NOT_APPLIED**. Do **not** begin RDS secret rotation or KMS/FORCE RLS.

Account `806168576068`, region `us-east-1`.

---

## A. Live-state findings

### CloudFront `E1B0ZWWO5559U5`

| Field | Live |
|---|---|
| Domain | `dmgs35lzv89ms.cloudfront.net` |
| Aliases | `checksops.com`, `www.checksops.com` |
| Status | Deployed |
| WAF | `arn:aws:wafv2:us-east-1:806168576068:global/webacl/checksops-production-cloudfront-waf/cc8aadde-2bab-4d5e-8144-7d8981f44ad7` |
| Origins | **1**: `ProductionSpaS3` → `checksops-production-frontend-806168576068.s3.us-east-1.amazonaws.com`, OAC `E35N26NNHZAG11`, **no** custom origin headers |
| Extra cache behaviors | **0** |
| Default methods | **GET, HEAD, OPTIONS** only (cached GET/HEAD) |
| Cache policy | `658327ea-f89d-4fab-a63d-7e88639e58f6` (AWS managed **CachingOptimized**) |
| Origin request policy | `88a5eaf4-2fd4-4709-b370-b4c650ea3fcf` (AWS managed **CORS-S3Origin**) |
| Response headers policy | **none** |
| Custom errors | **403 and 404 → `/index.html` status 200** (distribution-wide) |
| Viewer cert | ACM `5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3`, TLS 1.2_2021, SNI |
| Logging | on, bucket `checksops-production-access-logs-806168576068`, prefix `cloudfront/E1B0ZWWO5559U5/` |

`GET https://checksops.com/prep/health` today returns **SPA HTML** (`x-cache: Error from cloudfront`), not JSON. There is **no** API origin yet.

### WAF (already attached)

Stack `checksops-production-cloudfront-waf` **CREATE_COMPLETE**. Managed rule groups are **COUNT**. Path rate limits **BLOCK** on URI **CONTAINS** `/auth` (100), `/storage` (300), `/public` (200). Those rules today mostly see SPA paths; after `/prep` is on CloudFront they will also see `/prep/auth`, `/prep/storage`, `/prep/public` (intended). Do **not** add `/auth*`, `/storage*`, or `/public*` CloudFront behaviors.

### HTTP API `kiqojucc02`

| Field | Live |
|---|---|
| Name | `checksops-production-prep-http` |
| Protocol | **HTTP** (not REST) |
| Endpoint | `https://kiqojucc02.execute-api.us-east-1.amazonaws.com` |
| Stage | `prep`, AutoDeploy, throttle **50 rps / 100 burst** |
| `DisableExecuteApiEndpoint` | **false** |
| Custom domains / mappings | **none** |
| VPC links | **none** |
| Resource policy | **not present** (HTTP APIs do not support REST-style resource policies) |
| Authorizers | **none** |
| Routes | **one** `$default` → AWS_PROXY integration `jci10de`, `AuthorizationType=NONE` |
| Integration | Lambda `checksops-production-prep-api`, payload 2.0, timeout 30s |
| Access logs | `/aws/apigateway/checksops-production-prep-http` (no tokens/bodies) |
| CORS origins | `https://checksops.com`, `https://www.checksops.com` |
| CORS methods | **GET, POST, OPTIONS** only |
| CORS headers | `authorization`, `content-type`, `x-request-id`, `x-bridge-secret` |

Live CORS preflight from both ChecksOps origins returns `204` with those allow-lists. `DELETE` is **not** in CORS allow-methods, so browser `DELETE` to execute-api is blocked today. Same-origin `/prep` after CloudFront would not need CORS for that call.

Template `aws/production/api-cfn.yaml` is **stale** vs live (template CORS `*`, no stage throttle/logs, old execution role, no VPC). Do **not** redeploy it as-is.

### Lambda `checksops-production-prep-api`

JWT/tenant/RLS are enforced **inside Lambda**, not API Gateway. The handler strips stage prefix ` /prep ` from `rawPath` (`aws/functions/api/index.mjs` `requestPath()`), so CloudFront must forward `/prep/...` unchanged (no OriginPath rewrite).

Live flags: Moov / CheckAlt / provider / financial **false**; `productionExecution=false` on `/financial/status`. Writes/storage/workflow flags are **true** (non-financial app writes). Role `checksops-production-api-execution`. Function is **in VPC** `vpc-09f2268778966ce97`. `SIGN_BASE_URL` / WebAuthn origin `https://checksops.com`. Do **not** change Lambda env in this phase (would risk financial flags).

### Frontend

Repo `.env.production` is still **Supabase-only** and is **not** what is deployed.

Live bundle `https://checksops.com/assets/index-C24V_ODo.js` (HTML last-modified 2026-09-06) contains:

`https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep`

and Cognito strings. The production SPA **already calls execute-api directly**. All AWS client fetches go through `awsApiBaseUrl()` (`src/lib/awsStaging.ts`) which is `VITE_CHECKSOPS_API_URL` with no trailing slash, plus paths `/auth/...`, `/storage/...`, `/public/...`, `/data/...`, `/workflow/...`.

SPA React routes that would **collide** if mapped as CloudFront API behaviors: `/auth` (redirects to `/login`), `/sign`, `/endorse`, `/:slug/*`. There is **no** SPA route `/prep`, but `/:slug` would treat tenant slug `prep` as an app page if `/prep` stayed on S3. API paths the browser uses are **`/prep` + `/auth|/storage|/public|...`**, not bare `/auth`.

Uploads: API `POST /storage/upload-url`, then **PUT to S3 presigned URL** (not API Gateway). Document signing URLs are returned by `/storage/sign` and must keep query strings.

### Auth / CORS

Browser Cognito IdP traffic stays on `cognito-idp.us-east-1.amazonaws.com` (not CloudFront). API uses `Authorization: Bearer` Cognito JWT validated in Lambda. Changing Host to `checksops.com` does not change token audience. Same-origin `/prep` after the SPA flip makes CORS optional for the browser; leftover execute-api callers still need the current CORS allow-list until execute-api is restricted.

---

## B. Recommended architecture

Keep the **existing** HTTP API and **existing** CloudFront distribution.

```
Browser
  → https://checksops.com  (or www)
  → CloudFront E1B0ZWWO5559U5 + WAF
      ├ default *          → S3 SPA (GET/HEAD/OPTIONS)
      ├ /prep              → HTTP API origin (all methods, no cache)
      └ /prep/*            → HTTP API origin (all methods, no cache)
  → https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep/...
  → Lambda checksops-production-prep-api
  → RDS
```

**Do not** use a single CloudFront pattern `/prep*` (that would also match `/prepayment`, `/prep-anything`). Use **two** behaviors: `/prep` and `/prep/*`.

**Do not** map `/auth*`, `/storage*`, or `/public*` on CloudFront.

**Do not** set OriginPath `/prep` (would produce `/prep/prep/...`). Origin domain is the execute-api hostname. Origin request policy **AllViewerExceptHostHeader** so `Host` to API Gateway remains `kiqojucc02.execute-api.us-east-1.amazonaws.com`.

SPA rebuild must set the API base to **same-origin** `/prep` (prefer `new URL('/prep', window.location.origin)` so **www** stays same-origin). Hardcoding `https://checksops.com/prep` would make www cross-origin.

### Direct execute-api (later step, not first)

Do **not** set `DisableExecuteApiEndpoint=true` while CloudFront’s origin **is** that execute-api hostname. That would black-hole CloudFront as well. There is **no** HTTP API custom domain to fail over to.

HTTP API **resource policies are not available**. Do not convert to REST to get them or regional WAF.

**Recommended restriction:** CloudFront origin custom header `x-checksops-origin-verify` (secret from Secrets Manager, never `VITE_*` / never SPA JS) + a **small dedicated HTTP API Lambda authorizer** that compares the header. Missing/wrong header → 401 at API Gateway (prep Lambda not invoked). Attach only after the SPA is on `/prep`.

Do **not** put origin-verify in `checksops-production-prep-api` env via `lambda:UpdateFunctionConfiguration` (that API can flip financial flags).

Webhooks/scheduled/bridges that today hit execute-api must be pointed at `https://checksops.com/prep/...` **before** the authorizer is attached (or invoke Lambda directly for EventBridge). Provider execution stays OFF; still design the URL so later webhooks go through CloudFront/WAF.

---

## C. Exact proposed changes (future approved implementation)

No changes in this turn.

| Resource | Change |
|---|---|
| CloudFront `E1B0ZWWO5559U5` | Add HTTPS origin `kiqojucc02.execute-api.us-east-1.amazonaws.com`. Add behaviors `/prep` and `/prep/*`: CachingDisabled `4135ea2d-6df8-44a3-9df3-4b5a84be39ad`, AllViewerExceptHostHeader `33f36b7c-a70f-4668-a48e-7eab15d4e0c3`, methods GET/HEAD/OPTIONS/PUT/POST/PATCH/DELETE, Viewer HTTPS. Later: origin custom header. |
| CloudFront custom errors | **Must not** remain global 403/404→`index.html` once API is on this distribution (API 401/403/404 would become SPA HTML). Replace SPA fallback with a **CloudFront Function on the default S3 behavior only** (viewer-request rewrite to `/index.html` when the URI has no file extension and is not `/prep`). Then remove distribution CustomErrorResponses. |
| WAF | No change. Existing CONTAINS `/auth|/storage|/public` will cover `/prep/...`. |
| HTTP API / stage / Lambda / RDS / Cognito / DNS / S3 bucket policy | Unchanged in step 1. |
| SPA build | `.env` / Vite: `VITE_CHECKSOPS_API_URL` derived as origin + `/prep` (or equivalent in `awsApiBaseUrl()`). Rebuild + S3 sync `checksops-production-frontend-806168576068` + invalidation. Files: `src/lib/awsStaging.ts`, production AWS env used for the live Vite build (not repo `.env.production` until that file is the live source of truth). |
| Later: Secrets Manager | New secret e.g. `checksops/production/cloudfront-origin-verify`. |
| Later: authorizer Lambda + HTTP API authorizer on `$default` | New function; **new** tiny IAM role; do not touch prep Lambda env. |
| `aws/production/api-cfn.yaml` | Do not apply. Optionally update later to match live CORS/throttle so it cannot clobber production. |

---

## D. Security analysis

| Control | Effect |
|---|---|
| CloudFront `/prep` + `/prep/*` + SPA same-origin URL | Browser API traffic hits WAF (managed COUNT + path rates BLOCK) |
| CachingDisabled + AllViewerExceptHostHeader | No caching of private JSON; `Authorization`, cookies, query strings forwarded; Host stays execute-api |
| Origin-verify authorizer (later) | Arbitrary internet clients calling execute-api without the secret get 401. Secret is only on CloudFront origin config + Secrets Manager + authorizer |
| Keep execute-api **enabled** | CloudFront origin continues to work |
| Not DisableExecuteApiEndpoint | Avoids self-DoS of the CloudFront origin hostname |
| Not REST conversion | Avoids replacing the live HTTP API |

Residual bypass after authorizer: anyone who **steals** `x-checksops-origin-verify` can still call execute-api **without WAF**. Mitigate with secret rotation, API throttle 50/100, JWT/RLS still required for app data, no secret in JavaScript. CloudFront IPs cannot be resource-policy-restricted on this HTTP API.

Other residuals: WAF managed rules are COUNT (not BLOCK); `/health` and other unauthenticated routes remain callable through CloudFront; tenant slug `prep` would be claimed by the API behaviors.

---

## E. Deployment sequence (reversible; first step does **not** disable execute-api)

0. **This document / review only.** No AWS writes.
1. **SPA fallback fix + unused API origin/behaviors.** CloudFront Function on default behavior; remove global 403/404 custom errors; add API origin + `/prep` + `/prep/*` with CachingDisabled / AllViewerExceptHostHeader / all methods. SPA bundle **unchanged** (still execute-api). Prove `https://checksops.com/prep/health` returns JSON 200 and SPA routes still render.
2. **SPA rebuild** to same-origin `/prep`. Invalidation. Prove login, reads, writes, sign/endorse, uploads. Execute-api left open (CORS still valid).
3. **Origin-verify authorizer** created but **not** required (or attached in permit-missing-header soak). Point any operator/scheduled/webhook URLs at CloudFront.
4. **Require origin header.** Direct execute-api bypass test must fail. Do **not** set `DisableExecuteApiEndpoint`.

Never combine step 1 with step 4.

---

## F. Validation plan

| Area | How |
|---|---|
| Unauthenticated | `GET https://checksops.com/prep/health` JSON 200; `GET https://checksops.com/login` SPA; `GET https://checksops.com/prep/missing` JSON/API status **not** `index.html` |
| Cognito login | EMAIL_OTP / password via existing `/prep/auth/*`; IdP still `cognito-idp` |
| Authenticated reads | `/identity/me`, `/data/query` with Bearer JWT |
| Nonfinancial writes | `/data/write`, workflow POST; flags stay off for money |
| Tenant isolation | existing Tester vs C1C isolation scripts against CloudFront URL |
| Signing | `/sign` SPA + `/prep/public/signature-*`; historical `/storage/sign` query strings |
| Uploads | `/storage/upload-url` then PUT S3 (not CloudFront) |
| CORS | apex and www; after step 2 same-origin; execute-api still allows both origins until step 4 |
| CloudFront/WAF | `x-amz-cf-id` on `/prep/health`; `/prep/auth` counted in RateLimitAuth |
| Throttle/logging | stage 50/100 unchanged; access log group still receiving `/prep` paths |
| Direct bypass | after step 4, curl execute-api without origin header → 401; with stolen-header test only in a controlled operator check |
| Smoke | `/health`, `/ops/readiness` `holds.ok=true`, `/financial/status` `productionExecution=false` via **CloudFront** |

---

## G. Rollback

| Step | Rollback |
|---|---|
| 1 | Delete the two `/prep` behaviors and API origin; restore CustomErrorResponses if the Function is removed; wait for CloudFront `Deployed`. SPA still on execute-api. |
| 2 | Rebuild SPA with `VITE_CHECKSOPS_API_URL=https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep`; sync bucket; invalidate `/*`. |
| 3–4 | Detach HTTP API authorizer from `$default` (`AuthorizationType=NONE`). Leave CloudFront origin in place. **Do not** need to re-enable execute-api (it was never disabled). |

Production remains usable on the raw execute-api URL until step 4.

---

## H. Required permissions

`ChecksOpsCursorCloudStaging` can **read** `GetDistribution` (this inspection) and is **denied** `GetCachePolicy` / `GetOriginRequestPolicy` / `wafv2:ListWebACLs`. It must **not** be broadened. Deleted roles `ChecksOpsCursorCloudTrailCwLogsTemp` and `ChecksOpsCursorSecurityHardeningTemp` must **not** be recreated; the hardening role **Denied** `cloudfront:UpdateDistribution` anyway.

A **new** least-privilege temporary OIDC role (design only — **do not create now**) would need, scoped to `E1B0ZWWO5559U5` and named resources:

- Step 1–2: `cloudfront:GetDistribution`, `GetDistributionConfig`, `UpdateDistribution`, `CreateInvalidation`, `CreateFunction`/`PublishFunction`/`DescribeFunction` (CloudFront Function), `s3:PutObject`/`DeleteObject` on the frontend bucket only, `s3:GetObject` for verify
- Explicit **Deny**: `DeleteDistribution`, other distribution ARNs, `DisassociateWebACL`, Route53, Lambda `UpdateFunctionConfiguration`/`UpdateFunctionCode` on `checksops-production-prep-api`, RDS, Cognito, Secrets `GetSecretValue` on RDS, financial/provider flag names, S3 security-logs bucket, CloudTrail stacks
- Step 3–4 (later): `apigatewayv2:CreateAuthorizer`/`UpdateRoute` on `kiqojucc02` only; `lambda:CreateFunction` for a **new** authorizer name; `iam:PassRole` only to that authorizer role passed to `lambda.amazonaws.com` and `apigateway.amazonaws.com`; Secrets Manager on the origin-verify secret only

Do not add this work to `ChecksOpsCursorCloudStaging`.

---

## Holds

- **STOP FOR REVIEW. DO NOT DEPLOY.**
- First implementation must not disable the working execute-api endpoint.
- Money/provider flags remain false. `64_` NOT_APPLIED.
- Leave `checksops-production-security-trail` CREATE_FAILED untouched.
- Leave pending `security@checksops.com` SNS subscription untouched.
