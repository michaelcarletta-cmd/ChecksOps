# Gate 3A BLOCKED — execution role missing

**STOP FOR REVIEW. Gates 3A–3C were not applied.**

| Gate | Result |
|---|---|
| 3A | **FAIL / BLOCKED** — `checksops-production-origin-verify` is `NoSuchEntity`; Step3Temp has an explicit deny on `iam:CreateRole` |
| 3B | **NOT STARTED** |
| 3C | **NOT STARTED** |
| 3D / `ORIGIN_VERIFY_REQUIRE=true` | **Not started** |

Assumed role (verified):
`arn:aws:sts::806168576068:assumed-role/ChecksOpsCursorApiPerimeterStep3Temp/checksops-step3-gates-3abc`

Preflight before any write:

| Check | Result |
|---|---|
| `holds.ok` | **true** |
| `productionExecution` | **false** |
| Moov / CheckAlt / provider / financial flags | **false** |
| `financialActivationSqlApplied` | **false** |
| `64_financial_activation_grants.sql` | **NOT_APPLIED** |
| Execution role `GetRole` | **NoSuchEntity** (matches privileged operator) |
| Secret / authorizer Lambda / authorizer object | **not created** |
| `$default` | still `AuthorizationType=NONE` |
| CloudFront `ProductionPrepHttpApi` custom headers | still **0** (not modified) |

`iam:CreateRole` on `checksops-production-origin-verify` is **AccessDenied**
with explicit deny `ChecksOpsCursorApiPerimeterStep3Deny`.
`cloudformation:CreateStack` is also denied (no allow).

No secret was created. No Lambda. No authorizer. No CloudFront update.
No `$default` change. SPA / prep Lambda / RDS / Cognito / WAF / DNS
untouched. Temporary API-perimeter roles were not deleted.

---

## Privileged operator — create the reviewed execution role only

Template: `aws/production/cursor-api-perimeter-step3-execution-role.yaml`

This is the reviewed `OriginVerifyExecutionRole` from
`aws/production/cursor-api-perimeter-step3-role.yaml`:

- Trust: `lambda.amazonaws.com` / `sts:AssumeRole` only
- Inline policy name: `origin-verify-secret-and-logs`
- Logs on `/aws/lambda/checksops-production-origin-verify*`
- `secretsmanager:GetSecretValue` on `checksops/production/cloudfront-origin-verify*`
- No VPC, no RDS, no Cognito, no prep Lambda, no CloudFront

| Field | Value |
|---|---|
| Stack name | `checksops-cursor-api-perimeter-step3-execution-role` |
| Region | `us-east-1` |
| Capabilities | `CAPABILITY_NAMED_IAM` |
| Parameters | `DeployRole=true` |

```
aws cloudformation create-stack \
  --region us-east-1 \
  --stack-name checksops-cursor-api-perimeter-step3-execution-role \
  --template-body file://aws/production/cursor-api-perimeter-step3-execution-role.yaml \
  --parameters ParameterKey=DeployRole,ParameterValue=true \
  --capabilities CAPABILITY_NAMED_IAM
```

Wait `CREATE_COMPLETE`. Do not attach an authorizer. Do not create the
secret. Do not modify CloudFront. Do not set `ORIGIN_VERIFY_REQUIRE=true`.

After the role exists, Cursor can assume Step3Temp and run Gates 3A→3B→3C
observe mode. Do **not** begin Gate 3D.
