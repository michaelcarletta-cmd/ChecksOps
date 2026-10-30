# API Perimeter Step 3 — Gate 3D live state (2026-10-30, read-only)

Owner request of 2026-10-30, verbatim: "Work on items 1 and 2" (item 1: restrict the raw API
Gateway endpoint). Read-only inspect by `user/claude-code`; nothing was changed. The Gate 3D
package (`API_PERIMETER_STEP3_GATE3D.md`) stays as the review-time record.

## Finding: Gate 3D require-mode is already live

- `checksops-production-origin-verify` environment: the one key `ORIGIN_VERIFY_REQUIRE` is
  `true` (LastModified 2026-09-09T02:07:14Z, RevisionId `fdbc8b41…`).
- CloudTrail: `UpdateFunctionConfiguration` on that function at 2026-09-09 02:07:15 UTC by
  `arn:aws:iam::806168576068:root` (the privileged-operator path). No record of this apply
  existed in the repository; this file is that record.
- `ChecksOpsCursorApiPerimeterStep3Temp` and `ChecksOpsCursorApiPerimeterStep3AuditTemp` no
  longer exist (`NoSuchEntity`), so the Step3Temp scripts and preflight cannot run as written.

## Live configuration

| Item | Value |
|---|---|
| HTTP API `kiqojucc02` (`checksops-production-prep-http`) | `DisableExecuteApiEndpoint` **false** |
| `$default` route | `CUSTOM`, authorizer `0dwrwx` (`checksops-production-origin-verify`, REQUEST, simple responses, cache TTL 0) |
| `OPTIONS /{proxy+}` | `NONE` (CORS preflight), integration `jci10de` |
| Stage `prep` | access logs on, throttle 50 rps |
| CloudFront `E1B0ZWWO5559U5` origin `ProductionPrepHttpApi` | one custom header, name `x-checksops-origin-verify` (value not read) |
| CloudFront WAF | `checksops-production-cloudfront-waf` |
| Staging HTTP API `psr19uhop4` | no authorizer, no origin-verify function, `DisableExecuteApiEndpoint` false |

## Probes (2026-10-30, no credentials)

| Request | Status |
|---|---|
| raw `GET https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep/health` | **403** |
| raw `GET …/prep/db-health` | 403 |
| raw `GET …/prep/health` with a fabricated `x-checksops-origin-verify` | 403 |
| raw `POST …/prep/data/query` | 403 |
| raw `POST …/prep/providers/moov/webhook` | 403 |
| raw `OPTIONS …/prep/data/query` | **204** (the `NONE` route reaches the prep Lambda) |
| `https://checksops.com/prep/health` | not reachable from this session; the guarded production overlay runs of 2026-10-30 (e.g. 41047251544) report `/health` and `/db-health` 200 through CloudFront |

## Callers (last 7 days)

Authorizer log lines `originHeaderValid`, 2026-10-23 to 2026-10-30: every request carried a valid
origin header (351,792 lines; daily 48 to 134,727). The only invalid ones are the five probes above
(2026-10-30). No webhook, health checker or workflow calls the raw endpoint successfully.

Repository references to the raw production host:

- `.github/workflows/guarded-production-cors.yml` "Public production smoke" sent raw `OPTIONS`
  preflights to `kiqojucc02…/prep/health`. #1439 moved them to `https://checksops.com/prep/health`
  (see the decision below).
- `scripts/deployment-guard/production-readonly-inspect.mjs` pins `api_host` (a recorded pin,
  not a request).
- Staging workflows and scripts call `psr19uhop4…/staging` directly; staging has no CloudFront
  API path, so its raw endpoint is its only endpoint.

## Decision (item 1): the raw endpoint stays enabled

Owner, 2026-10-30: "Go with B for item 1". `DisableExecuteApiEndpoint` stays **false** on
`kiqojucc02`. Item 1 is covered by require-mode: since 2026-09-09 the origin-verify authorizer
refuses every raw request except CORS preflight (`OPTIONS`), which returns headers and no data.

Why the endpoint cannot simply be disabled (read-only, 2026-10-30, `user/claude-code`):

- CloudFront `E1B0ZWWO5559U5` serves `/prep` and `/prep/*` from origin `ProductionPrepHttpApi`,
  whose domain is `kiqojucc02.execute-api.us-east-1.amazonaws.com`: the website itself reaches the
  API through the execute-api endpoint, adding `x-checksops-origin-verify`.
- API Gateway has no custom domain names (`apigatewayv2 GetDomainNames` returns `[]`), so nothing
  else maps to `kiqojucc02`.
- `DisableExecuteApiEndpoint=true` disables the execute-api endpoint for every caller, CloudFront
  included: `checksops.com/prep/*`, the whole app, would stop answering. An earlier version of this
  file proposed exactly that as the next step; it is withdrawn.

Kept: the PR `claude/cors-smoke-via-cloudfront` (#1439) moved the CORS smoke in
`guarded-production-cors.yml` to `https://checksops.com/prep/…` (same origins, same assertions).
That is harmless under this decision and tests the path users take. CloudFront passes preflights
through unchanged: the `/prep` and `/prep/*` behaviors allow `OPTIONS` and cache only `GET`/`HEAD`
(`Managed-CachingDisabled`), forward every viewer header except `Host`
(`Managed-AllViewerExceptHostHeader`, so `Origin` reaches the API), and the response headers
policy `756a8f23-…` has no CORS configuration.

If this is ever revisited (option A, not planned), the custom-domain prerequisite comes first, each
step its own reviewed PR and owner-approved run:

1. A regional API Gateway custom domain with an ACM certificate (for example `origin.checksops.com`)
   and an API mapping to `kiqojucc02`.
2. Move CloudFront's `ProductionPrepHttpApi` origin to that domain, keeping the origin-verify header.
3. Verify through CloudFront: `/prep/health` and `/prep/db-health` 200, an authenticated
   `POST /prep/data/query` 200.
4. Only then set `DisableExecuteApiEndpoint=true` (rollback: `false`), and a record PR.

Watch conditions while the endpoint stays enabled: any authorizer log line with
`originHeaderValid:false` that is not a known probe, or any change to `ORIGIN_VERIFY_REQUIRE` or
the authorizer configuration above.

Not verified: CloudFront `/prep` health from this session (proxy), the authenticated data query
through CloudFront, and the origin-verify secret (not read).
