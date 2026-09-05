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
| Email | `COGNITO_DEFAULT` (SES From still outstanding) |
| WebAuthn RP ID | not set on the pool yet (CLI `UpdateUserPool` in this account’s AWS CLI has no `WebAuthnConfiguration` member) |

Staging pool `us-east-1_vPmQ7cL1F` **must not** be reused. `prep-stack.yaml` takes `ExistingUserPoolId` (default `us-east-1_h00WorYMT`) and only creates the `checksops-production-web` client.

## Stacks

| Stack | Template | What it creates | DNS / auth |
|---|---|---|---|
| `checksops-production-prep` | `prep-stack.yaml` | Cognito **client** on existing pool, frontend bucket, CloudFront **without** apex/www aliases, API log group | Unchanged |
| `checksops-production-prep-api` | `api-template.yaml` (SAM) or `api-cfn.yaml` (vanilla CFN) | Separate Lambda/HTTP API, flags **false** | Unchanged. **Not deployed from this agent** — IAM `GetRole`/`CreateRole` denied. |

Leftover OAC name `checksops-production-frontend-oac` exists outside CloudFormation. This stack uses `checksops-production-frontend-oac-prep2`.

## Operator deploy (after review — not cutover)

```bash
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name checksops-production-prep \
  --template-file aws/production/prep-stack.yaml

# After client id exists (pool must remain us-east-1_h00WorYMT).
# Requires IAM to create the Lambda role (this Cloud Agent role cannot).
sam deploy \
  --template-file aws/production/api-template.yaml \
  --stack-name checksops-production-prep-api \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides CognitoUserPoolId=us-east-1_h00WorYMT CognitoClientId=3ja9fqaq2fjkv3i6up2varcqpe

# Or vanilla CFN (no SAM CLI):
aws cloudformation deploy \
  --stack-name checksops-production-prep-api \
  --template-file aws/production/api-cfn.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    CognitoClientId=3ja9fqaq2fjkv3i6up2varcqpe \
    CodeS3Bucket=checksops-production-prep-artifacts-806168576068 \
    CodeS3Key=checksops-production-prep-api.zip
```

A previous agent create of `checksops-production-prep-api` failed on `iam:GetRole`. The CloudFormation stack was deleted with `--retain-resources ProductionPrepRole`. If `checksops-production-prep-api-role` exists, delete or import it before redeploying.

Do **not** overlay `checksops-staging-api`. Do **not** `AdminCreateUser` on the production pool.

WebAuthn RP ID `checksops.com` must be set on **`us-east-1_h00WorYMT` only** (console or a CLI that supports `WebAuthnConfiguration`). Never run that against `us-east-1_vPmQ7cL1F`. Preserve existing `SignInPolicy` / MFA / deletion protection when using `UpdateUserPool` (omitted fields reset to defaults).

## ACM (checksops.com + www)

See `ACM_DNS_VALIDATION.md`. Cert is `PENDING_VALIDATION`. **Do not add Cloudflare records from this agent.** CloudFront aliases for apex/www wait until the cert is `ISSUED` **and** a cutover decision.

## Frontend deploy target

Build with `.env.production.aws.example` values filled privately (not committed). Upload to the production-prep bucket. Do **not** copy over `.env.production`. Do **not** change `checksops.com` DNS.

## Safety

Keep false: `AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_MOOV_ENABLED`, `AWS_CHECKALT_ENABLED`, `AWS_PLAID_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`, `AWS_COGNITO_MFA_PREFERRED`.

Do not apply `64_financial_activation_grants.sql`.
