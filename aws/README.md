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

Do not point the production frontend at this API yet.

### AWS-authenticated staging validation inspector

Use **Inspect staging DB validation (AWS read-only)**, not the legacy Cognito
token diagnostic. No user token, password handoff, login, refresh, or Cognito
change is required. The new workflow is manual, reviewed-`main` only, exact-SHA
checked before AWS authentication, and protected by the `staging` environment.
It does not deploy or change Lambda composition, configuration, or database state.

Authentication follows the existing pinned GitHub OIDC action pattern in
`inspect-staging-spa.yml`: GitHub OIDC → STS `AssumeRoleWithWebIdentity` →
`ChecksOpsGitHubStagingDbInspect` (900-second session). The script verifies the
fixed account, role, and run-specific session using `sts:GetCallerIdentity`,
reads exactly one staging application secret into memory, rejects any other
host/user/port/database, then connects over verified RDS TLS as `checksops` to
database `checksops`. The secret's historical `dbname=postgres` is not changed;
the connection uses the same `checksops` database override as the staging API.
Neither secret values nor AWS responses are logged or written to disk.

**Infrastructure prerequisite remains; nothing is provisioned by this PR.**
Repository evidence does not establish a GitHub role with DB-secret access or
a private-network diagnostic runner. The SPA role permits only one S3 object;
the overlay role is not a least-privilege DB diagnostic role. Existing VPC SQL
executors are migration-bound and are not a general validation entry point.
Do not broaden those roles, invoke mutation executors, open public DB ingress,
or deploy a diagnostic Lambda to work around this blocker.

Owner approval must separately authorize:

- A dedicated role `arn:aws:iam::806168576068:role/ChecksOpsGitHubStagingDbInspect`,
  using the existing GitHub OIDC provider. Its trust allows only
  `sts:AssumeRoleWithWebIdentity` with `StringEquals` conditions
  `token.actions.githubusercontent.com:aud = sts.amazonaws.com` and
  `token.actions.githubusercontent.com:sub =
  repo:michaelcarletta-cmd/ChecksOps:environment:staging`.
  Preserve staging required reviewers, prevent self-review, and restrict that
  environment to protected `main`. The environment OIDC subject itself does not
  encode a branch, so those rules and the workflow's SHA/main checks are required.
- Only `secretsmanager:GetSecretValue` on
  `arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops/1788286468693-b4U0Rn`.
  Verify that recorded ARN against owner inventory before enabling. No wildcard,
  admin/production/provider secrets, Lambda invoke/deploy, IAM, RDS management,
  SSM, or S3 permissions. `GetCallerIdentity` needs no permission grant.
  The inline session policy restricts the session to the same one-secret read.
  If the secret uses a customer-managed KMS key, stop: a separately reviewed
  exact-key `kms:Decrypt`, restricted by `kms:ViaService =
  secretsmanager.us-east-1.amazonaws.com` and encryption context `SecretARN`
  matching the above ARN, must also be included in both role and session policy.
  This PR does not grant or assume that permission.
- An isolated, ephemeral staging-only runner labeled
  `self-hosted, linux, x64, checksops-staging-db-readonly`, restricted by runner
  group to this workflow on reviewed main (never PR/untrusted jobs). It needs
  Node 22, npm, AWS CLI, GitHub/STS/Secrets Manager connectivity and existing
  private TLS access to `checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com:5432`.
  No instance profile, ambient AWS credentials, production connectivity, shared
  workspace/cache, or retained logs/dumps. If existing approved private access
  is unavailable, networking/runner approval is a separate prerequisite; this
  workflow must not mutate security groups or runtime infrastructure.
- Only after approval and verification, repository variables
  `CHECKSOPS_STAGING_DB_INSPECT_ROLE_ARN` (the exact role above) and
  `CHECKSOPS_STAGING_DB_INSPECT_READY=true`. Missing/mismatched prerequisites
  fail on a hosted preflight job before allocating the private runner.

Read-only operations reuse `validateReadonlyCoreTables` unchanged from reviewed
source, not the Lambda handler: default transaction read-only, `BEGIN READ ONLY`,
database/user identity, core-table existence and `count(*)`, table/schema/function
privileges, RLS flags, restore-sentinel existence, auth.users catalog existence,
FK/trigger counts, function dependency aggregate counts, `auth.uid()`, and
role/table/policy RLS catalog reads. Catalog probes use savepoints; cleanup is
`ROLLBACK` and disconnect. No arbitrary SQL or identity inputs, row retrieval,
writes, DDL, migrations, grants, security-setting changes, or provider actions.
These results diagnose reviewed-source validation and do not attest that live
Lambda source is identical; the existing read-only composition inspection is
separate. Expected counts and DB security settings remain unchanged.

Logs and the run summary contain only `status` (`ok`, `unhealthy`, or
`inspection_failed`), fixed failure `classification` when unavailable, and failing
`issues`: allowlisted `kind`, `severity=error`, `probe`, optional core-table `table`,
and nonnegative integer `expectedCount`/`actualCount` for count, zero-visibility,
trigger, or FK assertions. Probe labels identify database/application-role,
table presence/query/count, SELECT/write privileges, FORCE/RLS enablement or
visibility, public/storage schema usage, sentinel, auth catalog/FKs/uid,
triggers/functions, or an unclassified failure. No raw errors, SQL result bodies,
rows, identities, credential fields, tokens, PII, claim/check data, function
definitions, or full catalog/RLS matrices are emitted; no artifacts are uploaded.
Exit codes: `0` healthy, `1` unhealthy with safe classifications, `2` inspection
unavailable/failed. A red run never authorizes repairs or weakens public validation.

**Phone-only steps (after separate review/merge and prerequisite approval):**
In GitHub mobile's repository Actions view (or the phone browser if the app does
not expose dispatch), select **Inspect staging DB validation (AWS read-only) →
Run workflow → main → Run workflow**. Open the run, verify its exact reviewed
commit SHA, then **Review deployments → staging → Approve and deploy** (GitHub's
button label; this job does not deploy). An authorized required reviewer must
approve. Read the run summary's safe JSON classifications. Do not supply tokens
or credentials, rerun a deployment, change counts, or repair DB settings.

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
