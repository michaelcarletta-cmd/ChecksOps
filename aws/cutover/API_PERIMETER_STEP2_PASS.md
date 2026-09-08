# Gate 2 / Step 2 PASS

**2026-09-08T15:35Z.** STOP FOR REVIEW. **Do not start Step 3 / origin-verify.**

Assumed deploy role
`arn:aws:sts::806168576068:assumed-role/ChecksOpsCursorApiPerimeterSteps12Temp/checksops-api-perimeter-g2`.

Cognito AdminSetUserPassword for validation used
`ChecksOpsCursorCloudStaging/checksops-t0-run` on the two existing T0 lifecycle
accounts only (Tester + C1C). No pool, client, user-import, MFA, or email changes.

## Deployed SPA

| Item | Value |
|---|---|
| Build | `vite build --mode aws` with `VITE_CHECKSOPS_API_URL=/prep` (not hardcoded apex `/prep`) |
| Main bundle | `assets/index-reP2FWHf.js` |
| SHA-256 | `4ef3aaf9eac12f0a5ba47887683e7efdd93fa87b5de1af3ecc5be812b27ea076` |
| Bytes | 885373 |
| Apex URL | https://checksops.com/assets/index-reP2FWHf.js |
| www URL | https://www.checksops.com/assets/index-reP2FWHf.js |
| Bucket | `checksops-production-frontend-806168576068` |
| Invalidation | `IC82N23UL6OPOAD7CBGFFBY6T3` `/*` **Completed** |
| `window.location.origin` | inlined: `Ta()` uses `"/prep"` + `window.location.origin` via `resolveAwsApiBaseUrl` |
| Hardcoded `https://checksops.com/prep` | **absent** (www stays same-origin) |
| `kiqojucc02.execute-api.us-east-1.amazonaws.com` | **absent** from shipped bundle |
| Staging execute-api / staging pool | **absent** |

`VITE_APP_URL=https://checksops.com` (WebAuthn RP `checksops.com`). Password login
goes to same-origin `POST /prep/auth/login` (Lambda → Cognito), not a browser
Cognito SDK.

## Same-origin proof

Live minified helper:

`sA("/prep", window.location.origin)` → `new URL("/prep", origin)` so

- `https://checksops.com` → `https://checksops.com/prep`
- `https://www.checksops.com` → `https://www.checksops.com/prep`

Observed CloudFront API calls (`x-amz-cf-id` present):

- `POST https://checksops.com/prep/auth/login` 200
- `POST https://www.checksops.com/prep/auth/login` 200
- Access logs: `POST /prep/auth/login`, `POST /prep/data/query`, `POST /prep/data/write`, `POST /prep/workflow/checks`, `OPTIONS+DELETE /prep/workflow/checks/:id`, `POST /prep/storage/sign`, `POST /prep/storage/upload-url`

## Validation

| Check | Result |
|---|---|
| Shipped bundle has no `kiqojucc02.execute-api…` | PASS |
| Browser API base is same-origin `/prep` | PASS |
| Apex login | PASS (`/prep/auth/login` 200, CF) |
| www login | PASS (`/prep/auth/login` 200, CF) |
| Cognito authentication | PASS (Tester + C1C ID tokens) |
| Authenticated reads | PASS (`/data/query` 194 Freedom checks, `applicationUserId=abd3c2a0-…`) |
| Nonfinancial writes | PASS (`check_message_reads` upsert 200) |
| Workflow POST | PASS (create ignored spoofed C1C tenant; landed Freedom) |
| Workflow browser DELETE | PASS (`DELETE /prep/workflow/checks/:id` 200 `cleanedUp=true`; OPTIONS 204) |
| Tenant isolation | PASS (Tester Freedom-only; C1C 0 Freedom checks; tenant rows differ) |
| `/sign` SPA | PASS (HTML 200) |
| `/sign` flow API | PASS (`POST /prep/public/signature-document` JSON 404 `fetch_signer`, not SPA) |
| `/endorse` SPA | PASS (HTML 200) |
| `/endorse` flow API | PASS (`POST /prep/public/endorsement` JSON 404, not SPA) |
| Historical `/storage/sign` | PASS (presigned URL with `X-Amz-Signature` query string) |
| `/storage/upload-url` | PASS |
| Direct S3 PUT from presigned URL | PASS (200 to files bucket host, not CloudFront) |
| API access logs | PASS (`/aws/apigateway/checksops-production-prep-http` still ingesting `/prep/*`) |
| CloudFront/WAF still active | PASS (`E1B0ZWWO5559U5` Deployed; WAF `…7d8981f44ad7`; aliases apex+www) |
| Step 1 `/prep` + `/prep/*` routing | **unchanged** |
| `/prep/ops/readiness` `holds.ok=true` | PASS |
| `/prep/financial/status` `productionExecution=false` | PASS |
| Raw execute-api `/prep/health` | PASS (rollback path live) |
| Moov/CheckAlt/Plaid/Actum/QBO/provider/live-reads/financial | all **false** |
| `financialActivationSqlApplied` | **false** |
| `64_financial_activation_grants.sql` | **NOT_APPLIED** / `DO NOT APPLY THIS FILE` |

## Rollback

**Not used.** SPA remains the same-origin `/prep` build.

Rollback artifact is still at `/tmp/spa-rollback-step2` (`index-C24V_ODo.js`, execute-api). Restore that tree + invalidate `/*` only if a later review requires it. Do not revert Step 1 CloudFront.

Raw execute-api remains enabled.

## Not done (out of scope)

- Step 3 origin-verify secret / header
- API Gateway authorizer
- `DisableExecuteApiEndpoint`
- RDS secret rotation
- Deleting `ChecksOpsCursorApiPerimeterSteps12Temp`
- Lambda / WAF / DNS / security monitoring / provider/financial flag changes
