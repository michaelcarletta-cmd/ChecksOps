# Production read-only inspector

`.github/workflows/inspect-production-readonly.yml` is a separate, manually
dispatched inspection job. It only runs from `main`, checks the exact AWS
account and assumed role, and pins region `us-east-1`, API `kiqojucc02` / stage
`prep`, Lambda `checksops-production-prep-api`, SPA bucket
`checksops-production-frontend-806168576068`, and CloudFront distribution
`E1B0ZWWO5559U5` against the current deployment-guard metadata. Unknown,
staging, wildcard, or drifted targets are refused.

The `production-readonly` GitHub environment must be configured with required
reviewers before this workflow is enabled. Its database connection secret is
`CHECKSOPS_PRODUCTION_READONLY_DATABASE_URL`; it must identify a read-only
database role and the pinned direct endpoint
`db.nbcqwpysqgyxrrbgtmkw.supabase.co:5432/postgres` with
`sslmode=verify-full`. The URL is never printed or fetched from AWS Secrets
Manager. The inspector requires a non-superuser connection with
`default_transaction_read_only=on`, and executes only its fixed catalog SELECT
statements.

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
- A direct database role with only the catalog/introspection SELECT access
  needed for `current_user`, `pg_catalog` routine/trigger metadata, and the
  `checksops` column/function privilege checks.

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
that either PR is deployed from a flag or a source-only match.

Invoking the workflow is a read-only production inspection. It does not
authorize or perform a deployment, SQL apply, Lambda update, or production
application-data change.
