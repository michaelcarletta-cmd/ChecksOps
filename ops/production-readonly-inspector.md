# Production read-only inspector

`.github/workflows/inspect-production-readonly.yml` is a separate, manually
dispatched inspection job. It only runs from `main`, checks the exact AWS
account and assumed role, and pins region `us-east-1`, API `kiqojucc02` / stage
`prep`, Lambda `checksops-production-prep-api`, SPA bucket
`checksops-production-frontend-806168576068`, and CloudFront distribution
`E1B0ZWWO5559U5` against the current deployment-guard metadata. Unknown,
staging, wildcard, or drifted targets are refused.

The `production-readonly` GitHub environment must be configured with required
reviewers before this workflow is enabled. Until a fresh successful read-only
run independently binds the live production API/function configuration to its
AWS persistence resource, the inspector reports
`refused_unproven_aws_production_target`. Templates, prior reports, staging
resources, source history, and inferred names/hosts are not accepted as live
production persistence evidence. The inspector never accepts a database
connection string, contacts a database, reads a database secret value, or
inspects historical migration paths.

The OIDC role ARN variable must be
`CHECKSOPS_PRODUCTION_READONLY_INSPECT_ROLE_ARN` =
`arn:aws:iam::806168576068:role/ChecksOpsGitHubProductionReadOnlyInspect`.
The workflow applies this exact session policy; the role's identity policy must
also permit these reads, or the report lists the missing permission:

- `sts:GetCallerIdentity` (`Resource: *`, required by STS identity checks).
- `s3:GetObject` on only the production `index.html` and `assets/index-*.js`.
- `lambda:GetFunctionConfiguration` and `lambda:GetFunction` on only
  `checksops-production-prep-api`. `GetFunction` is used only to retrieve the
  AWS-provided package URL and the function's CodeSha256/RevisionId. The URL is
  fetched without redirects, is never recorded, and the package is hashed and
  inventoried in memory without extracting or recording source contents.
- `apigateway:GET` on only API `kiqojucc02`, its `prep` stage, and integrations.
- `cloudfront:GetDistribution` on only `E1B0ZWWO5559U5`.
No S3 listing or writes, Lambda code/config updates or publishing, CloudFront
configuration changes or invalidations, Secrets Manager value reads, SQL
mutation, migrations, provider/payment calls, or application-data reads/writes
are included. If the live Lambda configuration contains an exact production
Secrets Manager ARN reference, the inspector attempts only
`secretsmanager:DescribeSecret` on that exact ARN and reports a missing
permission if it is not authorized. It reads only the RDS resource-ARN tag
metadata; it never calls `GetSecretValue`. That permission is not in the
workflow session policy until a live reference establishes the exact resource
and reviewers explicitly authorize that additional read. SSM parameter values
are never fetched; metadata alone is treated as insufficient to prove the
parameter's persistence target. No persistence target is accepted unless live
AWS configuration and resource metadata independently establish the complete
binding; otherwise the report remains
`refused_unproven_aws_production_target`.

The SPA fingerprint is fetched using HTTPS GET from the pinned `checksops.com`
host. The report compares the live entry, index/bundle hashes, S3 version, and
CloudFront identity with the production SPA lock. Lambda package evidence
records CodeSha256, RevisionId, package hash, member paths/sizes/hashes, and
exact-path comparisons for the reviewed current-main API sources. It does not
record the presigned URL, ZIP bytes, environment values, or source contents.
Lambda environment inspection returns variable names and the existing
allowlisted boolean workflow flags; values are requested only for approved
database-reference variable names (secret/parameter ARN, name, or reference
suffixes). Other database-like names are recorded as unresolved names only,
without fetching their values.

## IAM change boundary

The repository workflow's temporary session policy now adds only
`lambda:GetFunction` to the existing exact Lambda ARN. Before that workflow can
succeed, the existing read-only role's identity policy must receive the same
single-action delta, subject to explicit AWS authorization:

```json
{
  "Effect": "Allow",
  "Action": "lambda:GetFunction",
  "Resource": "arn:aws:lambda:us-east-1:806168576068:function:checksops-production-prep-api"
}
```

No AWS/IAM policy is changed by this repository update. No persistence metadata
permission is proposed without a fresh live reference: if a production secret
reference is observed, request `secretsmanager:DescribeSecret` only on that
exact ARN after separate review; do not grant `GetSecretValue`, wildcard
Secrets Manager access, SSM value reads, or RDS discovery access by inference.
Until the live reference and its required metadata reads are authorized, the
persistence target remains unproven and all SQL activity is blocked.

The production release lock currently has no Lambda `CodeSha256` pin. The
inspector reports the live Lambda code fingerprint, workflow flags, source
evidence, and the merged PR #762/#772 commit references, but marks live status
unverified until an accepted production code-hash pin exists; it does not infer
that either PR is deployed from a flag or a source-only match. Source lineage
is limited to current AWS source files; historical migration files are not
treated as live production evidence.

Invoking the workflow is a read-only production inspection. It does not
authorize or perform a deployment, SQL apply, Lambda update, or production
application-data change.

## Retrieve redacted evidence

After a successful dispatch on `main`, open the workflow run's **Artifacts**
section and download
`production-readonly-evidence-<commit SHA>-<run ID>-<attempt>`. It is retained
for 30 days and contains only `production-readonly-evidence.json`, the same
deliberately field-allowlisted, redacted JSON shown in the run summary. No raw
report or other runner temporary files are uploaded. Access follows repository
Actions artifact permissions; download before expiry for longer retention.

Compare the SPA entry/index/bundle hashes and CloudFront/lock comparison,
API identity/integrations, Lambda code SHA/revision and boolean workflow flags,
and merged PR #762/#772 live evidence between runs. A successful workflow can
still report `partial` (including database refusal or missing read permissions)
or `target_drift`; neither success nor source evidence proves the repairs are
deployed. Database refusal and sanitized read errors are preserved. No database
connectivity, AWS write permissions, release authorization, or deployment is
added by artifact collection.
