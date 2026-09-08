# API Perimeter Step 3 — Gate 3C PASS (observe mode)

**Date:** 2026-09-08  
**Account:** `806168576068`  
**Region:** `us-east-1`  
**Caller:** `arn:aws:sts::806168576068:assumed-role/ChecksOpsCursorApiPerimeterStep3Temp/checksops-step3-gate3c`  
**Package:** `aws/origin-verify/apply-gate3c.mjs` (pinned start `97cd1bb08a1e9a308993ae5eea6b5cc93cc3034d`; live strip uses overwrite empty-string mapping — see note below)  
**Mode:** observe only. `ORIGIN_VERIFY_REQUIRE` remains unset / false. Gate 3D was **not** started.

Secret value, hash, prefix, and CloudFront `HeaderValue` are **not** recorded here.

## Prior gates

- **3A PASS** — `aws/cutover/API_PERIMETER_STEP3_GATES_3ABC_RESULTS.md`. Authorizer Lambda `checksops-production-origin-verify` exists, unattached at 3A, `ORIGIN_VERIFY_REQUIRE` false.
- **3B PASS** — privileged AWS operator applied CloudFront custom origin header independently. Validated: distribution `E1B0ZWWO5559U5` Deployed; WAF unchanged; header name `x-checksops-origin-verify` present; custom header quantity 1; CloudFront and raw execute-api `/prep/health` 200; `authorizerAttached=false` at that time; `ORIGIN_VERIFY_REQUIRE=false`.

## Gate 3C apply (this record)

`CHECKSOPS_APPLY_GATE3C=I_UNDERSTAND_PRODUCTION` + `CHECKSOPS_STEP3_EXECUTE=1` + `node aws/origin-verify/apply-gate3c.mjs`

| Check | Result |
|---|---|
| OPTIONS `/{proxy+}` | Exists: `lhp5gzu`. `AuthorizationType=NONE`. Target `integrations/jci10de`. |
| `$default` | `r0mx1qj`. `AuthorizationType=CUSTOM`. `AuthorizerId=0dwrwx`. Target `integrations/jci10de`. |
| Authorizer `0dwrwx` | REQUEST, payload 2.0, simple responses, identity `$context.httpMethod`, TTL 0, URI `function:checksops-production-origin-verify/invocations`. |
| Integration `jci10de` URI | Still `arn:aws:lambda:us-east-1:806168576068:function:checksops-production-prep-api`. `integrationStillPrep=true`. |
| Header strip | `RequestParameters` = `overwrite:header.x-checksops-origin-verify` → empty string. Header is overwritten to blank before the prep Lambda. See mapping note. |
| Authorizer Lambda env | Empty. `ORIGIN_VERIFY_REQUIRE` `<unset>` → false. |
| CloudFront | Status Deployed. WAF ACL unchanged. Origin custom header name present. Quantity 1. |
| `DisableExecuteApiEndpoint` | `false` on HTTP API `kiqojucc02` (unchanged). |

### Integration mapping note

HTTP API CLI/SDK does not persist `remove:header.x-checksops-origin-verify` as an empty string (CLI omits empty map values; an empty remove source is rejected as improper). Combining `remove:` with `overwrite:` is rejected (`Parameter header.x-checksops-origin-verify is not unique`). The working observe-mode strip is:

`overwrite:header.x-checksops-origin-verify` = empty string

That mapping is non-secret and is what live `jci10de` uses.

## Observe-mode traffic

Authorizer CloudWatch stream `/aws/lambda/checksops-production-origin-verify` `2026/09/08/[$LATEST]a3155fb65e6e476e9dc338f818252acc` after live probes:

| Source | `originHeaderPresent` | `originHeaderValid` |
|---|---|---|
| CloudFront `https://checksops.com/prep/health` | `true` | `true` |
| CloudFront `https://www.checksops.com/prep/health` | `true` | `true` |
| Raw `https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep/health` | `false` | `false` |

Log lines contain only `requestId` plus those booleans. No secret, hash, prefix, or header value.

## Health (observe mode — both paths still available)

| Probe | HTTP | Body | Notes |
|---|---|---|---|
| `https://checksops.com/prep/health` | 200 | `ok` | `x-amz-cf-id` present |
| `https://www.checksops.com/prep/health` | 200 | `ok` | `x-amz-cf-id` present |
| Raw execute-api `/prep/health` | 200 | `ok` | Direct hostname, no `x-amz-cf-id` |
| CloudFront OPTIONS `/prep/health` | 204 | empty | Unauthenticated OPTIONS route |

## Holds — unchanged / off

`GET /prep/ops/readiness` `holds.ok=true`. `GET /prep/financial/status` `productionExecution=false`.

| Surface | Result |
|---|---|
| WAF | Unchanged ACL `checksops-production-cloudfront-waf` / `cc8aadde-2bab-4d5e-8144-7d8981f44ad7` |
| SPA / DNS / Cognito / RDS | Not modified |
| Moov / CheckAlt | `AWS_MOOV_ENABLED=false`, `AWS_CHECKALT_ENABLED=false` |
| Provider / financial execution | `productionExecution=false`; `AWS_PROVIDER_EXECUTION_ENABLED=false`; `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=false`; `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false` |
| `64_financial_activation_grants.sql` | `financialActivationSqlApplied=false` |
| Gate 3D | **Not started.** `ORIGIN_VERIFY_REQUIRE` not set true. Execute-api endpoint not disabled. |

## STOP

Gate 3C observe mode is **PASS**.

Do **not** start Gate 3D. Do **not** set `ORIGIN_VERIFY_REQUIRE` to true. Do **not** disable the execute-api endpoint. Do **not** delete `ChecksOpsCursorApiPerimeterStep3Temp`.
