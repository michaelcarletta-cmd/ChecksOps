# Production secret host compare (source-only)

This is a tightly scoped, fail-closed diagnostic for the remaining
two-RDS ambiguity. It is not authorized to run from this pull request.
Do not apply IAM, dispatch the workflow, merge PR #855, or deploy.

## What it proves

When the owner separately authorizes it, the official inspector reads the
live `DATABASE_SECRET_ARN` host field and compares that host to observed
RDS `Endpoint.Address` values in the live Lambda VPC. It returns only:

- `matching_instance_identifier`
- `unique`
- `match_count`
- `compared_instance_count`
- `resource_arn`
- status / reason / required permission

It never persists the secret value, password, username, connection string,
or hostname.

Zero matches, multiple matches, a missing/malformed secret, a privileged
`checksops_admin` username, a missing Lambda VPC, or a conflict with an
already-exclusive network association stay
`refused_unproven_aws_production_target`.

The default inspect workflow is unchanged and still has no
`GetSecretValue` session permission.

## Authorization required before use

All of the following must happen in this order. This repository update
performs none of them.

1. Review this source-only draft. Do not merge as an apply.
2. Owner applies the exact identity-policy statement in
   `ops/deployment-guard/production-secret-host-compare-iam.json` to
   `ChecksOpsGitHubProductionReadOnlyInspect`. Do not grant wildcard
   Secrets Manager access, `GetSecretValue` on any other secret, SSM
   value reads, SQL, Lambda update, or security-group mutation.
3. If `GetSecretValue` then fails with a KMS denial, inspect the secret's
   `KmsKeyId` with metadata-only `DescribeSecret` and add `kms:Decrypt`
   on that CMK only after a separate review. This package does not add
   `kms:Decrypt`.
4. Owner dispatches
   `.github/workflows/inspect-production-secret-host-compare.yml` from
   `main` through the `production-readonly` environment.
5. The workflow input `secret_host_compare_authorization` must equal
   exactly `OWNER_AUTHORIZED_PRODUCTION_SECRET_HOST_COMPARE`. Any other
   value refuses before AWS access.

The inspector also refuses `GetSecretValue` unless
`CHECKSOPS_SECRET_HOST_COMPARE_AUTHORIZATION` equals that same phrase.

## Exact IAM permission

Identity policy to apply later, not from this workstream:

```json
{
  "Effect": "Allow",
  "Action": "secretsmanager:GetSecretValue",
  "Resource": "arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-production/checksops/1790081257144-A2Z4bw"
}
```

Session policy adds the same statement only in the secret-host-compare
workflow. The existing `inspect-production-readonly.yml` session policy
must keep omitting `GetSecretValue`.

## Workflow changes

New file: `.github/workflows/inspect-production-secret-host-compare.yml`

- `workflow_dispatch` only
- `production-readonly` environment
- `main` only
- required authorization input
- same pinned role, account, region, Lambda, API, SPA, and CloudFront
- session policy = current read-only inspect statements plus exact-ARN
  `secretsmanager:GetSecretValue`
- role session name
  `checksops-production-secret-host-compare-${{ github.run_id }}`
- uploads the same redacted evidence JSON, including
  `database.host_compare` when authorized

No SQL, PostgreSQL connection, networking change, Lambda overlay, or
default-inspect behavior change is included.
