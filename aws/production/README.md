# Production-prep AWS resources

**This directory prepares production Cognito client, frontend hosting, and a separate API stack.**  
It does **not** switch production auth, DNS, webhooks, or flags.

Live staging SAM `aws/template.yaml` still allows **`Environment=staging` only**.

## Live leftover Cognito pool (do not recreate)

A failed first `checksops-production-prep` deploy **retained** pool:

| Item | Value |
|---|---|
| Name | `checksops-production` |
| Id | `us-east-1_h00WorYMT` |
| Users | **0** (do not invite / import) |
| First-auth factors | EMAIL_OTP, PASSWORD, WEB_AUTHN |
| MFA | OFF |
| Deletion protection | ACTIVE |
| Email | `COGNITO_DEFAULT` (SES From still outstanding; agent SES APIs denied) |
| WebAuthn RP ID | `checksops.com` (set; staging remains `staging.checksops.com`) |

Staging pool `us-east-1_vPmQ7cL1F` **must not** be reused. `prep-stack.yaml` takes `ExistingUserPoolId` (default `us-east-1_h00WorYMT`) and only creates the `checksops-production-web` client.

## Stacks

| Stack | Template | What it creates | DNS / auth |
|---|---|---|---|
| `checksops-production-prep` | `prep-stack.yaml` | Cognito **client** on existing pool, frontend bucket, CloudFront **without** apex/www aliases, API log group | Unchanged |
| `checksops-production-prep-api` | `api-cfn.yaml` (live) / `api-template.yaml` (SAM) | Flags-off Lambda + HTTP API using existing staging execution role, **no VPC** | Unchanged. URL `https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep` |

Leftover OAC name `checksops-production-frontend-oac` exists outside CloudFormation. This stack uses `checksops-production-frontend-oac-prep2`.

## Operator deploy (after review — not cutover)

```bash
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name checksops-production-prep \
  --template-file aws/production/prep-stack.yaml

# After client id exists (pool must remain us-east-1_h00WorYMT).
# Live stack still uses ExistingExecutionRoleArn (staging SAM role) until
# aws/production/api-execution-role.yaml is deployed by an IAM-capable operator.
# Do not deploy aws/production/api-template.yaml from this agent (it still creates an IAM role).
aws cloudformation deploy \
  --stack-name checksops-production-prep-api \
  --template-file aws/production/api-cfn.yaml \
  --parameter-overrides \
    CognitoClientId=3ja9fqaq2fjkv3i6up2varcqpe \
    CodeS3Bucket=checksops-production-prep-artifacts-806168576068 \
    CodeS3Key=checksops-production-prep-api.zip \
    ExistingExecutionRoleArn=arn:aws:iam::806168576068:role/checksops-staging-ApiFunctionRole-7E7XRyLe3nyi \
    EnableErrorsAlarm=false
```

WebAuthn RP ID `checksops.com` is **already set** on `us-east-1_h00WorYMT` (`SetUserPoolMfaConfig`, MFA OFF). Staging `us-east-1_vPmQ7cL1F` stays `staging.checksops.com`. Do not invite users.

The prep API is deployed at `https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep`. Live execution still uses the staging SAM role until an IAM-capable operator deploys `api-execution-role.yaml` and switches the function. Do **not** overlay `checksops-staging-api`.

Dedicated production role (operator / IAM-capable principal only):

```bash
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name checksops-production-api-role \
  --template-file aws/production/api-execution-role.yaml \
  --capabilities CAPABILITY_NAMED_IAM

node aws/cutover/scripts/assume-and-run.mjs \
  aws/cutover/scripts/hardening-batch1-iam.mjs --confirm-prod-role
```

## ACM (checksops.com + www)

See `ACM_DNS_VALIDATION.md`. Cert is `PENDING_VALIDATION`. **Do not add Cloudflare records from this agent.** CloudFront aliases for apex/www wait until the cert is `ISSUED` **and** a cutover decision.

## Frontend deploy target

Build with `.env.production.aws.example` values filled privately (not committed). Upload to the production-prep bucket. Do **not** copy over `.env.production`. Do **not** change `checksops.com` DNS.

## Safety

Keep false: `AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_MOOV_ENABLED`, `AWS_CHECKALT_ENABLED`, `AWS_PLAID_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`, `AWS_COGNITO_MFA_PREFERRED`.

Do not apply `64_financial_activation_grants.sql`.
