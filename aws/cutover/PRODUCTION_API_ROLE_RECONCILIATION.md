# Production API execution-role IaC reconciliation

**STOP. Do not deploy. Do not execute a CloudFormation change set.
Do not mutate the live role.**

Authoritative live IAM snapshot is now in hand for
`checksops-production-api-execution` in account `806168576068`.
This revision removes TOTP wrap-key and general provider-secret grants
that the previous candidate incorrectly inferred from Lambda env.

Verdict: **SAFE TO CREATE CHANGE SET** after human review of this report.
**NOT SAFE TO EXECUTE** the change set from this agent.

---

## Authoritative live baseline

Trust: `lambda.amazonaws.com` / `sts:AssumeRole` only.

Attached managed policies exactly:

- `arn:aws:iam::aws:policy/AWSXrayWriteOnlyAccess`
- `arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole`

Tags exactly: `HardeningBatch=1`, `Environment=production`,
`DoNotGrantProviderSecrets=true`.

Inline policies exactly five. No others.

| Policy | Live statements |
|---|---|
| `OcrAzureProductionAccess` | `GetSecretValue` on `.../azure-document-intelligence-*`; `textract:AnalyzeDocument` + `textract:DetectDocumentText` on `*` |
| `ProductionApiLeastPrivilege` | `GetSecretValue` on **staging** RDS secret; S3 object/bucket actions on **staging** private-files bucket |
| `ProductionApiSesSend` | `ses:SendEmail` on `identity/checksops.com` and `identity/Support@checksops.com` |
| `RecipientBankVerifyStateLeastPrivilege` | `GetItem`/`PutItem`/`UpdateItem`/`DescribeTable` on `checksops-recipient-bank-verify-state` |
| `TenantInviteUserProductionCognito` | `AdminCreateUser`/`AdminGetUser`/`AdminSetUserPassword` on `us-east-1_h00WorYMT` |

Live `ProductionApiLeastPrivilege` has **only those two statements**.
No TOTP, provider-secret, Moov, or CheckAlt statements exist on the role.

Working production Lambda env still points at the production RDS secret
`.../checksops-production/checksops/1790081257144-A2Z4bw` and bucket
`checksops-production-privatefiles-806168576068`. That is the known
resource-level defect this candidate corrects.

---

## A. Revised candidate SHA

Recorded after the revision commit on
`cursor/production-iam-reconciliation-0ebf`.

---

## B. Exact CloudFormation / IaC diff

Relative to `main` / the deployed stack template:

1. Parameter defaults `AppDatabaseSecretArn` and `FilesBucketName` change
   from the staging ARNs to the production ARNs above.
2. `AllowedPattern` rejects staging RDS/S3 values.
3. Four live isolated policies are added so CloudFormation will manage
   them instead of deleting them on a later update:
   `ProductionApiSesSend`, `RecipientBankVerifyStateLeastPrivilege`,
   `OcrAzureProductionAccess`, `TenantInviteUserProductionCognito`.
4. RoleName, logical ID `ProductionApiExecutionRole`, Lambda trust,
   two managed policies, and the three live tags are unchanged.

Relative to the previous (incorrect) candidate on this branch:

1. Removed parameter `FinancialTotpWrapKeyArn`.
2. Removed parameter `ProductionProviderSecretArn`.
3. Removed Sid `FinancialTotpWrapKeyRead`.
4. Removed Sid `ProductionProviderSecretRead`.
5. `ProductionApiLeastPrivilege` is again exactly two statements.

---

## C. Live-vs-candidate IAM comparison

| Item | Live | Candidate | Match |
|---|---|---|---|
| RoleName | `checksops-production-api-execution` | same | Yes |
| Logical ID | `ProductionApiExecutionRole` | same | Yes |
| Trust | Lambda / `sts:AssumeRole` | same | Yes |
| Managed policies | X-Ray + Lambda VPC | same | Yes |
| Tags | three live tags | same | Yes |
| Inline policy names | five named above | same five | Yes |
| OCR | Azure DI `-*` + two Textract actions on `*` | same | Yes |
| SES | `SendEmail` on the two identities | same | Yes |
| DynamoDB | four actions on the one table | same | Yes |
| Cognito | three actions on `us-east-1_h00WorYMT` | same | Yes |
| Least-privilege actions | `GetSecretValue` + eight S3 actions | same | Yes |
| Least-privilege RDS resource | staging secret | **production** secret | Intentional correction |
| Least-privilege S3 resources | staging bucket + `/*` | **production** bucket + `/*` | Intentional correction |
| TOTP wrap-key | absent | absent | Yes |
| General provider secret | absent | absent | Yes |
| Moov / CheckAlt | absent | absent | Yes |

---

## D. Every live action is preserved

- `secretsmanager:GetSecretValue` (least-privilege + OCR Azure DI)
- eight live S3 actions
- `ses:SendEmail`
- four live DynamoDB actions
- `textract:AnalyzeDocument`, `textract:DetectDocumentText`
- `cognito-idp:AdminCreateUser`, `AdminGetUser`, `AdminSetUserPassword`

No live action is dropped.

---

## E. Only staging RDS/S3 resources are corrected

The only resource replacements are:

- staging RDS secret `.../checksops-staging/checksops/1788286468693-b4U0Rn`
  → production `.../checksops-production/checksops/1790081257144-A2Z4bw`
- staging bucket `checksops-staging-privatefilesbucket-erzqsolpucjp`
  → `checksops-production-privatefiles-806168576068` and `/*`

All other resources stay exactly as live.

---

## F. No new privilege is introduced

The candidate does **not** add:

- TOTP wrap-key `GetSecretValue`
- `checksops/production/provider-*` / `provider-At4ZFR`
- Moov webhook or CheckAlt statements
- `ses:SendRawEmail`
- extra Cognito admin actions or `cognito-idp:*`
- extra Textract APIs
- extra DynamoDB actions
- RDS admin secret

If production TOTP or general provider-secret access is later required,
that is a separate demonstrated IAM workstream.

---

## G. Tests

`node --test aws/tests/production-api-execution-role.test.mjs aws/tests/email-layout.test.mjs`

Required assertions:

- no staging RDS ARN
- no staging S3 ARN
- production RDS secret exact
- production S3 bucket exact
- all five inline policies represented
- Cognito actions exactly three
- Cognito pool exact
- SES unchanged
- DynamoDB unchanged
- OCR unchanged
- Lambda trust unchanged
- attached managed policies unchanged
- no TOTP permission added
- no general provider-secret permission added
- no Moov/CheckAlt permission added
- no wildcard Cognito permission

---

## H. CloudFormation validation

`ChecksOpsCursorCloudStaging` is denied `cloudformation:ValidateTemplate`
and must not create a change set. Local structural checks: staging
secret/bucket strings absent; RoleName and logical ID unchanged.

A privileged operator should run:

```bash
aws cloudformation validate-template \
  --region us-east-1 \
  --template-body file://aws/production/api-execution-role.yaml
```

---

## I. Exact production parameter values required

The live stack still stores staging parameter values. Any update **must**
override them. `AllowedPattern` rejects the stored staging values.

```
RoleName=checksops-production-api-execution
AppDatabaseSecretArn=arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-production/checksops/1790081257144-A2Z4bw
FilesBucketName=checksops-production-privatefiles-806168576068
ProductionUserPoolArn=arn:aws:cognito-idp:us-east-1:806168576068:userpool/us-east-1_h00WorYMT
AzureDiSecretArn=arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/providers/azure-document-intelligence-*
RecipientBankVerifyStateTableArn=arn:aws:dynamodb:us-east-1:806168576068:table/checksops-recipient-bank-verify-state
```

Capabilities: `CAPABILITY_NAMED_IAM`.
Stack: `checksops-production-api-role`.

---

## J. Proposed non-executed change-set command

Do **not** run this from the staging Cursor role. Privileged operator only.
Do **not** execute the change set after create.

```bash
aws cloudformation create-change-set \
  --region us-east-1 \
  --stack-name checksops-production-api-role \
  --change-set-name iam-recon-prod-rds-s3-do-not-execute \
  --change-set-type UPDATE \
  --capabilities CAPABILITY_NAMED_IAM \
  --template-body file://aws/production/api-execution-role.yaml \
  --parameters \
    ParameterKey=RoleName,ParameterValue=checksops-production-api-execution \
    ParameterKey=AppDatabaseSecretArn,ParameterValue=arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-production/checksops/1790081257144-A2Z4bw \
    ParameterKey=FilesBucketName,ParameterValue=checksops-production-privatefiles-806168576068 \
    ParameterKey=ProductionUserPoolArn,ParameterValue=arn:aws:cognito-idp:us-east-1:806168576068:userpool/us-east-1_h00WorYMT \
    ParameterKey=AzureDiSecretArn,ParameterValue=arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/providers/azure-document-intelligence-* \
    ParameterKey=RecipientBankVerifyStateTableArn,ParameterValue=arn:aws:dynamodb:us-east-1:806168576068:table/checksops-recipient-bank-verify-state

aws cloudformation describe-change-set \
  --region us-east-1 \
  --stack-name checksops-production-api-role \
  --change-set-name iam-recon-prod-rds-s3-do-not-execute

# Confirm Replacement=False on ProductionApiExecutionRole.
# Do not: aws cloudformation execute-change-set ...
```

Expected change: **Modify** `ProductionApiExecutionRole`,
**Replacement=False**.

---

## K. Rollback using the authoritative live snapshot

If a reviewed execute later goes wrong, do **not** roll the stack back to
the 2026-09-06 template (that would drop the four isolated policies).

Privileged operator restores the five live documents exactly:

1. `OcrAzureProductionAccess` — Azure DI `-*` + two Textract actions on `*`
2. `ProductionApiLeastPrivilege` — staging RDS secret + staging bucket
   (the pre-change live document) **or**, if the production-resource
   correction should stay, keep the candidate least-privilege document
   and only restore the other four
3. `ProductionApiSesSend` — `ses:SendEmail` on the two identities
4. `RecipientBankVerifyStateLeastPrivilege` — four DynamoDB actions
5. `TenantInviteUserProductionCognito` — three Cognito actions on the
   production pool

Use `iam:PutRolePolicy` per policy name. Do not change RoleName or trust.
Do not recreate the role.

Companion JSON in this repo:

- `aws/production/ocr-azure-production-access.json`
- `aws/production/production-api-ses-send.json`
- `aws/production/bank-verify-state-lambda-policy.json`
- `aws/production/tenant-invite-user-production-cognito.json`

The pre-change least-privilege document is the live snapshot (staging
RDS/S3). Keep that snapshot offline with the privileged capture; it is
intentionally not the candidate default.

---

## L. Verdict

**SAFE TO CREATE CHANGE SET** after review of this revised candidate.

**NOT SAFE TO EXECUTE** the change set from this agent. Do not mutate AWS
in this step.

Replacement risk remains **no role replacement** if RoleName and logical
ID stay unchanged.
