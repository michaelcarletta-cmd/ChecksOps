# Production API execution-role IaC reconciliation

**STOP. Do not deploy. Do not execute a CloudFormation change set.**

Production tenant onboarding is accepted. This file is the post-acceptance
IaC reconciliation report for `checksops-production-api-execution`.

Verdict: **NOT SAFE TO DEPLOY** until a privileged identity re-reads the live
inline policy documents and confirms no unknown statements would be replaced.

Account `806168576068`. Region `us-east-1`.
Caller used for this run: `ChecksOpsCursorCloudStaging`.
That identity is denied `iam:GetRole` / `iam:GetRolePolicy` /
`iam:ListRolePolicies` on the production execution role.

---

## A. Live role snapshot

Direct IAM capture failed (`AccessDenied` on every `get-role`,
`list-role-policies`, `get-role-policy`, `list-attached-role-policies`,
`list-role-tags` call).

Working production runtime was captured read-only from
`lambda:GetFunctionConfiguration` on `checksops-production-prep-api`
(LastModified `2026-09-24T12:47:01Z`):

| Field | Live value |
|---|---|
| Function | `checksops-production-prep-api` |
| Role | `arn:aws:iam::806168576068:role/checksops-production-api-execution` |
| VPC | `vpc-09f2268778966ce97` |
| `DATABASE_SECRET_ARN` | `arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-production/checksops/1790081257144-A2Z4bw` |
| `FILES_BUCKET` | `checksops-production-privatefiles-806168576068` |
| `COGNITO_USER_POOL_ID` | `us-east-1_h00WorYMT` |
| `AZURE_DI_SECRET_ID` | `checksops/production/providers/azure-document-intelligence` |
| `PROVIDER_SECRETS_ARN` | `arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/provider-At4ZFR` |
| `FINANCIAL_TOTP_WRAP_KEY_ARN` | `arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/financial-totp-wrap-key-81bFID` |
| `AWS_RECIPIENT_BANK_VERIFY_STATE_TABLE` | `checksops-recipient-bank-verify-state` |
| `AWS_EMAIL_MODE` | `ses` |
| `AWS_EMAIL_FROM` | `ChecksOps <support@checksops.com>` |

Known live inline policy names (operator-confirmed after onboarding):

1. `OcrAzureProductionAccess`
2. `ProductionApiLeastPrivilege`
3. `ProductionApiSesSend`
4. `RecipientBankVerifyStateLeastPrivilege`
5. `TenantInviteUserProductionCognito`

Permissions boundary, role tags, and attached managed-policy list could not
be read from IAM. The CloudFormation create event and every subsequent
template revision attach:

- `arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole`
- `arn:aws:iam::aws:policy/AWSXrayWriteOnlyAccess`

Trust policy from the live stack create / every repo revision:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
```

No live evidence of a non-Lambda trust principal.

---

## B. Deployed-template snapshot

Stack: `checksops-production-api-role`  
Stack ID: `arn:aws:cloudformation:us-east-1:806168576068:stack/checksops-production-api-role/dc1a2560-aa2c-11f1-a95c-0e418ccab31f`  
Status: `CREATE_COMPLETE` (created `2026-09-06T19:55:07Z`, **never updated**)  
Capabilities: `CAPABILITY_NAMED_IAM`  
Logical resource: `ProductionApiExecutionRole`  
Role name: `checksops-production-api-execution`

Current stack parameters (this is the known drift):

| Parameter | Stored value |
|---|---|
| `RoleName` | `checksops-production-api-execution` |
| `AppDatabaseSecretArn` | staging RDS secret `.../checksops-staging/checksops/1788286468693-b4U0Rn` |
| `FilesBucketName` | `checksops-staging-privatefilesbucket-erzqsolpucjp` |

Deployed template body is the original Batch 1 role: Lambda trust, the two
managed policies, and **only** inline policy `ProductionApiLeastPrivilege`
with `AppDatabaseSecretRead` + `PrivateCheckImageBucket` pointed at those
staging parameters. It does not contain SES, DynamoDB, OCR, or Cognito.

`checksops-production-prep-api` is a different stack. It still records
`ExistingExecutionRoleArn=checksops-production-prep-api-role`, but the live
Lambda role is `checksops-production-api-execution`. This report does not
change that Lambda stack.

---

## C. Repository-template snapshot (before this change)

`aws/production/api-execution-role.yaml` on `main` matched the deployed
stack defaults: staging RDS secret, staging private-files bucket, only
`ProductionApiLeastPrivilege`, no Cognito / SES / DynamoDB / OCR.

Later unmerged branches recorded production RDS/S3 defaults and a Cognito
Sid **inside** `ProductionApiLeastPrivilege`. The accepted live architecture
keeps Cognito as the isolated policy `TenantInviteUserProductionCognito`.

---

## D. Three-way permission comparison

| Statement / policy | Live? | Deployed CFN? | Repo `main` before? | Candidate IaC? | Production resource? | Staging resource? | Disposition |
|---|---|---|---|---|---|---|---|
| Trust `lambda.amazonaws.com` | Yes (stack + every revision) | Yes | Yes | Yes | n/a | n/a | Keep |
| Managed `AWSLambdaVPCAccessExecutionRole` | Yes (stack) | Yes | Yes | Yes | n/a | n/a | Keep |
| Managed `AWSXrayWriteOnlyAccess` | Yes (stack) | Yes | Yes | Yes | n/a | n/a | Keep |
| `ProductionApiLeastPrivilege` / `AppDatabaseSecretRead` staging RDS | Not used by live Lambda | Yes (stack param) | Yes | No | No | Yes | Remove from candidate |
| `ProductionApiLeastPrivilege` / `AppDatabaseSecretRead` production RDS | Yes (live Lambda `DATABASE_SECRET_ARN`) | No | No | Yes | Yes | No | Represent |
| `ProductionApiLeastPrivilege` / `PrivateCheckImageBucket` staging bucket | Not used by live Lambda | Yes (stack param) | Yes | No | No | Yes | Remove from candidate |
| `ProductionApiLeastPrivilege` / `PrivateCheckImageBucket` production bucket | Yes (live Lambda `FILES_BUCKET`) | No | No | Yes | Yes | No | Represent |
| `ProductionApiLeastPrivilege` / `FinancialTotpWrapKeyRead` | Likely (live env + reviewed grant `553b19414`) | No | No | Yes | Yes | No | Represent; confirm on privileged read |
| `ProductionApiLeastPrivilege` / `ProductionProviderSecretRead` | Likely (live `PROVIDER_SECRETS_ARN`, CheckAlt enabled) | No | No | Yes | Yes | No | Represent exact ARN only; confirm on privileged read |
| `ProductionApiSesSend` / `ses:SendEmail` on `checksops.com` + `Support@checksops.com` | Yes (named live policy + SES freeze 2026-09-23) | No | No | Yes | Yes | No | Represent isolated |
| `RecipientBankVerifyStateLeastPrivilege` four DynamoDB actions on `checksops-recipient-bank-verify-state` | Yes (named live policy + operator template) | No | No | Yes | Yes | No | Represent isolated |
| `OcrAzureProductionAccess` Azure DI GetSecretValue + Textract analyze/detect | Yes (named live policy + operator JSON) | No | No | Yes | Yes | No | Represent isolated |
| `TenantInviteUserProductionCognito` three actions on `us-east-1_h00WorYMT` | Yes (named live isolated policy; operator-applied) | No | No | Yes | Yes | No | Represent isolated; do not fold into least-privilege |
| Unknown extra Sids inside live `ProductionApiLeastPrivilege` | Unknown — IAM read denied | n/a | n/a | No | ? | ? | **STOP** — do not deploy until captured |

---

## E. Staging references removed from candidate IaC

Removed as defaults / allowed values:

- `arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops/1788286468693-b4U0Rn`
- `checksops-staging-privatefilesbucket-erzqsolpucjp`

`AllowedPattern` now rejects any staging RDS secret and any bucket name other
than `checksops-production-privatefiles-806168576068`.

---

## F. Exact production resources represented

| Resource | Identifier |
|---|---|
| RDS app secret | `arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-production/checksops/1790081257144-A2Z4bw` |
| Private-files bucket | `checksops-production-privatefiles-806168576068` |
| Cognito pool | `arn:aws:cognito-idp:us-east-1:806168576068:userpool/us-east-1_h00WorYMT` |
| SES identities | `arn:aws:ses:us-east-1:806168576068:identity/checksops.com`, `.../identity/Support@checksops.com` |
| DynamoDB table | `arn:aws:dynamodb:us-east-1:806168576068:table/checksops-recipient-bank-verify-state` |
| Azure DI secret | `arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/providers/azure-document-intelligence-*` |
| Provider secret | `arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/provider-At4ZFR` |
| Financial TOTP wrap key | `arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/financial-totp-wrap-key-81bFID` |

Admin RDS secret `.../checksops-production/checksops_admin/1790081257144-R3rJpx` is not granted.
Staging providers secret is not granted. Moov webhook secret is not granted
(`AWS_MOOV_ENABLED=false`; purpose of that live env key is not an IAM grant
we can prove).

---

## G. Exact Cognito policy represented

Isolated inline policy `TenantInviteUserProductionCognito`:

```
Effect: Allow
Action:
  - cognito-idp:AdminCreateUser
  - cognito-idp:AdminGetUser
  - cognito-idp:AdminSetUserPassword
Resource: arn:aws:cognito-idp:us-east-1:806168576068:userpool/us-east-1_h00WorYMT
```

No `cognito-idp:*`. No `Resource *`. No staging pool.

---

## H. Policies / statements a future update would add

Relative to the **deployed CloudFormation template** (not the live role):

- Isolated `ProductionApiSesSend`
- Isolated `RecipientBankVerifyStateLeastPrivilege`
- Isolated `OcrAzureProductionAccess`
- Isolated `TenantInviteUserProductionCognito`
- Production RDS + production S3 on `ProductionApiLeastPrivilege`
- `FinancialTotpWrapKeyRead`
- `ProductionProviderSecretRead`

Relative to the **live role**, adds are unknown until `iam:GetRolePolicy`
succeeds. The candidate is intended to **record** the five live policies, not
invent a sixth.

---

## I. Policies / statements a future update would remove

Relative to the **deployed template parameters**:

- Staging RDS secret ARN
- Staging private-files bucket ARN

Relative to the **live role**:

- Would remove any unknown Sid that exists on live
  `ProductionApiLeastPrivilege` and is not enumerated here.
- Would remove staging ARNs if they are still present on the live policy
  document (desired).

---

## J. Policies / statements that would change

- `ProductionApiLeastPrivilege` document would be rewritten from the
  2026-09-06 staging pair to the production statements above.
- CloudFormation would begin managing the four currently out-of-band inline
  policies. That is required so a later stack update cannot delete them.
- Role name, logical ID, trust, and managed policies stay the same.

---

## K. CloudFormation change-set preview

Not created. `ChecksOpsCursorCloudStaging` is the wrong identity to write a
change set against this production IAM stack, and this report must not deploy.

Logical preview for stack `checksops-production-api-role`:

| Action | Resource | Type | Replacement |
|---|---|---|---|
| Modify | `ProductionApiExecutionRole` | `AWS::IAM::Role` | **No** if `RoleName` and logical ID stay `checksops-production-api-execution` / `ProductionApiExecutionRole` |
| Parameter change | `AppDatabaseSecretArn` | parameter | Must be overridden to the production secret; `AllowedPattern` rejects the stored staging value |
| Parameter change | `FilesBucketName` | parameter | Must be overridden to the production bucket |

Required capabilities: `CAPABILITY_NAMED_IAM`.

---

## L. Replacement risk

**IAM role must not be replaced.**

The candidate keeps:

- Stack name `checksops-production-api-role`
- Logical ID `ProductionApiExecutionRole`
- Physical `RoleName` `checksops-production-api-execution`
- Lambda-only trust

CloudFormation replaces `AWS::IAM::Role` when `RoleName` or the logical ID
changes. This candidate changes neither. Inline policy updates on a named
role are in-place updates.

Do not retarget the live Lambda to another role as part of this work.

---

## M. Tests / validation

See the commit that updates `aws/tests/production-api-execution-role.test.mjs`
and `aws/tests/email-layout.test.mjs`. Run:

```bash
node --test aws/tests/production-api-execution-role.test.mjs aws/tests/email-layout.test.mjs
aws cloudformation validate-template --template-body file://aws/production/api-execution-role.yaml
```

---

## N. Rollback plan

If a reviewed stack update is later executed and must be undone:

1. Do **not** roll back to the original 2026-09-06 template. That restores
   staging RDS/S3 and deletes the four live isolated policies.
2. Privileged operator: `iam:PutRolePolicy` the pre-change snapshots of all
   five inline policies.
3. Leave the Lambda role name and trust unchanged.
4. If CloudFormation stack status is `UPDATE_ROLLBACK_*`, inspect the live
   inline policy names before assuming rollback recreated the working set.

Until a privileged pre-change snapshot exists, there is no safe
CloudFormation rollback path. That is one reason this is **NOT SAFE TO DEPLOY**.

---

## O. Candidate git SHA

Recorded after commit on this branch.

---

## P. Verdict

**NOT SAFE TO DEPLOY**

Blockers:

1. Live inline policy documents were not readable from this identity.
2. Live `ProductionApiLeastPrivilege` may contain additional statements
   (CheckAlt/Moov overlays were previously noted). Replacing that document
   from this candidate could delete an unlisted live grant.
3. No privileged change-set was created.
4. The live stack still stores staging parameters; any update must pass
   production overrides or it will fail `AllowedPattern` (fail-closed, not
   a restore of staging).

Safe next operator step, from an identity that can `iam:GetRole` and
`iam:GetRolePolicy` on `checksops-production-api-execution`:

```bash
aws iam get-role --role-name checksops-production-api-execution
aws iam list-role-policies --role-name checksops-production-api-execution
aws iam list-attached-role-policies --role-name checksops-production-api-execution
# then get-role-policy for each name
```

Compare those documents to this candidate. Only then create — and review —
a change set. Do not execute it from this agent.
