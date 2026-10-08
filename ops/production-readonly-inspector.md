# Production read-only inspector

`.github/workflows/inspect-production-readonly.yml` is a separate, manually
dispatched inspection job. It only runs from `main`, checks the exact AWS
account and assumed role, and pins region `us-east-1`, API `kiqojucc02` / stage
`prep`, Lambda `checksops-production-prep-api`, SPA bucket
`checksops-production-frontend-806168576068`, and CloudFront distribution
`E1B0ZWWO5559U5` against the current deployment-guard metadata. Unknown,
staging, wildcard, or drifted targets are refused.

The `production-readonly` GitHub environment must be configured with required
reviewers before this workflow is enabled. Current accepted AWS production
metadata does not identify a production database target: the production API
template declares no VPC/RDS attachment, and the production release lock has no
database evidence record. The inspector therefore reports
`refused_unproven_aws_production_target` and does not accept a database
connection string, contact a database, read a database secret, or inspect
historical migration paths. The separate
`aws/production/api-execution-role.yaml` template's staging-secret default does
not establish a production database target; staging RDS is not a production
target.

The OIDC role ARN variable must be
`CHECKSOPS_PRODUCTION_READONLY_INSPECT_ROLE_ARN` =
`arn:aws:iam::806168576068:role/ChecksOpsGitHubProductionReadOnlyInspect`.
The workflow applies this exact session policy; the role's identity policy must
also permit these reads, or the report lists the missing permission:

- `sts:GetCallerIdentity` (`Resource: *`, required by STS identity checks).
- `s3:GetObject` on only the production `index.html` and `assets/index-*.js`.
- `lambda:GetFunctionConfiguration` on only
  `checksops-production-prep-api`.
- `apigateway:GET` on only API `kiqojucc02`, its `prep` stage, and integrations.
- `cloudfront:GetDistribution` on only `E1B0ZWWO5559U5`.
No S3 listing or writes, Lambda code/config updates or publishing, CloudFront
configuration changes or invalidations, Secrets Manager access, SQL mutation,
migrations, provider/payment calls, or application-data reads/writes are
included. The SPA fingerprint is fetched using HTTPS GET from the pinned
`checksops.com` host. The report compares the live entry, index/bundle hashes,
S3 version, and CloudFront identity with the production SPA lock.

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
