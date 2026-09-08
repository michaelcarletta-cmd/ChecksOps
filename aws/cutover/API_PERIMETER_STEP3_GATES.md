# Step 3 implementation package — Gates 3A–3C

**STOP FOR REVIEW. DO NOT CREATE THE STEP 3 ROLE. DO NOT DEPLOY STEP 3.**

Approved architecture from `API_BEHIND_CLOUDFRONT_STEP3_DESIGN.md` is unchanged:
CloudFront origin header, REQUEST authorizer, payload 2.0 / simple responses,
`$context.httpMethod`, TTL 0, observe before require, `OPTIONS /{proxy+}` NONE,
strip `x-checksops-origin-verify` on `jci10de`, dual-secret rotation,
execute-api remains enabled.

Caller audit is **FAIL** until EventBridge / Scheduler / Synthetics / alarms
are listed. Do **not** start Gate 3A until that audit is **PASS**.

This package never flips `ORIGIN_VERIFY_REQUIRE=true`. Gate 3D is a later
human approval.

Apply scripts print a plan and **exit 2** even when the apply gate env is set.
They do not call mutating AWS APIs from this PR.

Do not modify SPA, RDS, Cognito, WAF, DNS, prep Lambda, or the amber banner.
Do not delete Steps12Temp. Do not begin RDS secret rotation.
`64_financial_activation_grants.sql` stays **NOT_APPLIED**.

---

## IAM review (Step 3 deploy role)

Template: `aws/production/cursor-api-perimeter-step3-role.yaml`
(`DeployRole` default **false**). Name `ChecksOpsCursorApiPerimeterStep3Temp`.

**Do not create it this turn.**

| Residual | Risk | Mitigation |
|---|---|---|
| `cloudfront:UpdateDistribution` on `E1B0ZWWO5559U5` | Can change more than the origin header (WAF, behaviors, aliases). | Post-gate check: `WebACLId` still the production WAF ARN; aliases apex+www; `/prep` behaviors unchanged. |
| `apigateway:PATCH` on `integrations/jci10de` | Can change `IntegrationUri` away from prep Lambda. | Post-gate check URI still `...function:checksops-production-prep-api/invocations`. Mapping file records the required URI. |
| `GetDistributionConfig` + `GetSecretValue` | Role can read the origin secret after Gate 3B. | Never dump config to tickets. Staging + Steps12Temp have the same residual. |
| `lambda:AddPermission` on origin-verify only | Could add extra invoke principals on that function. | Verify resource policy is APIGW authorizer SourceArn only. |
| `secretsmanager:CreateSecret` on the name prefix | Can create/read only that secret family. | Deny delete/rotate. No other secret ARNs. |

Explicit denies remain: RDS, Cognito, prep Lambda, WAF, DNS, security
monitoring, EventBridge/Scheduler writes, other secrets, API-level PATCH
(blocks `DisableExecuteApiEndpoint` and access-log format widening), S3/SPA,
`ChecksOpsCursor*` IAM, prep execution role.

Audit role (`ChecksOpsCursorApiPerimeterStep3AuditTemp`) is **read-only**
list/describe. No `GetSecretValue`. No writes. Also `DeployRole=false`.
Do not create it this turn. Smallest path is a human Console/CLI list
(see caller audit).

No privilege-escalation path to prep Lambda env, financial flags, or
provider secrets was found that is not already listed as a residual
requiring post-gate verification.

---

## Exact Gate 3A–3C plan

### Gate 3A — create, do not enforce

1. Human creates Step 3 deploy role + authorizer execution role only after
   review (`DeployRole=true` on the deploy template). Not this PR.
2. Generate secret with `openssl rand -hex 32`. Store
   `{ "current": "<value>", "next": "" }` as
   `checksops/production/cloudfront-origin-verify`. **Never print the value.**
3. Zip `aws/functions/origin-verify/authorizer.mjs` +
   `@aws-sdk/client-secrets-manager`. Create Lambda
   `checksops-production-origin-verify` (Node 20, **no VPC**).
   Env: `ORIGIN_VERIFY_REQUIRE=false`, `ORIGIN_VERIFY_SECRET_ARN=<arn>`.
4. `apigatewayv2 create-authorizer` using
   `aws/origin-verify/authorizer-config.json` (REQUEST, 2.0, simple
   responses, `$context.httpMethod`, TTL 0). **Do not attach** to `$default`.
5. `lambda add-permission` for `apigateway.amazonaws.com` on
   `...:kiqojucc02/authorizers/{id}` only.
6. Prove `$default` is still `AuthorizationType=NONE`. CloudFront and raw
   execute-api still 200.

### Gate 3B — CloudFront header

1. `GetDistributionConfig` for `E1B0ZWWO5559U5`.
2. Set origin `ProductionPrepHttpApi` custom header name
   `x-checksops-origin-verify` to secret `current`. Do not write the value
   into Git or logs. Redact `HeaderValue` in any saved artifact.
3. `UpdateDistribution`. Wait Status **Deployed**.
4. Verify WAF ARN unchanged. Header **name** present. Value not printed.
5. Raw execute-api still 200 (authorizer not attached).

### Gate 3C — observe attach, then STOP

1. Create `OPTIONS /{proxy+}` `AuthorizationType=NONE` → `jci10de`
   (`aws/origin-verify/options-route.json`).
2. `update-integration` `jci10de` request parameter
   `remove:header.x-checksops-origin-verify`
   (`aws/origin-verify/integration-header-remove.json`). Re-read
   `IntegrationUri` — must still be prep Lambda.
3. `update-route` `$default` `AuthorizationType=CUSTOM` + AuthorizerId.
   Lambda env remains `ORIGIN_VERIFY_REQUIRE=false`.
4. Observe validate (`aws/origin-verify/observe-validate.mjs`):
   CloudFront samples `originHeaderPresent=true` and
   `originHeaderValid=true`. Direct execute-api samples
   `originHeaderPresent=false` and `originHeaderValid=false`.
   **Never print the secret.**
5. **STOP FOR REVIEW.** Do not set `ORIGIN_VERIFY_REQUIRE=true`.

---

## Rollback

Execute-api stays enabled.

| Gate | Rollback |
|---|---|
| 3A | Leave unused. Optionally delete unattached authorizer + Lambda. Do not force-delete the secret. |
| 3B | Remove the custom header from `ProductionPrepHttpApi`. Wait Deployed. |
| 3C | `$default` back to `AuthorizationType=NONE`. Fastest later require-mode rollback (Gate 3D) is `ORIGIN_VERIFY_REQUIRE=false`. |

`aws/origin-verify/rollback-gate3.mjs` prints the plan and exits 2.

---

## Safety-gate status (2026-09-08T16:20Z)

| Gate | Status |
|---|---|
| Caller audit | **FAIL** (EventBridge/Scheduler/Synthetics/alarms not listable) |
| CloudFront `/prep/health` | PASS (`ok`, `production-prep`) |
| Raw execute-api `/prep/health` | PASS (rollback path live) |
| SPA bundle hostname | PASS (absent) |
| `holds.ok` | **true** |
| `productionExecution` | **false** |
| Moov / CheckAlt / provider / financial | **false** |
| `financialActivationSqlApplied` | **false** |
| `64_financial_activation_grants.sql` | **NOT_APPLIED** |
| Amber banner | Unchanged |
| Steps12Temp | Not deleted / not broadened |
| Step 3 roles | **Not created** |
| Origin secret / authorizer / CF header | **Not created** |
| Gate 3D require-mode | **Not in this package** |
