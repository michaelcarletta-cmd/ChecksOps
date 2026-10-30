# Production secret host compare (source-only)

> **Withdrawn 2026-10-29 (finding 12).** The diagnostic ran once (run 38067130648, 2026-10-10).
> The `GetSecretValue` grant on `ChecksOpsGitHubProductionReadOnlyInspect` is removed by
> `ops/deployment-guard/production-readonly-inspect-role/`; this workflow is refused at
> `GetSecretValue` until the statement below is re-granted on the owner's approval of a run,
> and withdrawn again afterwards.

This is a tightly scoped, fail-closed diagnostic for the remaining
two-RDS ambiguity. It is not authorized to run from this pull request.
Do not apply IAM, dispatch the workflow, merge PR #855, or deploy.

## What it proves

When the owner separately authorizes it, the official inspector reads the
live `DATABASE_SECRET_ARN` host field and compares that host to observed
RDS `Endpoint.Address` values in the live Lambda VPC. `database.host_compare` returns only:

- `status`
- `reason`
- `match_count`
- `unique_match`
- `matched_rds_identifier` when exactly one endpoint matches; otherwise null

The field is named `host_compare` so the existing report redactor, which
suppresses keys matching `/secret/`, does not replace the result. The
redactor is unchanged.

It never persists the secret value, password, username, connection string,
or hostname. GetSecretValue is not called unless the owner phrase is
present **and** the live package proves `secrets.mjs` (exact path or
flattened root SHA-256 match).

Zero matches, multiple matches, unverified package provenance, a
missing/malformed secret, a privileged `checksops_admin` username, a
missing Lambda VPC, or a conflict with an already-exclusive network
association stay `refused_unproven_aws_production_target`.

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
- role session name `checksops-production-readonly-inspect-${{ github.run_id }}`
  so the inspector identity prefix stays unchanged
- uploads the same redacted evidence JSON, including
  `database.host_compare` when authorized

PR #855 remains the standalone flatten-inventory change and is not
modified here. This PR includes the same basename SHA-256 lookup only
because host compare must fail closed unless live `secrets.mjs`
provenance is proven. Do not merge or deploy either PR from this
workstream.

No SQL, PostgreSQL connection, networking change, Lambda overlay, or
default-inspect behavior change is included.
