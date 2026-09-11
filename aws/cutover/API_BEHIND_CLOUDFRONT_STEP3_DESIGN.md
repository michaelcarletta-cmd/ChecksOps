# API Perimeter Step 3 — Origin verification DESIGN ONLY

**STOP FOR REVIEW. DO NOT DEPLOY STEP 3.**  
**READ-ONLY INSPECTION + DESIGN ONLY.** Inspected **2026-09-08T15:54Z–16:10Z** as
`ChecksOpsCursorCloudStaging/checksops-t0-run`. No AWS writes this turn.

Do **not** create the secret, authorizer Lambda, HTTP API authorizer, CloudFront
origin header, or `ChecksOpsCursorApiPerimeterStep3Temp`. Do **not** delete or
broaden `ChecksOpsCursorApiPerimeterSteps12Temp`. Do **not** modify the working
SPA, CloudFront distribution, API Gateway, prep Lambda, Cognito, RDS, WAF, DNS,
Secrets Manager, or security monitoring.

Do **not** set `DisableExecuteApiEndpoint=true`. CloudFront origin
`ProductionPrepHttpApi` **is** `kiqojucc02.execute-api.us-east-1.amazonaws.com`.
Disabling execute-api would black-hole `/prep`.

Do **not** convert HTTP API `kiqojucc02` to REST. Do **not** recreate
`ChecksOpsCursorSecurityHardeningTemp` or `ChecksOpsCursorCloudTrailCwLogsTemp`.
Do **not** enable Moov, CheckAlt, provider execution, or financial execution.
`64_financial_activation_grants.sql` stays **NOT_APPLIED**.
`productionExecution=false`. `Moov=false`. `CheckAlt=false`. `provider=false`.
`financial=false`.

Account `806168576068`, region `us-east-1`.

The origin-verification secret must **never** appear in frontend JS, Vite
environment variables (`VITE_*`), API responses, API Gateway access logs,
CloudFront access logs, normal Lambda logs, or Git. Do **not** put it in the
existing prep Lambda environment.

---

## A. Live-state verification

Steps 1 and 2 are **PASS** and still match that recorded live state.

### CloudFront `E1B0ZWWO5559U5`

| Field | Live 2026-09-08T15:54Z |
|---|---|
| Domain | `dmgs35lzv89ms.cloudfront.net` |
| Aliases | `checksops.com`, `www.checksops.com` |
| Status | **Deployed** |
| WAF | `arn:aws:wafv2:us-east-1:806168576068:global/webacl/checksops-production-cloudfront-waf/cc8aadde-2bab-4d5e-8144-7d8981f44ad7` |
| Origins | `ProductionSpaS3` (OAC `E35N26NNHZAG11`) + `ProductionPrepHttpApi` → `kiqojucc02.execute-api.us-east-1.amazonaws.com` |
| API OriginPath | empty |
| API custom origin headers | **Quantity 0** (no `x-checksops-origin-verify` yet) |
| Behaviors | `/prep` and `/prep/*` → API origin; CachingDisabled `4135ea2d-6df8-44a3-9df3-4b5a84be39ad`; AllViewerExceptHostHeader `b689b0a8-53d0-40ab-baf2-68738e2966ac`; methods GET/HEAD/OPTIONS/PUT/POST/PATCH/DELETE |
| Default behavior | SPA S3 + viewer-request `checksops-production-spa-fallback` |
| CustomErrorResponses | Quantity **0** |
| Logging | on, prefix `cloudfront/E1B0ZWWO5559U5/`, **IncludeCookies=false** |
| Viewer cert | ACM `5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3` |

Live `GET https://checksops.com/prep/health` returns JSON `status=ok`
`environment=production-prep` with `x-amz-cf-id` (CloudFront path).

### HTTP API `kiqojucc02`

| Field | Live |
|---|---|
| Name | `checksops-production-prep-http` |
| Protocol | **HTTP** (not REST) |
| Endpoint | `https://kiqojucc02.execute-api.us-east-1.amazonaws.com` |
| Stage | `prep`, AutoDeploy, throttle **50 rps / 100 burst** |
| `DisableExecuteApiEndpoint` | **false** (required; CloudFront origin uses this hostname) |
| Custom domains / VPC links / resource policy | **none** (HTTP APIs cannot use REST resource policies) |
| Authorizers | **none** (`Items: []`) |
| Routes | **one** `$default` `r0mx1qj` → integration `jci10de`, `AuthorizationType=NONE` |
| Integration | AWS_PROXY payload 2.0 → `checksops-production-prep-api`, timeout 30s |
| Access logs | `/aws/apigateway/checksops-production-prep-http` |
| Access log format | `requestId, ip, method, path, status, protocol, responseLength, integrationStatus, error` — **no headers, tokens, bodies, or `$context.identitySource`** |
| CORS origins | `https://checksops.com`, `https://www.checksops.com` |
| CORS methods | GET, POST, OPTIONS |
| CORS headers | `authorization`, `content-type`, `x-request-id`, `x-bridge-secret` |

Raw `GET https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep/health`
still returns JSON `ok` / `production-prep` (rollback path live).

### Lambda `checksops-production-prep-api`

JWT / tenant / RLS stay **inside this function**. Handler strips `/prep`
(`requestPath()` in `aws/functions/api/index.mjs`). Resource policy allows
**only** `apigateway.amazonaws.com` with
`SourceArn arn:aws:execute-api:us-east-1:806168576068:kiqojucc02/*`.
No EventBridge / Scheduler invoke permission.

VPC `vpc-09f2268778966ce97`. Role `checksops-production-api-execution`.
`CHECKSOPS_ENV=production-prep`. Cognito pool `us-east-1_h00WorYMT` / client
`3ja9fqaq2fjkv3i6up2varcqpe`. `SIGN_BASE_URL=https://checksops.com`.
`FILES_BUCKET=checksops-staging-privatefilesbucket-erzqsolpucjp`.
**No** `AWS_SCHEDULED_JOB_SECRET`. `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`.

Live flags this turn: Moov / CheckAlt / Plaid / Actum / QBO / provider
execution / live reads / financial permissions / sandbox **false**.
`/prep/ops/readiness` `holds.ok=true`. `/prep/financial/status`
`productionExecution=false`. `financialActivationSqlApplied=false`.

Do **not** mutate prep Lambda env (financial-flag risk).

### Secret inventory (staging role)

No `checksops/production/cloudfront-origin-verify` exists. Existing secrets
are RDS credentials and staging-only objects. Do **not** create the origin
secret this turn.

### Residual: `GetDistributionConfig` can later read the origin header

`ChecksOpsCursorCloudStaging` and `ChecksOpsCursorApiPerimeterSteps12Temp`
can `GetDistribution` / `GetDistributionConfig` on `E1B0ZWWO5559U5`. After
the origin custom header is added, **those roles can read the secret value**.
Treat that as a known residual. Optionally Deny those reads **before** the
header is added. Do not dump `DistributionConfig` into tickets or chat after
the header exists.

### Execute-api callers that must be identified before require-header

| Caller | Status before require-header |
|---|---|
| Production browser SPA | **No longer calls execute-api.** Step 2 bundle `index-reP2FWHf.js` uses same-origin `/prep` via `window.location.origin`. Hostname `kiqojucc02.execute-api` is **absent** from the shipped bundle. |
| CloudFront `/prep` origin | **Uses execute-api hostname.** Must stay enabled. After Step 3 the origin injects the header. |
| Production scheduled jobs | **Not configured on production.** No `AWS_SCHEDULED_JOB_SECRET` on prep Lambda. `aws/providers/SCHEDULED_JOBS.md` points EventBridge at **staging** `psr19uhop4` `/staging/scheduled/class-a`. Prep Lambda invoke policy is APIGW-only. |
| Provider webhooks | Production URLs remain on Supabase. AWS `/webhooks/{moov,checkalt}` exist with `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`. Execution flags **false**. Any future AWS webhook URL must use `https://checksops.com/prep/...` **before** require-header. |
| Public sign / endorse | `SIGN_BASE_URL=https://checksops.com`. SPA paths `/sign` and `/endorse` call same-origin `/prep/public/...`. |
| Operator / agent curls and docs | `aws/production/LIVE_RESOURCES.md`, `aws/cutover/MONITORING.md`, and T0 smoke still document raw execute-api `/prep/health` and `/ops/readiness`. Those will **fail** after require-header unless switched to CloudFront. |
| EventBridge / Scheduler / Synthetics / API Destinations | Staging role **denied** `events:ListRules`, `events:ListApiDestinations`, `scheduler:ListSchedules`, `synthetics:DescribeCanaries`. **Operator must list these before require-header.** This design cannot certify an empty set from the staging role. |

**Gate:** do not flip `ORIGIN_VERIFY_REQUIRE=true` until an operator confirms
there are no HTTP API Destinations, EventBridge rules, Scheduler schedules, or
Synthetics canaries targeting
`kiqojucc02.execute-api.us-east-1.amazonaws.com`.

---

## B. Recommended Step 3 architecture

Keep the existing HTTP API and CloudFront distribution. Origin verification is
an **additional perimeter control**, not user authentication.

```
Browser → checksops.com / www.checksops.com → CloudFront + WAF
  /prep and /prep/* → origin ProductionPrepHttpApi
    + origin custom header x-checksops-origin-verify
  → execute-api kiqojucc02
  → REQUEST Lambda authorizer checksops-production-origin-verify
  → (if authorized) integration jci10de strips the header
  → checksops-production-prep-api continues JWT / tenant / RLS
```

Direct internet → `https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep/...`
without a valid header is denied **after** the require-mode flip.

Rejected alternatives:

| Alternative | Why not |
|---|---|
| `DisableExecuteApiEndpoint=true` | CloudFront origin **is** that hostname. Would outage `/prep`. |
| REST API resource policy / convert to REST | Out of scope; would replace the working HTTP API. |
| JWT HTTP API authorizer | Would break `/prep/auth/login` and `/prep/public/*` (no user JWT). |
| Put secret in prep Lambda env | User-forbidden; also couples perimeter to financial-flag surface. |
| Put secret in `VITE_*` / SPA | Browser-visible; bypasses nothing. |
| Identity source = secret header during observe | Missing header → **401 without invoking** the authorizer, including CloudFront if the header is not yet injected. |

The previously proposed architecture is **accepted with four additions**
verified against live AWS and current HTTP API semantics:

1. **Observe mode before require mode** (authorizer attached, always allow,
   metrics only).
2. Identity source is `$context.httpMethod`, not the secret header, so missing
   headers still invoke the authorizer.
3. Explicit `OPTIONS /{proxy+}` with `AuthorizationType=NONE` because `$default`
   would otherwise authorize OPTIONS (AWS HTTP API CORS caveat).
4. HTTP API parameter mapping `remove:header.x-checksops-origin-verify` on
   integration `jci10de` so the secret never reaches prep Lambda logs.

---

## C. Exact AWS resources that would be created / changed

**Created later (not this PR):**

| Resource | Name / id |
|---|---|
| Secrets Manager secret | `checksops/production/cloudfront-origin-verify` JSON `{ "current", "next" }` |
| IAM execution role | `checksops-production-origin-verify` (Lambda trust; secret read + its log group only; **no VPC**) |
| Lambda | `checksops-production-origin-verify` Node 20, outside VPC |
| Lambda permission | `apigateway.amazonaws.com` on `arn:aws:execute-api:us-east-1:806168576068:kiqojucc02/authorizers/{id}` |
| HTTP API authorizer | REQUEST, payload `2.0`, `EnableSimpleResponses=true`, TTL `0` |
| HTTP API route | `OPTIONS /{proxy+}` `AuthorizationType=NONE` → `jci10de` |
| Log group | `/aws/lambda/checksops-production-origin-verify` |
| Temporary Cursor OIDC role | `ChecksOpsCursorApiPerimeterStep3Temp` (template only now) |

**Changed later (not this PR):**

| Resource | Change |
|---|---|
| CloudFront origin `ProductionPrepHttpApi` | Add one custom header `x-checksops-origin-verify` = secret `current` |
| HTTP API route `$default` | `AuthorizationType=NONE` → `CUSTOM` + `AuthorizerId` |
| Integration `jci10de` | Request parameter mapping removes the origin-verify header |

**Unchanged:**

SPA bundle, S3 frontend, spa-fallback function, WAF, DNS, Cognito, RDS, prep
Lambda code/env/VPC, stage throttle, access-log format, `DisableExecuteApiEndpoint`,
CORS allow-list (browser never sends the origin-verify header), financial SQL,
Steps12Temp (until a later cleanup), security monitoring.

---

## D. Authorizer implementation design

### Exact HTTP API v2 config

| Field | Value | Why |
|---|---|---|
| `AuthorizerType` | `REQUEST` | Not `JWT`. Origin authenticity only. |
| `AuthorizerPayloadFormatVersion` | `2.0` | Matches current integration payload. |
| `EnableSimpleResponses` | `true` | Return `{ isAuthorized, context }`. |
| `IdentitySource` | `["$context.httpMethod"]` | Always present → authorizer always invoked. Missing secret header does **not** become a cheap 401 that skips observe metrics. |
| `AuthorizerResultTtlInSeconds` | `0` | **Disable caching.** Cache key would be HTTP method only (one allow/deny for all GET, etc.). TTL > 0 is unsafe for observe→require and for rotation. |
| Route attach | `$default` `AuthorizationType=CUSTOM` | Today NONE. CUSTOM + AuthorizerId. Target stays `integrations/jci10de`. |
| Extra route | `OPTIONS /{proxy+}` `AuthorizationType=NONE` | `$default` would otherwise catch OPTIONS. |

Official identity-source rule (HTTP API): if an identity source is specified
and **missing / empty**, API Gateway returns **401 without invoking** Lambda.
That is why the secret header must **not** be an identity source until (if
ever) observe is finished and cheap-reject of missing headers is desired.
This design keeps `$context.httpMethod` in require mode so fabricated headers
still invoke Lambda and emit `originVerified=0`.

### Payload 2.0 simple response

```json
{ "isAuthorized": true, "context": { "originVerified": "1", "originHeaderPresent": "1" } }
```

Context is booleans-as-strings only. Never return the secret, never put it in
`principalId`.

### How existing routes stay usable through CloudFront

There is only `$default`. Login `POST /prep/auth/login` has no user JWT.
Public `POST /prep/public/signature-document` and `/prep/public/endorsement`
authenticate by path token inside prep Lambda. Uploads use `/prep/storage/*`
plus JWT. After CloudFront injects the header, the authorizer allows and prep
Lambda continues current checks. Origin verification does **not** replace
Cognito / RLS.

### OPTIONS / preflight

After Step 2, browser calls are **same-origin**, so most requests do not
CORS-preflight. AWS still documents that `$default` + CORS + authorizer
sends OPTIONS to `$default` and **will invoke the authorizer** unless an
explicit `OPTIONS /{proxy+}` `AuthorizationType=NONE` exists
([Configuring CORS on HTTP APIs](https://aws.amazon.com/blogs/compute/configuring-cors-on-amazon-api-gateway-apis/)).

CloudFront also forwards OPTIONS and **adds origin custom headers** on origin
requests, so a CF OPTIONS would pass require-mode even without the extra
route. Add `OPTIONS /{proxy+}` anyway. Attach integration `jci10de` (prep
Lambda already returns OPTIONS 204). Do **not** add
`x-checksops-origin-verify` to CORS `AllowHeaders` — browsers must never send
it.

API Gateway CORS auto-handles OPTIONS **except** when `$default` swallows
them. That is the `$default` caveat.

### Logging / leak surfaces

| Surface | Required control |
|---|---|
| Authorizer Lambda | No `console.log` of event/headers. Reference `aws/functions/origin-verify/authorizer.mjs` never logs them. |
| Prep Lambda | Strip header on integration `jci10de` via `remove:header.x-checksops-origin-verify` **before** AWS_PROXY. Do not mutate prep code/env. |
| API Gateway access logs | Keep current format. Do **not** add `$context.identitySource`, `$request.header.*`, or request bodies. Optional later: `$context.authorizer.originVerified` / `originHeaderPresent` only. Role deny blocks stage PATCH so this temp role cannot widen the format. |
| CloudFront standard logs | Do not include origin custom header values. Live `IncludeCookies=false`. |
| Frontend / Vite | Secret never in JS or `VITE_*`. |
| Git | Secret never committed. |
| `GetDistributionConfig` | Residual noted in section A. |

### Caching

**Disabled (TTL 0).** If TTL were > 0 with identity source `$context.httpMethod`,
one cached allow/deny would apply to every GET (or every POST) for up to TTL
seconds — wrong for require-mode denials and rotation. Do not enable caching.

---

## E. Secret handling / rotation

**Create (later):** operator-generated 32+ byte value, for example
`openssl rand -hex 32`, stored only in Secrets Manager.

```json
{ "current": "<hex>", "next": "" }
```

CloudFront origin header holds **`current` only**. Authorizer reads Secrets
Manager (`ORIGIN_VERIFY_SECRET_ARN`) and `timingSafeEqual`s the request header
against `current` **or** `next`. Authorizer env is `ORIGIN_VERIFY_REQUIRE`
and `ORIGIN_VERIFY_SECRET_ARN` — **not** the secret value
(`GetFunctionConfiguration` must not reveal it).

In-memory cache in the authorizer is **30s** of the JSON pair only (not
access logs). TTL 0 at API Gateway so rotation is not stuck on authorizer
result cache.

**Zero-downtime rotation:**

1. Generate a new value. `PutSecretValue` `{ current: <old>, next: <new> }`.
2. Update CloudFront origin header to `<new>`. Wait until Status `Deployed`.
3. Prove CloudFront still PASS (`originVerified=1`).
4. `PutSecretValue` `{ current: <new>, next: "" }`.
5. Old header now fails. Fabricated old value FAIL.

Do not use Secrets Manager managed rotation (would change `current` before
CloudFront). Do not commit values. Do not put values in Vite or prep env.

---

## F. Staged deployment sequence

The user’s A–F is close. The **safer supported sequence** inserts observe
mode and forbids attaching require-mode before the CloudFront header exists.

| Step | Action | Direct execute-api | CloudFront `/prep` |
|---|---|---|---|
| 0 | Operator confirms no EventBridge / Scheduler / Synthetics / API Destination callers of raw execute-api. Optionally Deny `GetDistributionConfig` on staging + Steps12Temp. | open | PASS |
| 1 | Human review. `DeployRole=true` on the Step 3 role template **only after review**. Do not broaden staging or Steps12Temp. | open | PASS |
| 2 | Create secret + execution role + authorizer Lambda + REQUEST authorizer object. **Do not attach** to `$default`. `ORIGIN_VERIFY_REQUIRE` unset/false. | open | PASS |
| 3 | Add CloudFront origin header on `ProductionPrepHttpApi`. Wait `Deployed`. | still open (no authorizer) | PASS; header now injected |
| 4 | Add `OPTIONS /{proxy+}` NONE. Add integration header-remove mapping. Attach authorizer to `$default` in **observe** mode (always `isAuthorized: true`). | still open | PASS |
| 5 | Prove observe metrics: CloudFront samples `originHeaderPresent=1`; raw execute-api samples `=0`. Login / reads / writes / sign / endorse still PASS. | open | PASS |
| 6 | Flip `ORIGIN_VERIFY_REQUIRE=true` on the **authorizer** Lambda only. Do not change identity sources (avoids a brief 401 window). | **denied** if header missing/wrong | must still PASS |
| 7 | Validation plan (section G). Never `DisableExecuteApiEndpoint`. | FAIL without secret; FAIL with fabricated header | PASS |

Do **not** attach require-mode before the CloudFront header is live (outage).
Do **not** use the secret header as identity source during observe (CF would
401 if the header were missing). Do **not** use Steps12Temp for this work.

Safer than “attach then add header”: **header first, then observe attach, then
require**. Safer than “require immediately after attach”: observe proves
injection with no user impact.

---

## G. Validation plan (later deploy; not this turn)

| Check | Expected |
|---|---|
| CloudFront `/prep/health` | JSON 200 + `x-amz-cf-id` |
| Login apex + www | `POST /prep/auth/login` 200 through CloudFront |
| Authenticated reads / writes | `/prep/data/query`, `/prep/data/write`, workflow POST/DELETE PASS |
| Signing / endorsement | `/sign` + `/endorse` SPA HTML; `/prep/public/signature-document` and `/prep/public/endorsement` JSON through CloudFront |
| Uploads | `/prep/storage/sign`, `/prep/storage/upload-url`, direct S3 PUT |
| Tenant isolation | Tester Freedom-only; C1C cannot read Freedom rows |
| Raw execute-api without header | **FAIL** (401/403) after require-mode |
| Raw execute-api with fabricated header | **FAIL** after require-mode |
| CloudFront + WAF | Distribution Deployed; WAF ARN unchanged and attached |
| Access logs | Current format only; no secret string in APIGW or CF logs; authorizer logs have no header dump |
| Financial / provider holds | `holds.ok=true`; `productionExecution=false`; Moov/CheckAlt/provider/financial **false**; `64_financial_activation_grants.sql` **NOT_APPLIED** |

Use existing T0 lifecycle accounts only if login validation is required
(Tester + C1C). Cognito mutation stays off the Step 3 role (staging role, as
in Step 2).

---

## H. Rollback plan

Execute-api stays enabled the entire time. Rollback never needs to
re-enable it.

| Stage reached | Rollback |
|---|---|
| Secret / Lambda / unattached authorizer only | Leave unused or delete authorizer object. No user impact. |
| CloudFront header added, authorizer not attached | Remove the custom header from origin `ProductionPrepHttpApi`. Wait `Deployed`. Direct execute-api still works. |
| Observe mode attached | Set `$default` back to `AuthorizationType=NONE`. Leave or keep `OPTIONS /{proxy+}`. CloudFront and execute-api both work. |
| Require mode | Fastest: set `ORIGIN_VERIFY_REQUIRE=false` (observe) **or** detach authorizer (`AuthorizationType=NONE`). Users on CloudFront keep working either way. Direct execute-api opens again — accepted rollback. |

Do not revert Step 1 CloudFront `/prep` behaviors. Do not revert Step 2 SPA
to execute-api unless a separate review requires it. Do not disable WAF.
Do not apply financial SQL.

---

## I. Least-privilege temporary role design

**DO NOT CREATE THE ROLE THIS TURN.**

Template: `aws/production/cursor-api-perimeter-step3-role.yaml`
(`DeployRole` default `false`). Companion JSON:
`cursor-api-perimeter-step3-role-trust.json`,
`cursor-api-perimeter-step3-role-allow.json`,
`cursor-api-perimeter-step3-role-deny.json`.

| Item | Value |
|---|---|
| Role name | `ChecksOpsCursorApiPerimeterStep3Temp` |
| Trust | Cursor OIDC `api.cursor.com` aud `sts.amazonaws.com` sub `user:325724407` |
| Session | 3600s |
| Authorizer execution role (same stack, still gated) | `checksops-production-origin-verify` |

**Allow only:**

- CloudFront Get/Update on `E1B0ZWWO5559U5` (no invalidation, no other distributions)
- Lambda create/update/permission on `checksops-production-origin-verify` only
- `iam:PassRole` of `checksops-production-origin-verify` to `lambda.amazonaws.com` only
- HTTP API authorizers, routes, and integration `jci10de` on `kiqojucc02` only
- HTTP API GET for verification
- Secrets Manager create/describe/get/put on
  `checksops/production/cloudfront-origin-verify*` only
- Logs for the authorizer function; read-only filter on existing API access logs

**Explicitly deny:**

- RDS / RDS Data
- Cognito mutation
- Prep Lambda (`checksops-production-prep-api`) and all other Lambdas
- Provider / financial controls (via prep-env + RDS + Cognito denials)
- DNS (Route 53)
- WAF mutation / disassociation
- Security monitoring (CloudTrail, Config, GuardDuty, SecurityHub)
- EventBridge / Scheduler / Synthetics / SNS
- Unrelated secrets (including RDS and staging secrets)
- Secret delete / managed rotate
- API-level PATCH (blocks `DisableExecuteApiEndpoint` and CORS/stage log-format edits)
- S3 (including the SPA bucket — Step 3 must not touch the frontend)
- Broaden staging, Steps12Temp, deleted hardening roles, prep execution role
  (`iam:*` on `ChecksOpsCursor*` plus named `checksops-production-api-execution`)
- KMS and role chaining

Steps12Temp stays in place and stays **narrow**. This work uses a **new**
role. Do not add Step 3 permissions to staging.

---

## Amber AWS staging banner — later UI-only (not this phase)

Live production Cognito SPA must **not** render the amber
`AwsStagingBanner`. `isAwsAuth()` (`VITE_AUTH_PROVIDER === "cognito"`) selects
the Cognito + AWS API client on both staging and production-prep. `isAwsStaging()`
is hostname / `VITE_CHECKSOPS_ENVIRONMENT` gated and is false on
`checksops.com` / `www.checksops.com`. Login UAT password copy stays staging-only.

Do **not** treat `isAwsAuth()` as staging. Production AWS SPAs keep Cognito.

---

## STOP

Do not deploy Step 3. Do not create the role, secret, authorizer, or
CloudFront header. Do not delete Steps12Temp. Do not modify the working
production path.
