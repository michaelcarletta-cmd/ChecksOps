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

### Authenticated staging validation diagnostic

The manual **Staging DB read-only diagnostic** workflow is restricted to reviewed
`main` and the protected GitHub `staging` environment. It does not assume an AWS
role, deploy, or change runtime/configuration/database state.

**Currently blocked: no approved non-interactive staging authentication mechanism
was found in the repository.** No existing secret or identity is reused.
The workflow no longer reads `CHECKSOPS_STAGING_DIAGNOSTIC_ID_TOKEN`, and the CLI
ignores that environment variable even if a leftover secret exists. Do not
extract tokens with developer tools, supply credentials in GitHub inputs/comments
or chat, or maintain a short-lived token secret. An environment administrator may
remove the retired secret through approved secret management; removal is not a
prerequisite to safely dispatch this workflow.

Investigation evidence:

- `aws/functions/api/auth-cognito.mjs` and
  `aws/tests/staging-passwordless-only.test.mjs` enforce EMAIL_OTP/passkey sign-in;
  password and master/UAT password routes are retired. EMAIL_OTP needs a human
  challenge response; passkeys need browser/user interaction. GitHub environment
  approval does not itself establish a Cognito session.
- `aws/identity/COGNITO_ONBOARD_RESULTS.md` records the historical probe disabled
  and its mapping cleared; `COGNITO_LOGIN_RESULTS.md` records rejected probe
  authentication. Do not re-enable it. The older
  `aws/identity/STAGING_MASTER_OWNER_UAT.md` password-secret instructions are not
  approval to revive password login or automate a master account.
- The staging overlay workflow uses GitHub OIDC for a **deployment** role, not a
  Cognito diagnostic identity. Do not reuse that role, DB secrets, or stored
  refresh tokens. Refresh tokens would introduce persistent bearer credentials.
- The diagnostic retains `environment: staging`, main-only/SHA checks, and
  `contents: read`. Live environment reviewer/branch rules and secret **names**
  could not be inspected in the issue sandbox because GitHub metadata credentials
  were unavailable. An administrator must verify those settings; no live secret
  availability is assumed, and no secret values were read.

**Smallest secure setup prerequisite (separate reviewed authorization, not
implemented or provisioned here):** the staging identity/security owner must
approve a non-interactive token acquisition mechanism that preserves current
Cognito/MFA/passkey policy and issues a short-lived **ID token** for the existing
staging pool `us-east-1_vPmQ7cL1F` and client `71bb7a192cbl6o6s8m259tl589`.
An OAuth client-credentials access token, GitHub OIDC token, or AWS STS credential
is not a substitute accepted by the existing diagnostic contract. Any protected
identity service must have a documented way to obtain that Cognito ID token
without storing a human session/refresh token, resetting passwords, or bypassing
authentication. If that cannot be demonstrated, remain blocked.

For a future GitHub OIDC-based acquisition service, require exact repository and
`staging` environment trust, verified reviewed-main workflow identity and commit,
short lifetime, replay protection, and a diagnostic-only operation with no
production, deployment, DB-write, provider, or financial authority. Verify required
environment reviewers and main-only deployment branch rules. Keep the token only
in runner memory; never put it in outputs, artifacts, files, or logs. Add reviewed
acquisition/rejection/redaction tests before enabling the workflow. Any new
identity, trust policy, service, or runtime/configuration change requires a
separate review and authorization; this PR authorizes none.

**Phone-only run steps (after review/merge):**

1. In an iPhone browser, open the repository's **Actions** tab (request the desktop
   website if GitHub hides workflow controls).
2. Select **Staging DB read-only diagnostic → Run workflow → main → Run workflow**.
   There are no credential or token inputs.
3. Open the run and use **Review deployments → staging → Approve and deploy**
   as an authorized environment reviewer. That GitHub button releases the job;
   this workflow does not deploy. If controls are hidden, request the desktop
   website. Do not bypass reviewers or branch restrictions.
4. Read the run summary: **Staging diagnostic blocked: secure authentication setup
   required**. The diagnostic exits `2` with `staging_identity_unavailable`
   before any JWKS or application request. This is an authentication setup blocker,
   **not** a database-health result. No further phone credential handling is needed.

The diagnostic library retains signature, expiry, ID-token-use, and fixed
staging pool/client verification before one `GET` to the fixed staging
`/db-readonly-validate` URL when an approved caller supplies an identity.
Missing/invalid/expired identity, redirects, public-only responses, and unexpected
response contracts still fail closed. No unauthenticated fallback, automated
login/refresh, or other application API calls were added.

Logs contain only HTTP status, fixed diagnostic/status classifications, failing
issue kind/severity, allowlisted table/probe labels, and nonnegative integer
assertion counts (row counts, trigger/FK counts; RLS visibility expects zero).
Expected/non-failing issues, raw messages/errors, identities, DB connection
details, token claims/tokens, full catalog/RLS data, and response bodies are never
printed or saved as artifacts. Exit codes: `0` healthy, `1` unhealthy with safe
classifications, `2` diagnostic unavailable/failed. A red diagnostic run does not
authorize repairs or deployment and does not replace or weaken the public smoke.

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
