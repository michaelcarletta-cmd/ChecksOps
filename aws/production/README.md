# Production-prep AWS resources

**This directory prepares production Cognito, frontend hosting, CloudWatch alarms, and a separate API stack.**  
It does **not** switch production auth, DNS, webhooks, provider execution, financial grants, or bridges.

Live staging SAM `aws/template.yaml` still allows **`Environment=staging` only**. Do not overlay `checksops-staging-api`.

Draft PR #132 created the live Cognito client, frontend bucket, and CloudFront distribution. This follow-on pass validates those objects, records ACM CNAMEs, checks SES, and prepares inspect-only alarms.

## Safety

Keep false: `AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_MOOV_ENABLED`, `AWS_CHECKALT_ENABLED`, `AWS_PLAID_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`, `AWS_COGNITO_MFA_PREFERRED`.

Do not apply `64_financial_activation_grants.sql`.

## Docs in this directory

| File | Purpose |
|---|---|
| `ACM_DNS_VALIDATION.md` | Exact ACM CNAMEs. **Do not add them from the agent.** |
| `COGNITO_VALIDATION.md` | Live pool/client snapshot. No import. |
| `SES_EMAIL_OTP_READINESS.md` | Production pool is SES `DEVELOPER` / `support@checksops.com`; staging still `COGNITO_DEFAULT` |
| `SES_OTP_PROOF.md` | **6A** sandbox vs production console check; **6B** isolated OTP explained, not run |
| `iam/OPERATOR_LAMBDA_ROLE.md` | **Step 4** — dedicated prep Lambda role (**verified**; CFN param aligned) |
| `LIVE_RESOURCES.md` | IDs of prepared objects |
| `iam/OPERATOR_CLOUDWATCH_IAM.md` | **Step 5** — inspect policy + disabled alarms |

## Stacks

| Stack | Template | What it creates | DNS / auth |
|---|---|---|---|
| `checksops-production-prep` | `prep-stack.yaml` | Cognito **client** on existing pool, frontend bucket, CloudFront **without** apex/www aliases, API log group | Unchanged |
| `checksops-production-prep-alarms` | `cloudwatch-alarms.yaml` | Inspect-only alarms (`ActionsEnabled=false`) | Unchanged |
| `checksops-production-prep-cw-inspect-policy` | `iam/operator-cloudwatch-inspect.yaml` | Managed policy only (not attached) | Unchanged |
| `checksops-production-prep-api` | `api-template.yaml` (SAM) or `api-cfn.yaml` (vanilla CFN) | Separate Lambda/HTTP API, flags **false** | Unchanged. **Live 2026-09-05T23:09Z:** stack `UPDATE_COMPLETE`, `/prep/health` 200, no VPC. Lambda role and `ExistingExecutionRoleArn` are `checksops-production-prep-api-role`. `EnableErrorsAlarm=false`. Do **not** CloudFormation-deploy git `api-cfn.yaml` (that would create a second role). |

## Operator deploy (after review — not cutover)

```bash
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name checksops-production-prep-alarms \
  --template-file aws/production/cloudwatch-alarms.yaml

# Policy only — still must attach to the operator role:
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name checksops-production-prep-cw-inspect-policy \
  --template-file aws/production/iam/operator-cloudwatch-inspect.yaml \
  --capabilities CAPABILITY_NAMED_IAM

# API (requires IAM to create/get the Lambda role). Flags stay false.
aws cloudformation deploy \
  --stack-name checksops-production-prep-api \
  --template-file aws/production/api-cfn.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    CognitoClientId=3ja9fqaq2fjkv3i6up2varcqpe \
    CodeS3Bucket=checksops-production-prep-artifacts-806168576068 \
    CodeS3Key=checksops-production-prep-api.zip
```

If leftover `checksops-production-prep-api-role` exists, inspect it in **Step 4** (`iam/OPERATOR_LAMBDA_ROLE.md`) and reuse it when it is basic-execution + X-Ray only. Do **not** `AdminCreateUser` on the production pool.

## Frontend

Build with `.env.production.aws.example` values filled privately. Upload to `checksops-production-frontend-806168576068`. Do **not** copy over `.env.production`. Do **not** change `checksops.com` DNS. Live CloudFront already serves a placeholder that states DNS is not switched.

## Validation script

```bash
node aws/production/scripts/validate-production-prep.mjs
# --live uses AWS (read-only). --apply is refused.
```
