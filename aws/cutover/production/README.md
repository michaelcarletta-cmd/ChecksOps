# Production AWS SAM / Cognito / CloudFront configuration (DO NOT DEPLOY)

**This directory is configuration-only.** Do not `sam deploy` a production stack from this PR. Do not change production DNS, auth, webhooks, Moov, CheckAlt, or Lovable/Supabase.

Live `aws/template.yaml` still allows **`Environment=staging` only**. `aws/samconfig.toml` stays staging-only.

## What this prepares

| Artifact | Purpose |
|---|---|
| `samconfig.production.example.toml` | Future production stack name, region, confirm_changeset |
| `parameters.production.example.json` | Placeholder parameter values (no secrets) |
| `https-cloudfront.production.example.yaml` | Future apex/www CloudFront — **not** the live staging distribution |
| `cloudwatch-alarms.example.yaml` | Future Lambda/API alarms — **not deployed** |

Production frontend env remains `.env.production.aws.example` — **DO NOT USE YET**.

Staging Cognito pool `us-east-1_vPmQ7cL1F` **must not** be reused as production.

## Safety that stays true even if someone later deploys

Copy the live template; keep these strings `"false"`:

- `AWS_PROVIDER_EXECUTION_ENABLED`
- `AWS_MOOV_ENABLED`
- `AWS_CHECKALT_ENABLED`
- `AWS_PLAID_ENABLED`
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`
- `AWS_COGNITO_MFA_PREFERRED`

Do not apply `64_financial_activation_grants.sql`.
