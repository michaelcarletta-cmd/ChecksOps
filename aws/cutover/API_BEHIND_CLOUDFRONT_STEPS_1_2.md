# API-behind-CloudFront Steps 1–2 implementation package

**STOP FOR REVIEW. DO NOT DEPLOY. DO NOT CREATE THE TEMPORARY ROLE.**

Architecture: `aws/cutover/API_BEHIND_CLOUDFRONT_DESIGN.md` (approved).  
This package prepares **Steps 1–2 only**. Execute-api stays enabled. Origin-verify
secret and authorizer are **out of scope**. `DisableExecuteApiEndpoint` stays
**false**. Money/provider flags stay **false**. `64_financial_activation_grants.sql`
stays **NOT_APPLIED**. Do not begin RDS secret rotation. Do not broaden
`ChecksOpsCursorCloudStaging`. Do not recreate
`ChecksOpsCursorSecurityHardeningTemp` or `ChecksOpsCursorCloudTrailCwLogsTemp`.

Inspected live `E1B0ZWWO5559U5` **2026-09-08** (ETag `E1F83G8C2ARO7P` at
inspection — re-read `IfMatch` at deploy time). Account `806168576068`.

---

## Step 1 — CloudFront Function

Exact viewer-request code: `aws/cloudfront/spa-fallback.js`

- Runtime: `cloudfront-js-2.0`
- Name: `checksops-production-spa-fallback`
- Associate **only** with the S3 default behavior (`EventType: viewer-request`)
- Rewrite extensionless URIs to `/index.html` (SPA deep links `/login`, `/sign`, `/:slug/*`)
- Do **not** rewrite `/prep` or `/prep/*` (defense in depth; API behaviors never invoke this function)
- Do **not** rewrite URIs whose last path segment contains `.` (JS/CSS/images)
- Query strings are untouched

Then remove distribution-wide CustomErrorResponses (403/404 → `/index.html` 200).

## Step 1 — CloudFront distribution delta

Baseline: `aws/cloudfront/E1B0ZWWO5559U5.live-baseline.json`  
Proposed: `aws/cloudfront/E1B0ZWWO5559U5.step1.proposed.json`  
Builder (dry-run only): `aws/cloudfront/build-step1-config.mjs`

| Field | Live | Step 1 |
|---|---|---|
| Origins | `ProductionSpaS3` only | + `ProductionPrepHttpApi` → `kiqojucc02.execute-api.us-east-1.amazonaws.com`, **OriginPath empty**, no custom headers |
| Cache behaviors | 0 extra | `/prep` and `/prep/*` (not `/prep*`) |
| API cache policy | — | CachingDisabled `4135ea2d-6df8-44a3-9df3-4b5a84be39ad` |
| API origin-request | — | AllViewerExceptHostHeader `33f36b7c-a70f-4668-a48e-7eab15d4e0c3` |
| API methods | — | GET/HEAD/OPTIONS/PUT/POST/PATCH/DELETE |
| Default behavior | GET/HEAD/OPTIONS, CachingOptimized, CORS-S3Origin, no function | **unchanged methods/cache** + Function association |
| Custom errors | 403/404 → `/index.html` 200 | **removed** (`Quantity: 0`) |
| WAF / aliases / cert / logging / OAC | attached | **preserved** |

SPA bundle is **unchanged** in Step 1 (still execute-api). Direct
`https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep` remains operational.

Future apply order (not this PR):

1. `CreateFunction` + `PublishFunction` for `spa-fallback.js`
2. `GetDistribution` → fresh ETag
3. `UpdateDistribution` with proposed `DistributionConfig` and `IfMatch`
4. Wait `Status=Deployed`
5. Validate Step 1 (below)

The builder **exits 2** if `CHECKSOPS_APPLY_CF_STEP1` is set.

## Step 2 — frontend / build delta

| File | Change |
|---|---|
| `src/lib/awsApiBase.ts` | `resolveAwsApiBaseUrl()`: `/prep` or `same-origin` → `new URL('/prep', window.location.origin)` |
| `src/lib/awsStaging.ts` | `awsApiBaseUrl()` uses that helper. Auth/WebAuthn/Cognito unchanged. |
| `src/lib/aws/tenantCompliance.ts` | Uses `awsApiBaseUrl()` (was a duplicate `VITE_CHECKSOPS_API_URL` reader). |
| `.env.production.aws.example` | Step 2 source of truth: `VITE_CHECKSOPS_API_URL=/prep`. Not loaded by Vite until an operator copies it privately. Do not copy over `.env.production`. |
| `.env.aws` / `.env.aws.example` | Unchanged (staging execute-api). |

Future Step 2 build (not this PR): `vite build --mode aws` with production Cognito ids and `VITE_CHECKSOPS_API_URL=/prep`, sync `checksops-production-frontend-806168576068`, invalidate `/*`. Bundle must **not** contain `kiqojucc02.execute-api`.

## Rollback artifacts

| Step | Artifact / action |
|---|---|
| 1 | Restore `DistributionConfig` from `aws/cloudfront/E1B0ZWWO5559U5.live-baseline.json` (re-add 403/404 custom errors; remove `/prep` behaviors and API origin; clear FunctionAssociations). Wait `Deployed`. Leave execute-api enabled. Function may remain unpublished/unassociated. |
| 2 | Rebuild with `aws/cloudfront/step2-rollback.env.example` (`VITE_CHECKSOPS_API_URL=https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep`), sync bucket, invalidate `/*`. |

Do **not** set `DisableExecuteApiEndpoint=true` during rollback or deploy.

## Temporary Cursor OIDC role (design only — do not create)

Template: `aws/production/cursor-api-perimeter-steps12-role.yaml`  
`DeployRole` default **`false`**. Role name
`ChecksOpsCursorApiPerimeterSteps12Temp` only.

Trust: live Cursor OIDC `api.cursor.com` / aud `sts.amazonaws.com` / sub `user:325724407`
(same as the deleted hardening role trust; **new role name and policies**).

Allow (named resources only): `E1B0ZWWO5559U5` Get/Update/Invalidate; function
`checksops-production-spa-fallback` Create/Publish; S3 objects on
`checksops-production-frontend-806168576068` only.

Deny: API Gateway / HTTP API (including authorizers and execute-api disable),
Lambda (prep API and any authorizer), Secrets Manager (origin-verify and RDS),
RDS, Cognito, Route53, WAF, IAM PassRole/mutation, CloudTrail/Config/GuardDuty/Hub,
KMS, STS role chaining, security-log / private-files / access-log buckets,
protected CloudFormation stacks.

Do **not** attach these policies to `ChecksOpsCursorCloudStaging`.

## Validation after a future approved deploy

**After Step 1 (SPA still on execute-api):**

- `GET https://checksops.com/prep/health` → API JSON 200, not SPA HTML; `x-amz-cf-id` present
- `GET https://checksops.com/login` and SPA deep links still render
- `GET https://checksops.com/prep/missing` → API status, never `index.html`
- WAF `WebACLId` still the production CloudFront ACL
- `GET https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep/health` still JSON 200

**After Step 2:**

- Production bundle contains same-origin `/prep` and not raw execute-api for API calls
- Cognito login PASS (IdP still `cognito-idp.us-east-1.amazonaws.com`)
- Authenticated reads PASS; nonfinancial writes PASS; tenant isolation PASS
- Signing PASS; historical `/storage/sign` query strings PASS
- Upload URL + direct S3 PUT PASS
- apex + www PASS
- API access logs still `/aws/apigateway/checksops-production-prep-http`
- CloudFront/WAF PASS
- `/ops/readiness` PASS (`holds.ok=true`)
- `/financial/status` remains locked (`productionExecution=false`)
- Execute-api still operational (rollback)

## Out of scope

Steps 3–4 origin-verify authorizer. Custom API domain. REST conversion.
RDS rotation. KMS/FORCE RLS. Financial/provider activation.
`64_financial_activation_grants.sql`. Failed CloudTrail stack.
Pending `security@` SNS.
