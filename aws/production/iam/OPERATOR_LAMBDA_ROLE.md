# Step 4 — Dedicated production-prep Lambda IAM role

**Verified 2026-09-05T22:56Z:** Lambda `checksops-production-prep-api` execution role is `arn:aws:iam::806168576068:role/checksops-production-prep-api-role`. `/prep/health` 200, `VpcConfig` null, all provider/financial execution flags `false`. Staging Lambda still uses `checksops-staging-ApiFunctionRole-7E7XRyLe3nyi` with its VPC. CloudFormation parameter `ExistingExecutionRoleArn` still points at the staging role — finish that in **Step 5A** so the next stack update does not revert the role.

**Operator only.** This Cloud Agent cannot `iam:CreateRole` / `iam:GetRole` / `iam:PassRole` on a new role. Do **not** overlay staging. Do **not** attach VPC. Do **not** enable provider/financial flags. Do **not** point `checksops.com` DNS at this API.

## Why

Before Step 4, live Lambda `checksops-production-prep-api` used the **staging** execution role via CloudFormation `ExistingExecutionRoleArn`:

`arn:aws:iam::806168576068:role/checksops-staging-ApiFunctionRole-7E7XRyLe3nyi`

That staging role has VPC, RDS secret, S3, and provider permissions that this prep API must not share. The function itself has **no VPC** and all execution flags **false**. Step 4 isolates the IAM role only.

Git template `aws/production/api-cfn.yaml` already defines a dedicated `ProductionPrepRole` (basic execution + X-Ray). **Do not deploy that template in this step** — it would create a second role and replace the live PassRole template. Use the console path below against the **existing** stack.

## Do not touch

| Leave unchanged | Id |
|---|---|
| Staging Lambda | `checksops-staging-api` |
| Staging IAM role | `checksops-staging-ApiFunctionRole-7E7XRyLe3nyi` |
| Staging Cognito | `us-east-1_vPmQ7cL1F` |
| Production Cognito | `us-east-1_h00WorYMT` (already SES `DEVELOPER`) |
| Production DNS | apex/`www` A = `185.158.133.1` |
| ACM / CloudFront aliases | not attached; aliases quantity 0 |
| Lambda env flags | all execution flags stay `"false"` |
| `EnableErrorsAlarm` | stay `false` (Step 5) |

## A. Check leftover role (required first)

1. AWS Console → **IAM** → **Roles**.
2. Search `checksops-production-prep-api-role`.
3. Branch:

**If the role does not exist:** continue to section B.

**If it exists:** open it.

- Trust policy principal must be `lambda.amazonaws.com` only.
- Permissions must be **only**:
  - `AWSLambdaBasicExecutionRole`
  - `AWSXRayDaemonWriteAccess`
- Must **not** have `AWSLambdaVPCAccessExecutionRole`.
- Must **not** have staging inline policies (secrets, S3 write, Textract, Moov, RDS).
- Tags should include `Environment=production-prep` and `DoNotCutover=true`.

If the leftover role matches that, **reuse it** and skip section B. If it has extra policies, detach/delete those policies (do not copy staging). If it is broken (wrong trust, or attached to something else), delete it only when no Lambda lists it as the execution role, then continue to section B.

## B. Create the dedicated role (skip if reusing leftover)

1. IAM → **Roles** → **Create role**.
2. **Trusted entity type:** AWS service.
3. **Use case:** Lambda. Next.
4. Attach **only** these AWS managed policies:
   - `AWSLambdaBasicExecutionRole`
   - `AWSXRayDaemonWriteAccess`
5. Do **not** attach `AWSLambdaVPCAccessExecutionRole`.
6. Do **not** attach any `checksops-staging-*` customer managed or inline policies.
7. Role name: `checksops-production-prep-api-role` (exact).
8. Description: `Production-prep API. No VPC, no RDS, no provider secrets. Not cutover.`
9. Tags: `Environment=production-prep`, `DoNotCutover=true`.
10. **Create role**.

Expected ARN:

`arn:aws:iam::806168576068:role/checksops-production-prep-api-role`

## C. Point the prep Lambda at the new role

1. Lambda → Functions → **`checksops-production-prep-api`**.
   - Stop if the name is `checksops-staging-api`.
2. **Configuration** → **Permissions** → Execution role → **Edit**.
3. Choose `checksops-production-prep-api-role`.
4. Save.
5. Stay on **Configuration**:
   - **VPC** must still show not assigned / no subnets.
   - **Environment variables** must still have every `AWS_*_ENABLED` / `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` / `AWS_COGNITO_MFA_PREFERRED` value `false` (webhook dry-run may stay `true`).
   - `CHECKSOPS_ENV` must stay `production-prep`.
   - `COGNITO_USER_POOL_ID` must stay `us-east-1_h00WorYMT`.

## D. Align CloudFormation so the next stack update does not revert the role

1. CloudFormation → Stacks → **`checksops-production-prep-api`**.
2. **Update** → **Use existing template** (do **not** upload `api-cfn.yaml` yet).
3. Change **only** parameter `ExistingExecutionRoleArn` to:

   `arn:aws:iam::806168576068:role/checksops-production-prep-api-role`

4. Keep:
   - `Environment=production-prep`
   - `CognitoUserPoolId=us-east-1_h00WorYMT`
   - `CognitoClientId=3ja9fqaq2fjkv3i6up2varcqpe`
   - `EnableErrorsAlarm=false`
   - Code bucket/key unchanged
5. Review changeset: Lambda `Role` property only. No VPC. No new alarms. No staging stack.
6. Execute update. Wait for `UPDATE_COMPLETE`.

## E. What to send back (so this agent can verify)

Reply with:

1. Screenshot or text of IAM role `checksops-production-prep-api-role` permissions (the two managed policies only).
2. Lambda **Permissions** showing that execution role ARN (not the staging role).
3. Lambda **VPC** still unassigned.
4. Confirmation you did **not** edit `checksops-staging-api` or pool `us-east-1_vPmQ7cL1F`.

Do not send OTP, import users, attach ACM, or start Step 5 yet.
