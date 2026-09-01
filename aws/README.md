# ChecksOps AWS staging

This directory contains the AWS migration infrastructure for ChecksOps.

## Safety

The staging stack does not change the current Supabase/Lovable production application. It creates parallel AWS services.

Do not commit AWS credentials, RDS passwords, Moov credentials, CheckAlt credentials, Plaid credentials, Resend credentials, or cross-app secrets.

## What the first stack creates

- HTTP API Gateway
- `checksops-staging-api` Lambda
- private/versioned S3 file bucket
- Cognito staging user pool and web client
- Secrets Manager provider secret container
- CloudWatch/X-Ray support through Lambda tracing/logging

The existing manually-created `checksops-staging` RDS instance is intentionally not declared in this template yet. We will connect/import it only after its networking and database parameters are verified.

## Deploy from Cursor terminal

Prerequisites:

1. AWS CLI installed and authenticated to the ChecksOps AWS account.
2. AWS SAM CLI installed.
3. Region set to `us-east-1`.
4. Work from Git branch `aws-migration`.

Validate:

```bash
cd aws
sam validate --lint
sam build
```

Preview/deploy staging:

```bash
sam deploy --config-env staging
```

SAM will show a CloudFormation change set. Review it before approving deployment.

After deployment, record the CloudFormation outputs (API URL, S3 bucket name, Cognito IDs). These identifiers are configuration values, not passwords.

## First verification

Call the API `/health` endpoint. It should return a JSON response showing `status: ok` and `database: not-connected`.

Do not point the production frontend at this API yet.

## Next migration step

Staging PostgreSQL connectivity is confirmed. Database copy tooling is in `aws/db-copy/` with the runbook in `docs/AWS_DB_COPY_RUNBOOK.md`.

Do not export or restore yet. Validate offline:

```bash
node aws/db-copy/cli.mjs validate
node --test aws/db-copy/tests/db-copy-offline.test.mjs
```

After an approved copy and reconciliation:

1. add read-only `/v1/tenants` and `/v1/checks` API routes
2. reconcile AWS results against Supabase

Only after read parity is proven do we begin moving writes or provider webhooks.
