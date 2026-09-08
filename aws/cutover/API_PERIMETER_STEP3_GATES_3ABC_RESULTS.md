# Step 3 Gates 3A–3C results — STOP AFTER 3A

**STOP FOR REVIEW.** Gate 3C was not started. Gate 3D / require-mode
was not started. `ORIGIN_VERIFY_REQUIRE` is unset/false.

Assumed `ChecksOpsCursorApiPerimeterStep3Temp`
(`.../checksops-step3-gates-3abc`).

Existing secret `checksops/production/cloudfront-origin-verify` was
**reused** (ARN suffix `cEzlyU`). It was not recreated or overwritten.
The secret value was never printed.

| Gate | Result |
|---|---|
| **3A** | **PASS** |
| **3B** | **FAIL / BLOCKED** — `GetSecretValue` → `Access to KMS is not allowed` |
| **3C** | **NOT STARTED** |
| 3D | **Not started** |

## Safety gates (unchanged)

`holds.ok=true`. `productionExecution=false`. Moov / CheckAlt / provider
/ financial flags **false**. `financialActivationSqlApplied=false`.
`64_financial_activation_grants.sql` **NOT_APPLIED**.

## Gate 3A PASS

Created using the existing execution role and existing secret:

| Item | Value |
|---|---|
| Lambda | `checksops-production-origin-verify` Node 20, no VPC, role `checksops-production-origin-verify` |
| Env | empty (Step3Temp `kms:*` deny blocks Lambda env encryption). Authorizer defaults keep REQUIRE false and SecretId = secret name |
| `ORIGIN_VERIFY_REQUIRE` | unset / **false** |
| Authorizer | `0dwrwx` REQUEST, payload 2.0, simple responses, `$context.httpMethod`, TTL 0 |
| Attached to `$default` | **no** |
| `$default` | `AuthorizationType=NONE` |
| CloudFront `/prep/health` | 200 `ok` + `x-amz-cf-id` |
| www `/prep/health` | 200 `ok` |
| Raw execute-api `/prep/health` | 200 `ok` |

## Gate 3B FAIL

Step3Temp cannot `GetSecretValue` (explicit `kms:*` deny). CloudFront
`E1B0ZWWO5559U5` was **not** updated. `ProductionPrepHttpApi` custom
headers still **0**. Status **Deployed**. Production WAF ARN unchanged.

Do not attach the authorizer until the CloudFront header is live.

## Privileged operator — Gate 3B only

Keep the Step3Temp KMS deny. Use
`aws/cutover/API_PERIMETER_STEP3_OPERATOR_GATE3B.md`.
Do not start Gate 3C. Do not attach the authorizer.
Do not set `ORIGIN_VERIFY_REQUIRE=true`. Do not delete the temporary roles.
