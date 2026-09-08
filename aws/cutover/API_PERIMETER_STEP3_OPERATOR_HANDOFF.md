# Privileged operator handoff — create Step3Temp only

**STOP FOR REVIEW. DO NOT DEPLOY GATE 3A–3C.**

This package creates **only** `ChecksOpsCursorApiPerimeterStep3Temp`.
It does **not** create the origin-verify secret, authorizer Lambda,
CloudFront header, authorizer attachment, `$default` change, or
`ORIGIN_VERIFY_REQUIRE=true`.

Do not modify prep Lambda / RDS / Cognito / WAF / DNS.
Do not enable financial or provider execution.
`productionExecution=false`. All provider/financial flags stay false.
`64_financial_activation_grants.sql` stays **NOT_APPLIED**.

Caller audit is **PASS**. Steps 1–2 remain live. Execute-api stays enabled.

---

## 1. Reviewed files — exact branch / commit

These files are on `cursor/cf-origin-verify-observe-9053` and this
handoff branch at the same tree as observe HEAD.

| File | First / last content commit | Present at |
|---|---|---|
| `aws/production/cursor-api-perimeter-step3-role.yaml` (combined reviewed template, **includes** execution role) | `67243a1b2ac17ac31f0d85ce2289839cf72432a5` | `b14ca5e9652eca58bb163967ae6886accdd92eb4` |
| Step 3 authorizer execution-role definition (`OriginVerifyExecutionRole` / `checksops-production-origin-verify`) | same YAML, same commit | same HEAD |
| `aws/cutover/API_PERIMETER_STEP3_GATES.md` | `cf1fc7e10c2309f5e35584b26f62fc97a2c5f757` | same HEAD |

Blob at that HEAD:

- `aws/production/cursor-api-perimeter-step3-role.yaml` → `bc32616a3d2bb7622ac7f4130c0d77e284d840a9`
- `aws/cutover/API_PERIMETER_STEP3_GATES.md` → `4cd1e5267daf3f53cf97b2a95051da94eaa52a8d`

Do **not** deploy the combined YAML. It would try to create
`checksops-production-origin-verify` and can collide with the leftover
role from the failed staging probe.

Operator download for this handoff (Step3Temp only):

- Path: `aws/production/cursor-api-perimeter-step3-temp-role-only.yaml`
- Commit that added the YAML: `c3a7ce822b1f32655d9a89c982d498e1004f0fff`
- Blob: `9c2d0566bf2a96ab9ed7e78540b4de63304f5c02`
- Raw: `https://raw.githubusercontent.com/michaelcarletta-cmd/ChecksOps/c3a7ce822b1f32655d9a89c982d498e1004f0fff/aws/production/cursor-api-perimeter-step3-temp-role-only.yaml`

Allow / deny / trust companions (unchanged, reviewed):

- `aws/production/cursor-api-perimeter-step3-role-allow.json`
- `aws/production/cursor-api-perimeter-step3-role-deny.json`
- `aws/production/cursor-api-perimeter-step3-role-trust.json`

---

## 2. Leftover execution role — inspect only

Name: `checksops-production-origin-verify`
Account: `806168576068`

**Do not change or delete this role this turn.**

Staging (`ChecksOpsCursorCloudStaging`) and Steps12Temp cannot
`iam:GetRole` / `ListRolePolicies` / `ListAttachedRolePolicies` /
`GetRolePolicy`. IAM returns `AccessDenied` (not `NoSuchEntity`) for
both this name and the missing `ChecksOpsCursorApiPerimeterStep3Temp`,
so AccessDenied does **not** prove the leftover exists.

Supporting evidence it **likely** exists from the prior staging probe:

- Stack `checksops-cursor-api-perimeter-step3-role` was started with
  `DeployRole=true`, `CREATE_FAILED` on `iam:CreatePolicy`, then
  deleted. `DescribeStacks` now: stack **does not exist**.
- `OriginVerifyExecutionRole` had no `DependsOn` on the failed
  managed policies, so CloudFormation could have created it in
  parallel. The delete used `--retain-resources OriginVerifyExecutionRole`.
- Later `DeleteRolePolicy` was `AccessDenied`, not `NoSuchEntity`.

Live related resources (2026-09-08, this handoff):

| Check | Result |
|---|---|
| `ChecksOpsCursorApiPerimeterStep3Temp` assume | `AccessDenied` (role not created) |
| Lambda `checksops-production-origin-verify` | `ResourceNotFoundException` |
| Secret `checksops/production/cloudfront-origin-verify` | `ResourceNotFoundException` |
| HTTP API `kiqojucc02` authorizers | empty |
| `$default` `r0mx1qj` | `AuthorizationType=NONE` |
| CloudFront `E1B0ZWWO5559U5` `ProductionPrepHttpApi` custom headers | **0** |
| CloudFront Status / aliases / WAF | Deployed; apex+www; production WAF ARN unchanged |

### Privileged operator inspect (read-only)

```
aws iam get-role --role-name checksops-production-origin-verify
aws iam list-role-policies --role-name checksops-production-origin-verify
aws iam list-attached-role-policies --role-name checksops-production-origin-verify
aws iam get-role-policy --role-name checksops-production-origin-verify --policy-name origin-verify-secret-and-logs
```

If `NoSuchEntity`: leftover is gone. **Do not create it in this stack.**
Report and stop. Gate 3A still needs an execution role later.

If the role exists, compare to the reviewed definition in
`aws/production/cursor-api-perimeter-step3-role.yaml`
(`OriginVerifyExecutionRole`).

### Expected match (reviewed)

Trust policy — Lambda only:

```
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

Inline policy name: `origin-verify-secret-and-logs`

Attached managed policies: **none**

Inline document (reviewed):

- `logs:CreateLogGroup` / `CreateLogStream` / `PutLogEvents` on
  `/aws/lambda/checksops-production-origin-verify` and `:*`
- `secretsmanager:GetSecretValue` on
  `checksops/production/cloudfront-origin-verify*`
- No VPC, no RDS, no Cognito, no prep Lambda, no CloudFront

### Reuse decision (do not act yet)

| Result | Safe to reuse? | This turn |
|---|---|---|
| Exact trust + only that inline policy + no attached policies | **Yes** — reuse later for Gate 3A | Do not change / delete |
| Missing inline policy, extra policies, or non-Lambda trust | **No** | Do not change / delete. Report. |
| `NoSuchEntity` | N/A | Do not create it here |

This agent cannot print the live trust or policy names.

---

## 3. Create ChecksOpsCursorApiPerimeterStep3Temp

**Privileged IAM principal only.** Not staging. Not Steps12Temp.
Do not broaden staging. Do not recreate deleted hardening roles.

### Downloadable template

`aws/production/cursor-api-perimeter-step3-temp-role-only.yaml`

Creates:

- Managed policy `ChecksOpsCursorApiPerimeterStep3Allow`
- Managed policy `ChecksOpsCursorApiPerimeterStep3Deny`
- Role `ChecksOpsCursorApiPerimeterStep3Temp` (Cursor OIDC
  `api.cursor.com` aud `sts.amazonaws.com` sub `user:325724407`)

Does **not** create `checksops-production-origin-verify`.

`DeployRole` default is **false**. The create command must pass `true`.

### Stack name / region / capabilities / parameters

| Field | Value |
|---|---|
| Stack name | `checksops-cursor-api-perimeter-step3-temp-role` |
| Region | `us-east-1` |
| Capabilities | `CAPABILITY_NAMED_IAM` |
| `DeployRole` | `true` |
| `RoleName` | omit (default `ChecksOpsCursorApiPerimeterStep3Temp`) |

Do **not** reuse deleted stack name
`checksops-cursor-api-perimeter-step3-role`.

```
aws cloudformation create-stack \
  --region us-east-1 \
  --stack-name checksops-cursor-api-perimeter-step3-temp-role \
  --template-body file://aws/production/cursor-api-perimeter-step3-temp-role-only.yaml \
  --parameters ParameterKey=DeployRole,ParameterValue=true \
  --capabilities CAPABILITY_NAMED_IAM
```

Wait `CREATE_COMPLETE`. Then **STOP**.

Do not run `aws/origin-verify/apply-gate3a.mjs`.
Do not set `CHECKSOPS_STEP3_EXECUTE=1`.
Do not create the origin-verify secret.
Do not attach an authorizer.
Do not change `$default`.
Do not set CloudFront origin headers.
Do not set `ORIGIN_VERIFY_REQUIRE=true`.

---

## 4. Live holds at handoff (unchanged)

`GET https://checksops.com/prep/health` → `status=ok`, `environment=production-prep`.
`GET https://checksops.com/prep/ops/readiness` → `holds.ok=true`.
`GET https://checksops.com/prep/financial/status` → `productionExecution=false`.
Moov / CheckAlt / provider / financial flags **false**.
`financialActivationSqlApplied=false`.
`64_financial_activation_grants.sql` **NOT_APPLIED**.
