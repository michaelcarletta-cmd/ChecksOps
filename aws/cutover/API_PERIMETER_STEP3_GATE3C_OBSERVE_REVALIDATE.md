# API Perimeter Step 3 — Gate 3C observe revalidation

**2026-09-09.** STOP FOR REVIEW. Gate 3D was **not** started.

Caller
`arn:aws:sts::806168576068:assumed-role/ChecksOpsCursorApiPerimeterStep3Temp/checksops-step3-gate3c-validate`.

Secret value, hash, prefix, and CloudFront `HeaderValue` are **not** recorded here.

## Confirm-first (live)

| Check | Result |
|---|---|
| GetCallerIdentity Step3Temp | **true** (`…/ChecksOpsCursorApiPerimeterStep3Temp/checksops-step3-gate3c-confirm`) |
| `ORIGIN_VERIFY_REQUIRE` | `<unset>` / false |
| `holds.ok` | **true** |
| `productionExecution` | **false** |
| Moov / CheckAlt / provider / financial execution flags | **false** |
| `64_financial_activation_grants.sql` | `financialActivationSqlApplied=false` |
| CloudFront `E1B0ZWWO5559U5` | **Deployed** |
| Production WAF | Unchanged `checksops-production-cloudfront-waf` / `cc8aadde-2bab-4d5e-8144-7d8981f44ad7` |
| Origin custom header | Exactly one name `x-checksops-origin-verify` |
| CloudFront `/prep/health` | 200 |
| Raw execute-api `/prep/health` | 200 |
| Execute-api enabled | `DisableExecuteApiEndpoint=false` |

Gate 3B’s “authorizer not attached” snapshot is **stale**. Live `$default` is already `CUSTOM` / `0dwrwx`. OPTIONS `/{proxy+}` is already `NONE` → `jci10de`. Integration `jci10de` already has `overwrite:header.x-checksops-origin-verify` = empty string and still targets `checksops-production-prep-api`. Authorizer Lambda env is empty.

**This run did not re-apply Gate 3C.** `apply-gate3c.mjs` was not executed. Observe mode was already in place from the 2026-09-08 PASS record.

## Observe validate (this run)

Authorizer log group `/aws/lambda/checksops-production-origin-verify` after CloudFront and raw `/prep/health` probes. Public booleans only.

| Source | `originHeaderPresent` | `originHeaderValid` |
|---|---|---|
| CloudFront `https://checksops.com/prep/health` | `true` | `true` |
| Raw `https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep/health` | `false` | `false` |

Sample count this window: 10. No `HeaderValue`, `SecretString`, or JWT in authorizer log lines.

## Health

| Probe | HTTP | Notes |
|---|---|---|
| `https://checksops.com/prep/health` | 200 | `x-amz-cf-id` present |
| `https://www.checksops.com/prep/health` | 200 | `x-amz-cf-id` present |
| Raw execute-api `/prep/health` | 200 | observe mode still allows raw |
| CloudFront OPTIONS `/prep/health` | 204 | unauthenticated OPTIONS route |

## Header strip

Live `jci10de` request parameter `overwrite:header.x-checksops-origin-verify` is the empty-string mapping. That blanks the header before the prep Lambda. Step3Temp is denied `logs:FilterLogEvents` on `/aws/lambda/checksops-production-prep-api`, so prep-log inspection was not used. The strip is confirmed from the integration configuration, not from dumping prep events.

## App routes through CloudFront (observe — authorizer must not block)

Cognito was **not** modified. No password reset, no passwordless start, no ID token minted. These checks prove each route **reaches prep** (JSON `service=checksops-api` / prep error) and is **not** an API Gateway 401/403 from the origin-verify authorizer.

| Route | Result |
|---|---|
| `POST /prep/auth/login` `{}` | Reached prep `missing_credentials` |
| `POST /prep/data/query` | Reached prep `missing_cognito_token` |
| `POST /prep/data/write` | Reached prep `missing_cognito_token` |
| `POST /prep/workflow/transition` | Reached prep (not gateway unauthorized) |
| `POST /prep/public/signature-document` | Reached prep through CloudFront |
| `POST /prep/public/endorsement` | Reached prep through CloudFront |
| `POST /prep/storage/sign` | Reached prep |
| `POST /prep/storage/upload-url` | Reached prep |
| `POST /prep/authorization/isolation` | Reached prep `missing_cognito_token` |

Authenticated Tester login / tenant-row isolation with a live ID token was **not** re-run this turn (would require a Cognito password change or a CloudShell EMAIL_OTP). Observe-mode authorizer allow is what Gate 3C changes; JWT/RLS stay in prep.

## Holds — unchanged / off

| Surface | Result |
|---|---|
| WAF | Unchanged |
| SPA / DNS / Cognito / RDS / prep Lambda | Not modified |
| `productionExecution` | **false** |
| Moov / CheckAlt / provider / financial execution | **false** |
| `financialActivationSqlApplied` | **false** |
| Gate 3D | **Not started.** `ORIGIN_VERIFY_REQUIRE` still unset. Execute-api not disabled. Step3Temp not deleted. |

## STOP

Gate 3C observe mode remains **PASS**. Do **not** start Gate 3D. Do **not** set `ORIGIN_VERIFY_REQUIRE=true`. Do **not** disable execute-api.
