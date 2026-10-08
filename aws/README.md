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

Authentication reuses an existing authorized staging Cognito session obtained
through the normal staging EMAIL_OTP/passkey sign-in. An authorized environment
maintainer must make that session's short-lived **ID token** available as the
`CHECKSOPS_STAGING_DIAGNOSTIC_ID_TOKEN` staging environment secret through an
approved secure process (never chat, workflow inputs, source, or logs). This is
not an existing provisioned secret assumed by the workflow; if it is unavailable,
stop. Do not create users, reset passwords, bypass MFA, or change Cognito settings
for this diagnostic. Keep the environment restricted to approved branches and
reviewers; remove the short-lived secret after use.

After review/merge, select **Actions → Staging DB read-only diagnostic → Run
workflow → main**, then approve the staging environment job. The script verifies
the token's signature, expiry, ID-token use, and fixed staging pool/client before
one `GET` to the fixed staging `/db-readonly-validate` URL. Missing/invalid/expired
identity, redirects, public-only responses, and unexpected response contracts
fail closed. Signature verification may read the fixed staging pool's public
JWKS. No unauthenticated fallback, refresh/login, or other application API calls
occur.

Logs contain only HTTP status, fixed diagnostic/status classifications, failing
issue kind/severity, allowlisted table/probe labels, and nonnegative integer
assertion counts (row counts, trigger/FK counts; RLS visibility expects zero).
Expected/non-failing issues, raw messages/errors, identities, DB connection
details, token claims/tokens, full catalog/RLS data, and response bodies are never
printed or saved as artifacts. Exit codes: `0` healthy, `1` unhealthy with safe
classifications, `2` diagnostic unavailable/failed. A red diagnostic run does not
authorize repairs or deployment and does not replace or weaken the public smoke.

### Existing in-AWS diagnostic path investigation (#783)

**Decision: private staging AWS execution surfaces are confirmed; legitimate
invocation authority and a hard read-only diagnostic entrypoint/boundary remain
unproven.** No existing safe, Cognito-free diagnostic path is established by the
combined live and repository evidence. This is an investigation-only result, not
authorization to invoke an executor, provision infrastructure, or deploy. No
runtime, workflow, IAM, database, or expected-count changes were made. #777 is
design evidence only; neither its proposed role nor its private runner is an
established prerequisite.

Scope: repository source and workflow definitions, the #777 proposal, and the
owner's fresh live AWS read-only inventory supplied on 2026-10-08 in
[PR #784 comment](https://github.com/michaelcarletta-cmd/ChecksOps/pull/784#issuecomment-6057332177).
That inventory is authoritative for the observed live configuration:

- AWS account: `806168576068`.
- Staging API Lambda: `checksops-staging-api`; runtime: `nodejs22.x`.
- Execution role:
  `arn:aws:iam::806168576068:role/checksops-staging-ApiFunctionRole-7E7XRyLe3nyi`.
- VPC: `vpc-09f2268778966ce97`; subnets: `subnet-0df2518070c5b9ff0`
  and `subnet-092e4e41821fba6c4`; security group: `sg-0fe2698f236959353`.
- Existing staging diagnostic/one-shot Lambdas, including
  `checksops-staging-rehearsal-oneshot` and
  `checksops-staging-guarded-sql-executor`, were also observed in that private VPC.

The reported `/health` and `/db-health` 200 and `/db-readonly-validate` 503 are
issue evidence, not fresh probes by this PR. Existing private execution placement
and the API's reported RDS connectivity are no longer inventory blockers. VPC
placement alone does not prove successful RDS sessions for every one-shot.
The supplied inventory does not establish effective IAM grants, deployed
diagnostic code/version, or an isolated read-only invocation contract. This PR
performed no AWS calls, Lambda invocation, or DB connection.

Reconciled against reviewed source on `main` at
`e753524baa3641d872697c5bc505f5053ce0717b`: the API handler, validator/client
read-only logic, guarded SQL executor, executor bootstrap, and staging workflows
are unchanged from this branch. Main still gates validator details through
Cognito claims and retains the admin-backed SQL executor's apply branch; it
provides no newly proven IAM-only diagnostic path or effective staging role
policies. Main's production inspector changes do not authorize staging reuse.
In the references below, paths are relative to the repository root
`/home/runner/work/ChecksOps/ChecksOps`.

#### Execution surfaces inspected

| Surface and source evidence | Private staging RDS connectivity | Read-only reuse without broadening authority |
| --- | --- | --- |
| `checksops-staging-api`: fresh inventory above; `aws/template.yaml:158-225,292-318`; `aws/functions/api/index.mjs:154-167` | Live private VPC, subnets and SG confirmed above; reported `/db-health` 200 supports existing RDS connectivity. Template defines Lambda-SG-to-RDS-SG TCP 5432 ingress/egress. | Validator uses the application secret, verified RDS TLS, connection default read-only, `BEGIN READ ONLY`, savepoints and rollback (`db-health.mjs:68-82`, `db-readonly-validate.mjs:97-129` and its cleanup). However, the handler returns detailed validation only after `resolveClaims`; an IAM invoke does not supply a legitimate Cognito identity. No dedicated IAM diagnostic entrypoint is established. Do not fabricate authorizer claims or change `index.mjs`/repaired modules. |
| Temporary `/inspect/tmp-rls-catalog`: `aws/functions/api/tenant-maintenance-payments-catalog-inspect.mjs` | Runs within the same API Lambda, not a separate execution surface. | Fixed catalog checks for one table, with identity gating via `withIdentity`; not equivalent to the core validator and not a Cognito-free entrypoint. Do not widen it. |
| `checksops-staging-guarded-sql-executor`: fresh inventory above; `scripts/deployment-guard/sql-executor-ensure.mjs:80-129`; `aws/write-path/guarded-sql-executor/index.mjs:147-185,477-666` | Live existence and placement in the private staging VPC confirmed. Creation code copies API VPC configuration; the supplied evidence does not report this executor's exact SG/subnets or a successful DB session. | Admin secret and mutation-capable `apply` branch. Its inspect/verify modes concern pinned migrations/functions, not the core validator; inspect can execute a business RPC and return its result. No session default read-only/`BEGIN READ ONLY` boundary is established. A fixed caller payload or after-the-fact count comparison is not a hard read-only boundary; reject reuse. |
| Legacy `checksops-staging-sql44-2d41` | Named as a protected, forbidden retargeting target in `scripts/deployment-guard/sql-executor-ensure.mjs:21-26`. Current code, VPC and role not established. | No inspected repo-backed core-validation/read-only interface or exact invocation authority; reject reuse, never replace or restore it. |
| `checksops-staging-rehearsal-oneshot`: fresh inventory above; `aws/write-path/scripts/run-parity-schema-rehearsal.mjs:104-175`; `aws/db-copy/rehearsal/oneshot-apply/index.mjs` | Live existence and placement in the private staging VPC confirmed. Provisioning code copies API VPC configuration; exact live SG/subnets and successful DB session are not included in the supplied evidence. | Admin-secret executor supports database creation/drop, restore/data changes and schema applies. Some inspect steps do not make the executor read-only; bootstrap scripts also update IAM/code/config before inspection. Reject invocation and bootstrap. |
| RLS, identity, write-path and workflows one-shots: `aws/rls/oneshot/index.mjs`, `aws/identity/oneshot/index.mjs`, `aws/write-path/oneshot/index.mjs`, `aws/workflows/oneshot/index.mjs` | Fresh inventory confirms additional staging diagnostic/one-shot Lambdas in the private VPC but does not enumerate them by source package. These clients target staging RDS using the admin secret; no per-package live mapping or DB-session result is supplied. | Grant/DDL/RLS, identity linking, write probes and cleanup branches exist; outputs can include rows, identities or raw errors. Rolled-back writes still violate this task. None establishes an isolated core-validation read-only interface. Reject reuse. |
| Restore one-shot: `aws/db-copy/POST_RESTORE_CLEANUP.md:5-11` | Historical private-RDS executor; cleanup records Lambda and role deleted. | Not an existing reusable surface. Do not recreate historical infrastructure. |
| Step Functions, ECS and SSM | No staging DB diagnostic state machine, task, or SSM document/authorized target found in inspected repo infrastructure/workflows/scripts. `docs/AWS_DB_COPY_RUNBOOK.md:138` mentions bastion/SSM/VPC as network prerequisites, not provisioned diagnostics. | No repo-backed safe execution or permission evidence; do not assume account-wide absence or invent a target. |
| Existing GitHub diagnostics/inspectors | Hosted `ubuntu-latest` jobs are not evidence of private RDS access. SPA and Lambda package inspection use AWS control-plane reads, not DB execution. | Cognito diagnostic requires token handoff; SPA inspect only reads S3; overlay/reconciliation inspect downloads Lambda source without executing the validator. Production inspector is separately production-pinned and out of scope; never retarget it. |

The application role is **not assumed to be globally read-only**: the current
template enables application write flags (`aws/template.yaml:114-129`), and
historical SELECT-only grant/validation reports are not current privilege proof.
The validator's fixed-query, read-only session/transaction boundary is the
relevant mechanism. `/db-health` passing proves neither the validator's catalog,
RLS, privilege and expected-count assertions nor its diagnostic authorization.

#### Exact IAM/OIDC evidence and gaps

- API execution role: fresh inventory identifies
  `arn:aws:iam::806168576068:role/checksops-staging-ApiFunctionRole-7E7XRyLe3nyi`;
  identifying the role does not prove its effective permissions.
  `aws/template.yaml:309-318` declares SAM
  `S3ReadPolicy` and `S3WritePolicy` on `PrivateFilesBucket`, `VPCAccessPolicy`,
  and `AWSSecretsManagerGetSecretValuePolicy` on both `ProviderSecrets` and
  `DatabaseSecretArn`. The application secret parameter is
  `arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops/1788286468693-b4U0Rn`
  (`aws/template.yaml:24-27`), not the admin secret. These are execution-role
  policy templates, not GitHub invocation authority or a captured effective
  IAM policy. Expanded/live policies, boundaries and SCPs are not established.
- SPA OIDC role:
  `arn:aws:iam::806168576068:role/ChecksOpsGitHubStagingSpaInspect`.
  `.github/workflows/inspect-staging-spa.yml:6-8,25-52` requires reviewed
  `main`, exact checkout SHA and staging identity; its inline session policy
  allows **only** `s3:GetObject` on
  `arn:aws:s3:::checksops-staging-frontend-c48b/index.html`.
  It grants neither `lambda:InvokeFunction` nor `secretsmanager:GetSecretValue`.
- Overlay/reconciliation OIDC role:
  `arn:aws:iam::806168576068:role/ChecksOpsGitHubStagingLambdaOverlay`
  (`.github/workflows/guarded-staging-lambda-overlay.yml:92-118`,
  `.github/workflows/sh2-staging-source-reconciliation.yml:50-72`).
  Inspect code requests `lambda:GetFunction` on
  `arn:aws:lambda:us-east-1:806168576068:function:checksops-staging-api`
  (`scripts/deployment-guard/github-staging-lambda-overlay.mjs:100-132`).
  Apply workflow also requests `kms:GetPublicKey` and uses the receipt-gated
  overlay writer. These are operations requested by code, **not** proof of the
  role's exact grants. No checked-in base/trust policy establishes diagnostic
  `lambda:InvokeFunction`, app-secret access, or permission to assume another role.
- Both staging AWS workflows use GitHub `id-token: write` and the pinned
  configure-credentials action for STS web-identity authentication. This does
  not itself grant AWS permissions. Live trust policies (including exact
  `aud`/`sub` conditions), attached/inline policies and effective restrictions
  are not captured here. A future authorized policy review must verify
  `sts:AssumeRoleWithWebIdentity`, audience `sts.amazonaws.com`, and staging
  subject `repo:michaelcarletta-cmd/ChecksOps:environment:staging`; these are
  required conditions to verify, not asserted existing conditions. Protected
  environment reviewer/branch settings also require verification.
- Rehearsal role provisioning declares Lambda service trust
  (`sts:AssumeRole`, principal `lambda.amazonaws.com`),
  `AWSLambdaVPCAccessExecutionRole`, `secretsmanager:GetSecretValue` on the
  selected admin secret, and `s3:GetObject`, `s3:PutObject`, `s3:ListBucket`
  on the staging private-files bucket and its `Migration/*` prefix
  (`aws/write-path/scripts/run-parity-schema-rehearsal.mjs:104-137`).
  The guarded executor defaults to that role (`sql-executor-ensure.mjs:84-94`).
  Neither is a GitHub diagnostic-role grant or a read-only DB boundary.
- Current Cognito diagnostic has only GitHub `contents: read`, no AWS OIDC
  session (`.github/workflows/staging-db-readonly-diagnostic.yml:6-7,41-44`).
  Cursor web-identity bootstrap in rehearsal scripts is not existing GitHub
  staging authorization. Production roles/inspector permissions are excluded.

#### Minimum prerequisite and smallest next design

**Stop here: do not re-request the already supplied private-VPC inventory or
provision a network workaround.** The remaining prerequisites are:

1. Proven legitimate invocation authority: authorized, sanitized evidence of the
   staging caller's effective `lambda:InvokeFunction` permission on an exact safe
   target/version, OIDC trust, resource policy where applicable, boundaries and
   relevant denies. The API execution role and private VPC placement do not grant
   a GitHub caller this authority.
2. A proven hard read-only diagnostic entrypoint/boundary: accepted deployed
   source/version evidence for a fixed validator or equivalent checks using the
   application role, verified TLS, read-only connection/transaction enforcement,
   no mutation/provider dispatch, and allowlisted output. The repository proves
   read-only validator logic, not a Cognito-free, isolated invocation contract;
   the observed admin executors do not supply that boundary.

Obtain only the missing evidence through an authorized read-only inspection.
Do not publish environment values, secret contents, presigned package URLs,
raw function results or DB errors. The source-only follow-up design below does
not claim that either live prerequisite is established or authorize invocation.

If such an entrypoint exists, the smallest subsequent reviewed PR is a manual
`main` workflow with protected staging approval, exact-SHA checks before OIDC,
a short-lived session restricted to that entrypoint, fixed invocation payload,
and allowlisted diagnostic classifications only. Pin an immutable version and
verify accepted live composition/configuration before and after execution; stop
on drift (`DEPLOYMENT_COLLISION`). Do not use arbitrary SQL, fake Cognito claims,
admin executors, provider actions, credentials in GitHub, or raw response artifacts.
Preserve Release Locks and Deployment Guard; a diagnostic grants no apply receipt.

The confirmed API environment is the smallest reuse candidate for private
execution; the inspected handler cannot provide this path unchanged. A
separately authorized, reviewed forward-composed AWS read-only entrypoint and
narrowly scoped invocation access remain prerequisites. Do not modify the
repaired API handler composition during diagnosis. Confirmed existing private
API placement and reported RDS connectivity mean a private GitHub runner is not
inherently required for in-AWS execution. Do not extend/merge #777 or provision
a workaround on the present evidence.

#### Source-only fixed Lambda follow-up

This source adds a separate `checksops-staging-db-readonly-diagnostic` Lambda
resource and handler; it does not deploy or provision it. It calls only the
fixed `validateReadonlyCoreTables()` implementation, ignores the invocation
payload, uses the staging application DB secret, and has no provider/business
dispatch imports or API route. Its execution role is limited in the template to
VPC access and `secretsmanager:GetSecretValue` for `DatabaseSecretArn`; inherited
provider/Cognito secret environment values are blanked. The shared DB client
verifies RDS TLS, sets `default_transaction_read_only=on`, and starts
`BEGIN READ ONLY`; the validator always rolls back and closes the connection.
Results are reconstructed from fixed check/table labels, status classifications,
booleans, and validated nonnegative integer counts. Raw errors, identities,
rows, and unrecognized fields are discarded.

The manual workflow fails closed unless the staging environment supplies both
`CHECKSOPS_STAGING_DB_DIAGNOSTIC_ROLE_ARN` with the exact dedicated role ARN
`arn:aws:iam::806168576068:role/ChecksOpsGitHubStagingDbReadonlyDiagnostic` and
`CHECKSOPS_STAGING_DB_DIAGNOSTIC_VERSION_ARN` with the exact published-version
ARN matching
`arn:aws:lambda:us-east-1:806168576068:function:checksops-staging-db-readonly-diagnostic:<numeric-version>`.
It verifies `main` and the checked-out `GITHUB_SHA` before OIDC, uses the
protected `staging` GitHub environment, supplies an STS session policy allowing
only `lambda:InvokeFunction` on that exact version ARN, invokes with a fixed
empty payload, and checks Lambda's `ExecutedVersion` before reporting output.
There are no workflow inputs, Cognito tokens, arbitrary SQL, artifacts, or AWS
deployment actions.

Before enabling invocation, an owner must establish outside this PR that the
dedicated role exists; its GitHub OIDC trust is restricted to
`aud=sts.amazonaws.com` and
`sub=repo:michaelcarletta-cmd/ChecksOps:environment:staging`; its effective
permissions, boundaries, resource policies, and denies permit only
`lambda:InvokeFunction` on the configured published diagnostic version; and
the `staging` environment requires approved reviewers and limits deployments to
`main`. The numeric version must be published from reviewed source and
independently matched to the reviewed code/configuration before being set.
These are not proven by this repository or configured by this change. The
diagnostic function's own execution role must separately have only the staging
application-secret read and required VPC execution access, with no provider,
database-write, deployment, or other secret permissions. Do not create/change
these AWS roles or policies under this PR. Any later resource deployment must
use the existing Release Locks and Deployment Guard authorization process; this
read-only workflow creates no lease, receipt, or deployment authority.

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
