# SECURITY HARDENING BATCH 1: FAIL

**Generated:** 2026-09-06T17:47:20Z  
**STOP FOR REVIEW.**

Financial and provider activation remains **NOT AUTHORIZED**. This batch did not enable Moov, CheckAlt, provider execution, financial execution, or `64_financial_activation_grants.sql`.

Live AWS mutations that require `rds:ModifyDBInstance` or IAM role create/update were **denied** on the Cloud Agent staging role. Production customer data was not modified. The production-target RDS instance was not recreated, replaced, renamed, migrated, or deleted. Multi-AZ was **not** enabled.

## Verdict

| Control | Result |
|---|---|
| C1 production RDS deletion protection + 35-day PITR | **PASS** — operator applied; agent read-only verify 2026-09-06T19:35:51Z |
| C2 dedicated production API execution role | **FAIL** — reviewed role stack CREATE_COMPLETE; live prep Lambda uses leftover `checksops-production-prep-api-role`; DB path `503` |
| Application regression after the attempt | **PASS** (no live control change) |
| Financial / provider holds | **PASS** (still OFF / NOT_APPLIED) |

**SECURITY HARDENING BATCH 1: FAIL**

C1 is closed (operator + read-only verify). C2 remains open. Use `SECURITY_HARDENING_C2_OPERATOR.md` (Console / CloudFormation). Do not broaden the Cloud Agent staging role.

## Before / after controls

| Control | Before | After this batch |
|---|---|---|
| RDS identifier | `checksops-staging` | unchanged (not renamed) |
| Publicly accessible | `false` | `false` |
| Storage encrypted | `true` (KMS `ce55869a-433c-42e4-9b9a-3e0cf2c1d4b3`) | `true` (same key) |
| Deletion protection | **OFF** | **ON** (operator; verified 2026-09-06T19:35:51Z) |
| Backup / PITR retention | **1 day** | **35 days** (operator; PITR `LatestRestorableTime` present) |
| Multi-AZ | `false` | `false` (intentionally not enabled) |
| Prep Lambda role | `checksops-staging-ApiFunctionRole-7E7XRyLe3nyi` | same shared role |
| Staging Lambda role | same staging SAM role | unchanged |
| Prep `PROVIDER_SECRETS_ARN` | unset | unset |
| Staging `PROVIDER_SECRETS_ARN` | set | set |
| Staging sandbox execution | `true` | `true` |
| Prep sandbox / money flags | all `false` | all `false` |
| `64_financial_activation_grants.sql` | NOT_APPLIED | NOT_APPLIED |

## Regression / security validation

| Check | Result |
|---|---|
| Public `https://checksops.com` | PASS (200, CloudFront / AmazonS3) |
| Public `https://www.checksops.com` | PASS (200, CloudFront / AmazonS3) |
| Public ChecksOps API `/health` | PASS (200) |
| `/ops/readiness` holds | PASS |
| Cognito authentication | PASS |
| API / RDS reads | PASS (tester 194 intake rows) |
| Non-financial write (`check_message_reads` upsert) | PASS |
| Tenant isolation | PASS (tester vs C1C tenants differ; C1C check rows 0) |
| Historical / current check-image sign | PASS |
| Production RDS private | PASS |
| Production RDS encrypted | PASS |
| Deletion protection ON | **PASS** (operator; re-verified read-only) |
| PITR / backup retention 35 days | **PASS** (operator; re-verified read-only) |
| Production and staging execution roles separated | **FAIL** |
| Production cannot access staging sandbox provider credentials | **PARTIAL** — prep env has no `PROVIDER_SECRETS_ARN`; shared IAM role still allows `secretsmanager:GetSecretValue` on `checksops/staging/providers-W1DqaY` |
| CloudWatch new application errors | PASS (0 ERROR events and 0 Lambda Errors in the last 20 minutes) |
| Moov | OFF |
| CheckAlt | OFF |
| Provider execution | OFF |
| Financial execution | OFF |
| `64_financial_activation_grants.sql` | NOT_APPLIED |

## Multi-AZ (not enabled)

Instance is `db.t4g.micro`, PostgreSQL 18.3, 20 GB gp2, Single-AZ, `us-east-1`.

Expected impact if Multi-AZ were enabled now:

- **Interruption:** converting Single-AZ → Multi-AZ creates a standby from a snapshot and typically causes a brief outage (minutes) while the instance is reconfigured. Not a no-downtime change.
- **Cost:** list pricing is roughly 2× instance hours (`db.t4g.micro` ~$0.016/hr Single-AZ → ~$0.032/hr Multi-AZ, about +$12/month) plus 2× provisioned gp2 storage (20 GB ~$2.30 → ~$4.60/month). Backup/PITR storage above the free allocation is extra.
- **Decision:** **do not enable Multi-AZ in this batch.** Prefer 35-day PITR first, then a reviewed maintenance window if Multi-AZ is required.

## Minimum IAM still required (do not broaden)

### C1 — RDS protection

On the Cloud Agent staging role, add only:

- `rds:ModifyDBInstance`
- `rds:DescribeDBInstances` (already present)

Resource: `arn:aws:rds:us-east-1:806168576068:db:checksops-staging`

Then: `node aws/cutover/scripts/assume-and-run.mjs aws/cutover/scripts/hardening-batch1-rds.mjs --confirm-rds-protection`

Args the script will send: `--deletion-protection --backup-retention-period 35 --no-publicly-accessible --apply-immediately`. No Multi-AZ.

### C2 — dedicated production role

Preferred: an IAM-capable operator deploys `aws/production/api-execution-role.yaml` as stack `checksops-production-api-role` with `CAPABILITY_NAMED_IAM`, then an operator or a scoped agent runs `hardening-batch1-iam.mjs --confirm-prod-role`.

If this Cloud Agent should finish C2, grant only these actions on these resources:

- `iam:CreateRole`, `iam:TagRole`, `iam:GetRole`, `iam:ListAttachedRolePolicies`, `iam:ListRolePolicies`, `iam:GetRolePolicy`, `iam:PutRolePolicy`, `iam:AttachRolePolicy`, `iam:PassRole`
- `lambda:GetFunctionConfiguration`, `lambda:UpdateFunctionConfiguration`

Resources:

- `arn:aws:iam::806168576068:role/checksops-production-api-execution`
- `arn:aws:lambda:us-east-1:806168576068:function:checksops-production-prep-api`

`iam:PassRole` condition: `iam:PassedToService=lambda.amazonaws.com`.

The intended production role grants:

- VPC ENI + CloudWatch Logs (`AWSLambdaVPCAccessExecutionRole`)
- X-Ray write (function tracing is already Active)
- `secretsmanager:GetSecretValue` on the application DB secret only
- S3 get/put/delete/list on `checksops-staging-privatefilesbucket-erzqsolpucjp`

It must **not** grant `checksops/staging/providers`, the RDS admin secret, Cognito admin APIs, SES `*`, or tenant OpenAI secrets.

### Manual snapshots

`rds:CreateDBSnapshot` remains denied. Minimum extra permission if a named snapshot is required:

- `rds:CreateDBSnapshot`
- `rds:DescribeDBSnapshots`

Resources: `arn:aws:rds:us-east-1:806168576068:db:checksops-staging` and `arn:aws:rds:us-east-1:806168576068:snapshot:checksops-*`.

Do not add unrelated RDS/IAM/S3 admin actions.

## Leftover from the denied CFN attempt

This agent attempted `cloudformation deploy` of the role template. Create failed (`iam:GetRole` denied). Rollback/delete then failed (`iam:DeleteRolePolicy` denied).

Live leftover:

- CloudFormation stack `checksops-production-api-role` is **DELETE_FAILED**
- Resource `ProductionApiExecutionRole` could not be deleted
- Prep Lambda was **not** switched to that role

An IAM-capable operator should delete or complete that stack (`iam:GetRole`, `iam:DeleteRole`, `iam:DeleteRolePolicy`, plus CloudFormation delete). The apply script no longer deploys CFN from this agent.

## Remaining concerns (this batch)

1. C1 is closed. Keep Multi-AZ off unless a later review authorizes it.
2. Production API still shares the staging execution role, which can read staging sandbox provider secrets (C2 open). Follow `SECURITY_HARDENING_C2_OPERATOR.md`. Env isolation (`PROVIDER_SECRETS_ARN` unset on prep) is not sufficient.
3. Backup RPO is still 1 day.
4. Multi-AZ remains off (cost/interruption tradeoff above).
5. Failed CFN stack `checksops-production-api-role` needs operator cleanup.
6. Phase 1 items not in this batch remain open: WAF, MFA, CORS, RLS, CloudFront logs, GuardDuty/Security Hub, etc.

## Holds still in force

- Moov OFF
- CheckAlt OFF
- Provider execution OFF
- Financial execution OFF
- `64_financial_activation_grants.sql` NOT_APPLIED
- No WAF / MFA / CORS / RLS changes in this batch

**STOP FOR REVIEW.**
