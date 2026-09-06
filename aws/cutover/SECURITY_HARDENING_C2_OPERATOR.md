# C2 operator procedure (Console / CloudFormation)

**C1 read-only verify (2026-09-06T19:35:51Z):** PASS  
**C2 live:** still FAIL (prep and staging share the staging SAM role)  
**This document does not authorize Moov, CheckAlt, provider execution, financial execution, or `64_financial_activation_grants.sql`.**

Do **not** grant the Cloud Agent staging role general IAM administration. The agent will only re-verify read-only after you finish.

Account `806168576068`, region **`us-east-1`**.

---

## C1 read-only verify (already done)

Live `checksops-staging` at 2026-09-06T19:35:51Z:

| Control | Live |
|---|---|
| Identifier | `checksops-staging` (not renamed) |
| Status | `available` |
| Deletion protection | **ENABLED** (`true`) |
| Backup / PITR retention | **35** days |
| Latest restorable time | `2026-09-06T19:28:41Z` (PITR active) |
| Publicly accessible | `false` |
| Storage encrypted | `true` (KMS `ce55869a-433c-42e4-9b9a-3e0cf2c1d4b3`) |
| Multi-AZ | `false` |
| VPC | `vpc-09f2268778966ce97` |

No customer data was read beyond instance metadata. No RDS modify was attempted.

---

## C2 current state (do not skip cleanup)

| Item | Live |
|---|---|
| Production Lambda | `checksops-production-prep-api` still uses `checksops-staging-ApiFunctionRole-7E7XRyLe3nyi` |
| Staging Lambda | `checksops-staging-api` same role (leave this) |
| Prep `PROVIDER_SECRETS_ARN` | unset |
| Staging `PROVIDER_SECRETS_ARN` | set; sandbox execution `true` |
| Money flags | all `false` on prep |
| Leftover stack | `checksops-production-api-role` = **DELETE_FAILED** |
| Why it failed | CFN could not `iam:DeleteRolePolicy` on `ProductionApiExecutionRole` (`checksops-production-api-execution` likely exists) |
| Older unused name | `checksops-production-prep-api-role` — **do not use**; do not attach it |

You must clean the failed stack **before** creating a new stack with the same name.

---

## 1. What to do in AWS Console

Work only in **`us-east-1`**. Do not change RDS, Cognito, CloudFront, DNS, staging Lambda, or any `AWS_*_ENABLED` flags.

### A. Inspect the leftover IAM role

1. IAM → Roles → search `checksops-production-api-execution`.
2. If the role **does not exist**, skip to **B2**.
3. If it **exists**, open Permissions and confirm **all** of the following before you keep it:
   - Trust policy principal is only `lambda.amazonaws.com`.
   - Attached managed policies are only `AWSLambdaVPCAccessExecutionRole` and `AWSXrayWriteOnlyAccess`.
   - Inline policy `ProductionApiLeastPrivilege` allows `secretsmanager:GetSecretValue` **only** on  
     `arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops/1788286468693-b4U0Rn`
   - Same inline policy allows S3 get/put/delete/list **only** on `checksops-staging-privatefilesbucket-erzqsolpucjp`.
   - **No** `checksops/staging/providers`, **no** RDS admin secret, **no** Cognito `Admin*`, **no** SES `*`, **no** Textract unless you later add it in a separate review.
4. Confirm Lambda is **not** using this role yet (Configuration → Permissions on `checksops-production-prep-api` should still show the staging SAM role).

Keep the role only if it matches the reviewed template. Otherwise delete it (it is unused).

### B. Clean the DELETE_FAILED stack

**B1 — role exists and is wrong / incomplete**

1. IAM → Roles → `checksops-production-api-execution` → Delete. Type the name to confirm.
2. CloudFormation → Stacks → `checksops-production-api-role` → Delete.
3. Wait until status is **DELETE_COMPLETE** (the stack disappears from the active list).

**B2 — role does not exist**

1. CloudFormation → Stacks → `checksops-production-api-role` → Delete.
2. Wait for **DELETE_COMPLETE**.

**B3 — role exists and exactly matches the reviewed template**

1. CloudFormation → Stacks → `checksops-production-api-role` → Delete.
2. When prompted about failed resources, **retain** `ProductionApiExecutionRole` (do not delete the good role).
3. Wait for **DELETE_COMPLETE**.
4. Skip section C (do not create a second role with the same `RoleName`). Go to section D.

Do **not** delete `checksops-production-prep-api` (the live API stack). Do **not** delete `checksops-staging`.

### C. Create the dedicated role from the reviewed template

Only if `checksops-production-api-execution` does **not** already exist.

1. CloudFormation → Create stack → **With new resources (standard)**.
2. Upload `aws/production/api-execution-role.yaml` from this repo (do not edit defaults).
3. Stack name: **`checksops-production-api-role`**.
4. Parameters (leave defaults):
   - `RoleName` = `checksops-production-api-execution`
   - `FilesBucketName` = `checksops-staging-privatefilesbucket-erzqsolpucjp`
   - `AppDatabaseSecretArn` = the application DB secret ending in `.../checksops/1788286468693-b4U0Rn`
5. Acknowledge **IAM capabilities** (see section 4).
6. Create stack. Wait for **CREATE_COMPLETE**.
7. Outputs should show `ExecutionRoleArn` = `arn:aws:iam::806168576068:role/checksops-production-api-execution`.

Do not point `AppDatabaseSecretArn` at the RDS admin secret or `checksops/staging/providers`.

### D. Switch only the production Lambda execution role

See section 5. Do **not** redeploy `checksops-production-prep-api` from `api-cfn.yaml`.

### E. Stop and ask for read-only verification

Do not enable money flags. Tell the agent C2 Console steps are done so it can verify read-only.

---

## 2. What must be cleaned up first

| Resource | Action |
|---|---|
| CloudFormation stack `checksops-production-api-role` (**DELETE_FAILED**) | **Must delete first** before recreating the same stack name |
| IAM role `checksops-production-api-execution` (likely present) | Inspect; delete if incomplete; retain only if it matches the template |
| IAM role `checksops-production-prep-api-role` (older leftover) | Do **not** use. Optional later delete. Not the C2 role |
| Stack `checksops-production-prep-api` | **Do not delete or update** |
| Staging API / staging SAM role | **Do not change** |

---

## 3. Exact template and stack name

| Item | Value |
|---|---|
| Template file | `aws/production/api-execution-role.yaml` |
| New / replacement stack name | `checksops-production-api-role` |
| Region | `us-east-1` |
| Role name created by the template | `checksops-production-api-execution` |
| Role ARN | `arn:aws:iam::806168576068:role/checksops-production-api-execution` |

Do not use `aws/production/api-cfn.yaml` or `aws/production/api-template.yaml` for this step.

---

## 4. IAM capability acknowledgement

Because the template sets an explicit `RoleName`, CloudFormation requires **`CAPABILITY_NAMED_IAM`**.

In Console: on the review page, check the box that you acknowledge CloudFormation may create **named IAM resources**.

CLI equivalent (operator workstation only, not the Cloud Agent):

```bash
aws cloudformation create-stack \
  --region us-east-1 \
  --stack-name checksops-production-api-role \
  --template-body file://aws/production/api-execution-role.yaml \
  --capabilities CAPABILITY_NAMED_IAM
```

Use `create-stack` only after the DELETE_FAILED stack is gone and the role name is free. `CAPABILITY_IAM` alone is **not** enough for a named role.

---

## 5. How production Lambda is switched (Console only)

There is **one** production API function: `checksops-production-prep-api`.

Do **not** update CloudFormation stack `checksops-production-prep-api`. That template does not include the live VPC config or live `DATABASE_*` / write flags. A stack update would strip VPC and reset env vars.

**Console**

1. Lambda → Functions → `checksops-production-prep-api` → Configuration → Permissions.
2. Edit execution role → Use an existing role → `checksops-production-api-execution`.
3. Save. Wait until Last update status is **Successful**.
4. Confirm VPC is still `vpc-09f2268778966ce97` and env still has `DATABASE_SECRET_ARN` / `FILES_BUCKET` / `DATABASE_NAME=checksops`.
5. Confirm these stay **false** and **unset**:
   - `AWS_MOOV_ENABLED`, `AWS_CHECKALT_ENABLED`, `AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`, `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` = `false`
   - `PROVIDER_SECRETS_ARN` remains **absent**

Do **not** change `checksops-staging-api`. Staging must keep `checksops-staging-ApiFunctionRole-7E7XRyLe3nyi` and sandbox execution `true`.

A short cold-start / ENI refresh can occur. That is expected. It is not a database change.

---

## 6. How the new role will be proven to lack staging provider access

Staging provider secret ARN (do not open the secret value):

`arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/staging/providers-W1DqaY`

**You (operator), in Console — this is the authoritative deny proof**

1. IAM → Roles → `checksops-production-api-execution` → Permissions: confirm the providers ARN does not appear.
2. IAM → Policy simulator → select that role → action `secretsmanager:GetSecretValue` → resource = the providers ARN above → expect **denied** / implicit deny.
3. Same simulator against the application DB secret ending in `.../checksops/1788286468693-b4U0Rn` → expect **allowed**.

**Agent (read-only, after you say it is done)**

1. `lambda get-function-configuration` on prep vs staging: roles differ; prep role ends with `checksops-production-api-execution`.
2. Prep env still has no `PROVIDER_SECRETS_ARN`; staging still has it.
3. Staging role unchanged; sandbox still `true`.
4. Public `/health`, Cognito auth, RDS reads, non-financial write, tenant isolation, check-image sign.
5. CloudWatch: no new prep-API errors.
6. Money flags still false; `64` still NOT_APPLIED.

The agent cannot `iam:GetRole` today, so it cannot print the role policy. Your Policy Simulator result is the IAM deny proof. The agent will confirm the Lambda is no longer using the staging role that *does* include the providers secret.

---

## Holds

- Do not enable Moov, CheckAlt, provider execution, or financial execution.
- Do not apply `64_financial_activation_grants.sql`.
- Do not broaden the Cloud Agent staging role.
- Do not attach `checksops-production-prep-api-role` to anything.
- Multi-AZ stays OFF unless a later review authorizes it.

**STOP FOR REVIEW until C2 Console work is complete and the agent has re-verified.**
