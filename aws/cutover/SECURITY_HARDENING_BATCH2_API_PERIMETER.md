# BATCH 2 API PERIMETER DESIGN: RECOMMENDATION

**DO NOT DEPLOY FROM THIS DOCUMENT.**  
**DO NOT retry `checksops-production-api-waf`.**  
**DO NOT change `/apis` to `/restapis`.**  
**DO NOT convert `kiqojucc02` to a REST API or recreate it.**

Inspected read-only at **2026-09-07T00:48Z**. CloudFront WAF association
on `E1B0ZWWO5559U5` is already **PASS** and live. Financial/provider
activation remains **NOT AUTHORIZED**. Moov, CheckAlt, provider
execution, and financial execution stay **OFF**.
`64_financial_activation_grants.sql` stays **NOT_APPLIED**.

---

## Verdict

| Question | Answer |
|---|---|
| Native WAFv2 on HTTP API `kiqojucc02` | **Unsupported.** Association ARN `/apis/kiqojucc02/stages/prep` is invalid. REST-only `/restapis/...` must not be used. |
| Batch 2 can PASS now? | **YES** — CloudFront WAF (live) + API Gateway **50 rps / 100 burst** + production CORS allow-list + Cognito JWT on app routes. |
| API-behind-CloudFront required for Batch 2 close? | **NO** |
| API-behind-CloudFront required before financial activation? | **YES** — must-fix in a later approved batch, not this one. |

**BATCH 2 API PERIMETER DESIGN: RECOMMENDATION**

Close Batch 2 on the live CloudFront WAF plus the already-applied HTTP
API throttle/CORS/logs. Retire the regional API WAF stack. Put
API-behind-CloudFront on the pre-financial hardening list.

---

## Why the API WAF stack failed

`kiqojucc02` is API Gateway **HTTP** (`ProtocolType: HTTP`), stage
`prep`. WAFv2 regional association supports REST API stages
(`arn:aws:apigateway:region::/restapis/{api-id}/stages/{stage-name}`),
not HTTP API stages (`/apis/{api-id}/stages/{stage-name}`).

Stack `checksops-production-api-waf` is `ROLLBACK_COMPLETE`. Leave it
or delete it. Do **not** redeploy `aws/production/waf-api.yaml`.

---

## Live perimeter (do not change in this batch)

| Surface | Live |
|---|---|
| CloudFront `E1B0ZWWO5559U5` | WAF ARN attached; aliases `checksops.com`, `www.checksops.com`; **one** origin (`ProductionSpaS3`); default behavior GET/HEAD/OPTIONS only; no extra behaviors |
| SPA bundle | Calls `https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep` directly |
| HTTP API | CORS `https://checksops.com` + `https://www.checksops.com`; throttle 50/100; execute-api endpoint enabled |
| Cognito | Browser → `cognito-idp` (not CloudFront); API uses bearer JWT |
| Public Sign/Endorse | SPA routes `/sign`, `/endorse`; AWS mode posts `/public/*` to execute-api |
| SPA `/auth` | Client route that redirects to `/login` — **not** the API |

CloudFront WAF therefore inspects **SPA GETs**, not API POSTs. Path
rules `/auth` `/storage` `/public` on CloudFront today mostly see SPA
paths (including `/auth` → `/login`), not `/prep/auth` etc.

---

## Evaluation: API behind existing CloudFront

**Possible later, without replacing the HTTP API**, by adding a second
origin + one cache behavior. Not safe to do as a silent Batch 2 fix.

Safe pattern if later approved:

- New origin only: `kiqojucc02.execute-api.us-east-1.amazonaws.com` (HTTPS)
- One behavior: path **`/prep*`** → that origin
- Cache policy **CachingDisabled**
- Origin request policy **AllViewerExceptHostHeader** (Host must stay
  the execute-api hostname; there is no HTTP API custom domain)
- Allowed methods must include POST (and OPTIONS)
- Do **not** map `/auth*`, `/storage*`, or `/public*` on CloudFront —
  those collide with SPA routes (`/auth`, `/sign`, `/endorse`, and
  403/404 → `index.html`)
- Then rebuild the SPA so `VITE_CHECKSOPS_API_URL` is
  `https://checksops.com/prep` (and www)

Until the SPA URL changes, a CloudFront API origin receives **no**
browser traffic. The live bundle still uses execute-api.

### What that would not break (if `/prep*` only + SPA URL flip)

- SPA default behavior and S3 OAC stay the default
- Cognito IdP traffic stays off CloudFront
- Public `/sign` and `/endorse` pages still render from S3; their API
  calls move to same-origin `/prep/public/...` after the rebuild
- Current API paths stay `/prep/...` (no API rewrite)
- Staging `psr19uhop4` untouched

### What it would risk if done now

- Default CF methods are GET/HEAD/OPTIONS only — a wrong path pattern
  sends POSTs to S3 or drops them
- Default cache is CachingOptimized — a wrong behavior can cache API
  JSON
- Custom error 403/404 → `index.html` on the **default** behavior would
  hide API errors if API traffic missed `/prep*`
- Same-origin `/prep` changes CORS from required to optional; leftover
  execute-api callers still need the current CORS allow-list
- Locking execute-api too early breaks webhooks, `/scheduled`,
  `x-bridge-secret`, and any operator curl that still uses the raw URL
- CloudFront WAF `CONTAINS /auth` would then also count
  `/prep/auth` (intended) **and** SPA `/auth` (already happens)

### Direct execute-api after CloudFront fronts the API

Should be **restricted only after** the SPA URL flip and webhook
ingress are designed. Options: HTTP API resource policy, Lambda
`x-origin-verify` header from the CloudFront origin, or
`DisableExecuteApiEndpoint` (requires a custom domain first — not
present). Do not disable execute-api in Batch 2.

---

## Interim controls (sufficient for Batch 2, not for money)

Already live and enough while financial/provider flags stay OFF:

- CloudFront WAF on the public site (managed rules **COUNT**; path
  rates **BLOCK** as reviewed)
- HTTP API throttle **50 rps / 100 burst** (no API keys)
- Production CORS allow-list (staging still `*`)
- Cognito JWT on authenticated `/data`, `/storage`, `/workflow`
- Public endorsement/signature still token-gated
- API access logs without bodies/tokens; CloudFront logs writing

Gaps that remain until API traffic is on CloudFront (or equivalent):

- No WAF managed-rule visibility on execute-api
- CloudFront path rate limits do not apply to `/prep/auth|storage|public`
- execute-api remains internet-public (throttle + JWT + CORS only)

That gap is **acceptable for Batch 2**. It is **not** acceptable as the
last perimeter step before Moov/CheckAlt/financial execution.

---

## Migration / rollback risk (later batch only)

| Step | Risk | Rollback |
|---|---|---|
| Add unused `/prep*` origin+behavior, execute-api still primary | Low | Delete the extra behavior/origin only |
| Flip SPA `VITE_CHECKSOPS_API_URL` to `https://checksops.com/prep` | Medium (CORS, POST methods, cache) | Redeploy SPA with execute-api URL |
| Restrict execute-api | High (webhooks, scheduled, bridges) | Re-open execute-api; keep CF origin |

Distribution replacement: **NO** if only an origin/behavior is added.  
API replacement: **NO**.  
Do this only in an approved later batch, after Batch 2 is closed.

---

## Operator leftovers

- Do not redeploy `aws/production/waf-api.yaml` (now marked DO NOT DEPLOY).
- Optional: delete `ROLLBACK_COMPLETE` stack
  `checksops-production-api-waf`.
- Leave `checksops-production-cloudfront-waf` and the live CloudFront
  `WebACLId` attached.
