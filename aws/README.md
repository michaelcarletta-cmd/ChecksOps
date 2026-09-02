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

Staging Lambda points at restored database `checksops` via env `DATABASE_NAME=checksops` while still using the application role secret (`checksops`, not `checksops_admin`). Verify `GET /db-health` reports `currentDatabase=checksops` and `currentUser=checksops`, then `GET /db-readonly-validate` for core-table SELECT counts. Do not SAM-deploy this template over the live stack; update the existing `checksops-staging-api` function in place.

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
