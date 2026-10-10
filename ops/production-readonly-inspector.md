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

- `sts:GetCallerIdentity`, `rds:DescribeDBInstances`, and
  `ec2:DescribeSecurityGroups` (`Resource: *`; AWS requires the RDS metadata
  action to be unscoped, and live RDS security-group IDs cannot be pinned in
  the workflow). The inspector only queries already-observed GroupIds.
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
Secrets Manager ARN reference, the inspector attempts `secretsmanager:DescribeSecret`
on that exact ARN and `rds:DescribeDBInstances` for account RDS network/secret
metadata. It does not rely on optional secret tags, secret names, descriptions,
staging, docs, or a single naming coincidence, and it never calls
`GetSecretValue`. The exact-secret `DescribeSecret` read is authorized in the
workflow session policy. `DescribeDBInstances` is authorized as a read-only
metadata action with `Resource: "*"`. The query returns only instance ARN,
optional `MasterUserSecret` ARN, VPC id, subnet ids, and VPC security-group ids;
endpoints, identifiers used as names, and unmatched instance ARNs are not
persisted. A target is proven only by an exact live `DATABASE_SECRET_ARN`
`MasterUserSecret` association, or by exclusive membership of exactly one
observed instance in the live Lambda VPC, or by an exclusive security-group
intersection with the live Lambda security groups, or by exclusive
security-group ingress from the live Lambda security groups to exactly one
observed RDS instance (TCP 5432 or all-protocols `UserIdGroupPairs` in the
same account). Zero or multiple matches remain fail-closed. CIDR rules, names,
hostnames, tags, and staging configuration are not used. An authorized empty
`MasterUserSecret` match is not proof that production RDS does not exist:
application credentials may be separately managed. If two observed instances
share the live Lambda VPC without an exclusive security-group association, the
inspector describes only already-observed GroupIds (live Lambda security
groups plus VPC-matching RDS security groups already returned by
`DescribeDBInstances`) and accepts a target only when exactly one instance has
that ingress. Describing only the Lambda security groups is not sufficient:
ingress lives on the RDS security groups, and Lambda egress is commonly
unrestricted CIDR. Zero or multiple ingress matches stay
`refused_unproven_aws_production_target`. Exclusive VPC membership of exactly
one instance still proves without an EC2 call. SSM parameter values are never
fetched; metadata alone is treated as insufficient to prove their persistence
target. No persistence target is accepted unless live AWS configuration, the
verified runtime package, and AWS resource metadata independently establish the
complete binding; otherwise the report remains
`refused_unproven_aws_production_target`. The inspector still never accepts a
connection string, contacts a database, or inspects SQL function definitions.
The default workflow still never calls `GetSecretValue`.

An owner-gated companion workflow,
`.github/workflows/inspect-production-secret-host-compare.yml`, may compare
the live secret host to observed RDS endpoints only after explicit
authorization. See `ops/production-secret-host-compare.md`. That path still
never persists the secret value, credentials, connection string, or hostname,
and it fails closed on zero or multiple endpoint matches. Do not add
`GetSecretValue` to the default inspect session policy.

The SPA fingerprint is fetched using HTTPS GET from the pinned `checksops.com`
host. The report compares the live entry, index/bundle hashes, S3 version, and
CloudFront identity with the production SPA lock. Lambda package evidence
records CodeSha256, RevisionId, package hash, member paths/sizes/hashes, and
exact-path comparisons for the reviewed current-main API sources. It does not
record the presigned URL, ZIP bytes, environment values, or source contents.
Lambda package downloads accept only the pinned-region AWS Lambda S3 virtual-
hosted or bucket-path endpoints for `awslambda-us-east-1` / `awslambda-us-east-1-tasks`,
plus the observed production Lambda service artifact host
`prod-04-2014-tasks.s3.us-east-1.amazonaws.com`. Arbitrary `.s3`, `amazonaws`, or
unrelated bucket hosts are rejected. Downloads remain HTTPS-only, reject
redirects, URL credentials, explicit ports, fragments, and unsafe ZIP members,
and report only a redacted failure stage and reason. A rejected location also
records sanitized hostname, path-style classification, scheme classification,
and validator rejection reason; non-AWS hostnames and unrecognized path data
are redacted. Query strings, credentials, full URLs, and fragments are never
recorded. These diagnostics do not expand the download allowlist. Package
inventory and current-source comparisons, including `secrets.mjs`, run only after
the location is accepted; live matches are not claimed from fixtures.
Lambda environment inspection returns variable names and the existing
allowlisted boolean workflow flags; values are requested only for approved
database-reference variable names (secret/parameter ARN, name, or reference
suffixes). Other database-like names are recorded as unresolved names only,
without fetching their values.

## IAM change boundary

The repository workflow's temporary session policy authorizes
`rds:DescribeDBInstances` with `Resource: "*"`, in addition to the existing
exact-resource Lambda `GetFunction` read:

```json
{
  "Effect": "Allow",
  "Action": "lambda:GetFunction",
  "Resource": "arn:aws:lambda:us-east-1:806168576068:function:checksops-production-prep-api"
},
{
  "Effect": "Allow",
  "Action": "rds:DescribeDBInstances",
  "Resource": "*"
},
{
  "Effect": "Allow",
  "Action": "ec2:DescribeSecurityGroups",
  "Resource": "*"
}
```

The production read-only role's identity policy separately authorizes these
reads. This repository update changes only the workflow session policy and
inspector source. No AWS/IAM identity policy is applied here; the owner must
add the same `ec2:DescribeSecurityGroups` allow to
`ChecksOpsGitHubProductionReadOnlyInspect` before a live inspect can use it.
Do not grant `GetSecretValue` on the default inspect path, wildcard Secrets
Manager access, SSM value reads, `ec2:AuthorizeSecurityGroupIngress`,
`ec2:RevokeSecurityGroupIngress`, `ec2:CreateSecurityGroup`,
`ec2:DeleteSecurityGroup`, or RDS mutation/data-plane access. The optional
secret-host-compare identity statement is documented in
`ops/deployment-guard/production-secret-host-compare-iam.json` and must not be
applied from this repository update. Do not expand `rds:DescribeDBInstances` further without separate
authorization. Persistence remains unproven unless metadata independently binds
the live Lambda to exactly one production RDS instance and the live package
proves the runtime secret source.

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
