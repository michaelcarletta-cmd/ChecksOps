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

**Current status: blocked on secure authentication setup.** No approved
non-interactive staging Cognito identity mechanism was found in the repository.
No pre-existing protected secret or identity is reused. The workflow no longer
reads `CHECKSOPS_STAGING_DIAGNOSTIC_ID_TOKEN`, and the CLI ignores that environment
variable and credential arguments. Do not extract a browser token, supply
credentials in GitHub inputs/comments/chat, or manage a short-lived token secret.
An environment administrator may remove the obsolete secret if it was created.

Investigation findings:

- `aws/functions/api/auth-cognito.mjs` and
  `aws/tests/staging-passwordless-only.test.mjs` enforce EMAIL_OTP/passkey login
  and retire password/master-UAT login. EMAIL_OTP needs mailbox interaction;
  WebAuthn needs the approved staging browser origin and user presence. Neither
  is an unattended GitHub runner identity.
- `aws/identity/expected-mappings.mjs` lists test/probe identities, not an approved
  credential provisioning mechanism. Historical password smoke scripts and the
  template's password auth flows do not authorize reactivating password login.
  Refresh tokens would introduce a reusable bearer credential and are not used.
- `guarded-staging-lambda-overlay.yml` uses GitHub OIDC for a deployment IAM role.
  That role is not a Cognito user session; neither it nor DB/provider secrets may
  be repurposed here. Cognito client-credentials access tokens are not ID tokens
  and cannot satisfy this diagnostic's existing contract.
- The diagnostic retains `environment: staging`, reviewed-`main`/exact-SHA checks,
  and `contents: read` only. Live reviewer/branch settings and secret-name
  inventory could not be inspected from the agent environment (no GitHub CLI
  credentials); repository references are not proof of live secret availability.

Smallest secure setup prerequisite (separate owner/security review; **not
provisioned or authorized by this change**):

1. An environment administrator verifies required staging reviewers and approved
   branch restrictions, and confirms whether an already-approved short-lived
   identity issuer exists. Do not inspect or publish secret values.
2. If none exists, a separately reviewed staging-only identity issuance mechanism
   is needed. A credential broker using GitHub OIDC is one possible design, not
   an existing capability: it must validate issuer, dedicated audience, repository,
   protected `staging` environment, reviewed `main`, exact approved workflow/SHA,
   and run identity; reject replays and unapproved jobs; and have no production,
   deployment, DB-write, or provider authority.
3. The issuer must have an explicitly approved way to obtain a short-lived
   **Cognito ID token** for the fixed staging pool/client without disabling or
   bypassing EMAIL_OTP, MFA, or passkeys. GitHub OIDC/STS alone cannot mint that
   token. If this cannot be provided, remain blocked; adding a password, refresh
   token, API key, or hand-written bearer secret is not a solution.
4. A follow-up reviewed workflow integration must obtain that identity only after
   staging approval, keep credentials in memory (never outputs, logs, caches, or
   artifacts), verify signature/expiry/ID-token use and fixed pool/client, then
   make exactly one GET to the existing staging diagnostic endpoint. Do not
   change the endpoint's authentication/public-smoke contract. No runtime/config
   deployment or identity/DB change is part of this PR.

Phone-only steps after this PR is reviewed and merged:

1. In GitHub's mobile web UI (Safari on iPhone), open this repository → **Actions**
   → **Staging DB read-only diagnostic** → **Run workflow**; select **main** and
   dispatch. There are no credential inputs.
2. Open the run → **Review deployments** → select **staging** → **Approve and
   deploy** (GitHub's button label; this job does not deploy). Required reviewers
   must approve under the existing environment policy.
3. Read the run's summary. Until the secure setup above is approved and integrated,
   it reports **authentication setup required** and exits `2` before contacting
   Cognito or the diagnostic API. This is not DB-health evidence. Stop; do not
   work around it with token extraction. Successful phone-only DB diagnosis is
   not yet available.

The read-only diagnostic/verifier remains covered offline: signed, unexpired
staging ID tokens are required before its fixed GET; redirects, public-only
responses, and unexpected contracts fail closed. No unauthenticated fallback,
automated login/refresh, or other application API calls were added.

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
