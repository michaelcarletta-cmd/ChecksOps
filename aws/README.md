# ChecksOps AWS staging

This directory contains the AWS migration infrastructure for ChecksOps.

## Safety

The staging stack does not change the current Supabase/Lovable production application. It creates parallel AWS services.

Do not commit AWS credentials, RDS passwords, Moov credentials, CheckAlt credentials, Plaid credentials, Resend credentials, or cross-app secrets.

Do not paste those values into chat. Store them in AWS Secrets Manager or your password manager only.

## What the first stack creates

- HTTP API Gateway
- `checksops-staging-api` Lambda (`nodejs22.x`, arm64)
- private/versioned S3 file bucket
- Cognito staging user pool and web client
- Secrets Manager provider secret container
- CloudWatch/X-Ray support through Lambda tracing/logging

The existing manually-created `checksops-staging` RDS instance is intentionally not declared in this template yet. We will connect/import it only after its networking and database parameters are verified.

The `Environment` parameter allows `staging` only. This template will not accept `production`.

## Deploy from Cursor terminal

Prerequisites:

1. AWS CLI installed and authenticated to the ChecksOps AWS account.
2. AWS SAM CLI installed.
3. Region set to `us-east-1`.
4. Work from Git branch `aws-migration` or a review branch based on it.

Validate:

```bash
cd aws
sam validate --config-env staging --lint
sam build --config-env staging
node --test tests/api-health.test.mjs
```

Preview/deploy staging:

```bash
sam deploy --config-env staging
```

SAM will show a CloudFormation change set. Review it before approving deployment. Do not deploy until the intended AWS account and `us-east-1` region are confirmed.

After deployment, record the CloudFormation outputs (API URL, S3 bucket name, Cognito IDs, Secrets Manager ARN). These identifiers are configuration values, not passwords.

Then open the `checksops/staging/providers` secret in Secrets Manager and replace the generated placeholder with provider JSON from your password manager. Do not put those values in this template; CloudFormation would overwrite them on later stack updates.

## First verification

Call the API `/health` endpoint. It should return a JSON response showing `status: ok` and `database: not-connected`.

Do not point the production frontend at this API yet.

## Next migration step

After AWS staging services are deployed:

1. verify RDS VPC/subnets/security group
2. create a database credential secret in Secrets Manager
3. allow only the Lambda security group to reach RDS on TCP 5432
4. attach Lambda to the RDS VPC/subnets
5. restore a copy of the live ChecksOps PostgreSQL database to RDS
6. add read-only `/v1/tenants` and `/v1/checks` API routes
7. reconcile AWS results against Supabase

Only after read parity is proven do we begin moving writes or provider webhooks.
