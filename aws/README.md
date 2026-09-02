# ChecksOps AWS staging

This directory contains the AWS migration infrastructure for ChecksOps.

## Safety

The staging stack does not change the current Supabase/Lovable production application. It creates parallel AWS services.

Do not commit AWS credentials, RDS passwords, Moov credentials, CheckAlt credentials, Plaid credentials, Resend credentials, or cross-app secrets.

Do not paste those values into chat. Store them in AWS Secrets Manager or your password manager only.

## What the stack creates

- HTTP API Gateway
- `checksops-staging-api` Lambda (`nodejs22.x`, arm64) in the existing RDS VPC
- dedicated Lambda security group with no inbound rules
- TCP 5432 ingress on the existing RDS security group `rds-ec2-1`, sourced only from that Lambda SG
- Secrets Manager interface VPC endpoint and S3 gateway VPC endpoint
- private/versioned S3 file bucket
- Cognito staging user pool and web client
- Secrets Manager provider secret container
- CloudWatch/X-Ray support through Lambda tracing/logging

The existing `checksops-staging` RDS instance is not declared in this template. The stack does not create, replace, reboot, resize, delete, or import it.

Lambda receives `DATABASE_SECRET_ARN` pointing at the application `checksops` secret. It does not receive a database password. Do not point `DATABASE_SECRET_ARN` at the `checksops_admin` secret.

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

The staging deployment role needs extra EC2 permissions beyond the first stack: create/delete security groups, authorize/revoke ingress and egress, create/delete VPC endpoints, and create tags. It still must not have `rds:Create*`, `rds:Modify*`, `rds:Delete*`, or `rds:Reboot*`.

After deployment, record the CloudFormation outputs (API URL, S3 bucket name, Cognito IDs, Lambda security group, VPC endpoint IDs). These identifiers are configuration values, not passwords.

## First verification

Call the API `/health` endpoint. It should return JSON with `status: ok` and `databaseSecretConfigured: true`.

Call `/db-health` for a read-only `SELECT 1` over TLS. It must not return passwords.

Staging Lambda points at restored database `checksops` via env `DATABASE_NAME=checksops` while still using the application role secret (`checksops`, not `checksops_admin`). Verify `GET /db-health` reports `currentDatabase=checksops` and `currentUser=checksops`, then `GET /db-readonly-validate` for core-table SELECT counts. Do not SAM-deploy this template over the live stack; update the existing `checksops-staging-api` function in place.

Do not point the production frontend at this API yet.

## Next migration step

Staging PostgreSQL connectivity is confirmed. Database copy tooling is in `aws/db-copy/` with the runbook in `docs/AWS_DB_COPY_RUNBOOK.md`.

After this private-network update is deployed and `/health` still succeeds, restore a copy of the live ChecksOps PostgreSQL database to the existing RDS instance.

Validate offline first:

```bash
node aws/db-copy/cli.mjs validate
node --test aws/db-copy/tests/db-copy-offline.test.mjs
```

After an approved copy and reconciliation:

1. add read-only `/v1/tenants` and `/v1/checks` API routes that open a Postgres connection using the application secret
2. reconcile AWS results against Supabase

Only after read parity is proven do we begin moving writes or provider webhooks.
