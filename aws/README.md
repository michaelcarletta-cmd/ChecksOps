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

Staging Lambda points at restored database `checksops` via env `DATABASE_NAME=checksops` while still using the application role secret (`checksops`, not `checksops_admin`). Public `GET /db-health` returns only `service` and `status`; public `GET /db-readonly-validate` also returns `readOnly`. Both must return HTTP 200 and `status: ok`; validation must report `readOnly: true`. Database identity, counts, catalog, and error details are restricted to authenticated diagnostics and must not be published.

The guarded staging Lambda overlay workflow runs this same strict public smoke in `inspect` mode without applying an overlay. Its diagnostics log only HTTP status, a fixed status classification (`ok`, `unhealthy`, `missing`, or `unexpected`), JSON-object shape, and whether the response uses only permitted public fields—not response bodies. HTTP 200 with a missing/unexpected status is a response-contract mismatch, not proof of a database outage or of database health. Compare the inspected live `index.mjs` hash with the reviewed source and use authorized, read-only authenticated diagnostics to distinguish stale live code from database failures. Do not rerun a landed overlay to collect smoke evidence, weaken the smoke, or deploy from this runbook; any later repair requires separate reviewed Deployment Guard authorization.

For the current validation failure, manually dispatch **Staging DB read-only diagnostic** (`.github/workflows/staging-db-readonly-diagnostic.yml`) from `main` and approve the existing protected `staging` environment as required. It has no target or apply inputs and obtains no AWS credentials. Authentication uses only the environment secret `CHECKSOPS_STAGING_DIAGNOSTIC_REFRESH_TOKEN`, holding an explicitly authorized existing staging Cognito session's refresh token (pool `us-east-1_vPmQ7cL1F`, client `71bb7a192cbl6o6s8m259tl589`). No automated diagnostic credential was found in the existing workflows: this secret must already be available through an authorized environment-secret process, or the diagnostic stops with `staging_identity_unavailable`. Never paste credentials into chat, dispatch inputs, logs, or repository files; do not reset passwords, create users, change Cognito configuration, or bypass environment protections to run it.

The job calls the existing staging `POST /auth/refresh` (session renewal only, no DB writes), checks the returned ID token's staging issuer/client/type/expiry, then makes one authenticated `GET /db-readonly-validate`; the API performs JWT signature verification. Redirects are refused. Missing, expired, rejected, wrong-scope identities and public-only/malformed responses fail closed without a public fallback. Output is a strict allowlist: HTTP status, fixed health/read-only classifications, error-only issue kind/severity, known table/probe labels, failed table-check labels, and non-negative integer expected/actual counts for restore counts, RLS fail-closed rows, triggers, or auth-users FKs. Unknown labels become `unknown`. Messages, SQL, identity values, tokens, credentials, raw catalog/privilege data, and response bodies are never printed or uploaded. An unhealthy result deliberately exits nonzero after printing these safe classifications; the public smoke and validation contract remain unchanged. This workflow performs no deployments, mutations, provider actions, or production requests, and does not repair the failure.

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
