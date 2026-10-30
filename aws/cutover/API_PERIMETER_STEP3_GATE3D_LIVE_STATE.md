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
  preflights to `kiqojucc02…/prep/health`, which would break once the raw endpoint is disabled.
  Step 1 below moves them to `https://checksops.com/prep/health`.
- `scripts/deployment-guard/production-readonly-inspect.mjs` pins `api_host` (a recorded pin,
  not a request).
- Staging workflows and scripts call `psr19uhop4…/staging` directly; staging has no CloudFront
  API path, so its raw endpoint is its only endpoint.

## What is left (item 1)

Require-mode already refuses every raw request except CORS preflight. The remaining step is
`DisableExecuteApiEndpoint=true` on `kiqojucc02`, which also closes the unauthenticated raw
`OPTIONS` route. Staging cannot rehearse it (staging has no origin-verify path and needs its raw
endpoint).

Proposed guarded sequence, each step its own reviewed PR and run:

1. Move the CORS smoke in `guarded-production-cors.yml` to CloudFront (`https://checksops.com/prep/…`).
   Done in source by the PR `claude/cors-smoke-via-cloudfront`: same origins, same assertions.
   CloudFront passes preflights through unchanged (read-only, 2026-10-30): the `/prep` and
   `/prep/*` behaviors allow `OPTIONS` and cache only `GET`/`HEAD` (`Managed-CachingDisabled`),
   forward every viewer header except `Host` (`Managed-AllViewerExceptHostHeader`, so `Origin`
   reaches the API), and the response headers policy `756a8f23-…` has no CORS configuration.
2. A reviewed tool that sets only `DisableExecuteApiEndpoint` on `kiqojucc02` from a read-only
   precondition (this file's configuration), run by a role that may `apigateway:PATCH` the API,
   on the owner's approval of that run. Post-checks: CloudFront `/prep/health` and
   `/prep/db-health` 200, authenticated `POST /prep/data/query` through CloudFront 200, raw
   `…/prep/health` no longer resolves (DNS or 403 from the disabled endpoint).
3. Rollback: the same tool with `DisableExecuteApiEndpoint=false`.
4. Record PR.

Stop conditions: any authorizer log line with `originHeaderValid:false` that is not a known probe,
a CloudFront path failure, or any change to the configuration above before the run.

Not verified: CloudFront `/prep` health from this session (proxy), the authenticated data query
through CloudFront, and the origin-verify secret (not read).
