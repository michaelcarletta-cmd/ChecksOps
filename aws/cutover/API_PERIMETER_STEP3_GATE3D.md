# API Perimeter Step 3 — Gate 3D package (review only)

**STOP FOR REVIEW. DO NOT APPLY GATE 3D.**

Pinned start: merged main `28b9026cc183956198260b5f481674fcb7cae88e` (Gate 3C observe-mode PASS).

This package prepares require-mode enforcement. It does **not** execute it.

- Do **not** set `ORIGIN_VERIFY_REQUIRE=true` live from this PR.
- Do **not** disable the execute-api endpoint.
- Do **not** modify CloudFront, WAF, SPA, DNS, Cognito, RDS, Moov, CheckAlt,
  provider execution, financial execution, or `64_financial_activation_grants.sql`.
- Do **not** delete `ChecksOpsCursorApiPerimeterStep3Temp`.
- Do **not** print or record the secret, hash, prefix, or CloudFront `HeaderValue`.

Secret value is **not** recorded here.

## What this package changes if later approved

One Lambda environment key on `checksops-production-origin-verify`:

`ORIGIN_VERIFY_REQUIRE=true`

Every other existing authorizer environment variable is preserved. No other
AWS resource is in the apply path.

## Scripts

| Script | Role | Default |
|---|---|---|
| `aws/origin-verify/preflight-gate3d.mjs` | Read-only. Refuses unless Gate 3C is still intact. | Live read; no mutate |
| `aws/origin-verify/apply-gate3d.mjs` | Apply require-mode, then validate; automatic rollback on failure | Plan-only, exit 2 |
| `aws/origin-verify/rollback-gate3d.mjs` | Independent rollback: `ORIGIN_VERIFY_REQUIRE=false` only | Plan-only, exit 2 |
| `aws/origin-verify/validate-gate3d.mjs` | Post-apply CloudFront/API checks | Plan-only, exit 2 |

Apply requires **all three**:

```
CHECKSOPS_APPLY_GATE3D=I_UNDERSTAND_PRODUCTION
CHECKSOPS_GATE3D_ENFORCE=I_ACCEPT_REQUIRE_MODE
CHECKSOPS_STEP3_EXECUTE=1
```

Rollback is independently executable if CloudFront health fails after a later
approved apply:

```
CHECKSOPS_APPLY_ROLLBACK=I_UNDERSTAND_PRODUCTION
CHECKSOPS_ROLLBACK_GATE=3D
CHECKSOPS_STEP3_EXECUTE=1
```

## Preflight refuse conditions

Preflight refuses unless all of the following are true:

- Assumed caller contains `assumed-role/ChecksOpsCursorApiPerimeterStep3Temp/`
- CloudFront `E1B0ZWWO5559U5` is **Deployed**
- Production WAF ARN is unchanged
- API origin has exactly one `x-checksops-origin-verify` header (name only)
- `$default` uses the existing CUSTOM authorizer
- `OPTIONS /{proxy+}` is `AuthorizationType=NONE`
- `jci10de` still targets `checksops-production-prep-api`
- Origin header strip remains configured (`overwrite:header…` empty string)
- `ORIGIN_VERIFY_REQUIRE` is unset/false
- CloudFront observe samples are `originHeaderValid=true`
- Direct execute-api observe samples are `originHeaderValid=false`
- Provider and financial execution flags remain false
- `64_financial_activation_grants.sql` remains not applied
- `DisableExecuteApiEndpoint` remains false

## Post-apply validation (after a later approved execute)

Required:

- `https://checksops.com/prep/health` = 200
- `https://www.checksops.com/prep/health` = 200
- Normal application requests through CloudFront reach the prep Lambda
  (optional `CHECKSOPS_GATE3D_ID_TOKEN` proves authenticated `/prep/data/query` 200)
- Public `POST /prep/public/signature-document` and `/prep/public/endorsement`
  through CloudFront reach prep (not API Gateway 401/403)
- OPTIONS through CloudFront remains 204
- Raw execute-api without the origin header returns 401 or 403
- Fabricated origin-header attempts on raw execute-api return 401 or 403
- WAF and CloudFront configuration remain unchanged
- Integration still targets the prep Lambda
- Provider and financial flags remain false

If any required CloudFront/API check fails, apply sets
`ORIGIN_VERIFY_REQUIRE=false` and preserves remaining env keys.

## Residual: Step3Temp KMS deny

Authorizer env is currently **empty**. Writing any environment variable uses
Lambda env encryption (`kms:Encrypt`). `ChecksOpsCursorApiPerimeterStep3Temp`
still has `DenyKmsAndRoleChaining` (`kms:*` deny). Keep that deny.

A later approved execute may therefore fail closed on
`UpdateFunctionConfiguration` with “Access to KMS is not allowed”. That is
not an invitation to broaden Step3Temp. If KMS blocks the env write, a
privileged operator must apply the same single-key change. Do not recreate
the secret. Do not print `HeaderValue`.

Rollback has the same KMS residual because it also writes
`ORIGIN_VERIFY_REQUIRE=false`.

## Read-only preflight (package time)

Assumed `.../assumed-role/ChecksOpsCursorApiPerimeterStep3Temp/checksops-step3-gate3d-preflight`.
`node aws/origin-verify/preflight-gate3d.mjs` exit 0. Apply was **not** executed.
Lambda `ORIGIN_VERIFY_REQUIRE` remains `<unset>`.

| Check | Result |
|---|---|
| CloudFront Deployed | true |
| WAF unchanged | true |
| Exactly one origin-verify header name | true |
| `$default` CUSTOM | true |
| OPTIONS NONE | true |
| `jci10de` still prep + strip configured | true |
| `ORIGIN_VERIFY_REQUIRE` unset/false | true |
| CloudFront observe valid | true |
| Raw execute-api observe invalid | true |
| Holds / provider / financial / `64_` | false / not applied |
| Execute-api enabled | true |

Apply and rollback scripts printed plan-only JSON and exited 2.

## STOP

Review this package only. Do **not** run `apply-gate3d.mjs` with
`CHECKSOPS_STEP3_EXECUTE=1`. Do **not** begin live enforcement.
