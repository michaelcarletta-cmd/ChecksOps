# Production read-only fingerprint inspector

`.github/workflows/production-readonly-inspect.yml` is a separate, manual
production inspection path. It must only be dispatched from current `main`;
the job uses the `production-readonly` GitHub environment. Configure that
environment with required reviewers and restrict deployments to `main` before
enabling its role or database secret.

The workflow's AWS OIDC session is narrowed to reads of the production SPA
objects, CloudFront distribution, API Gateway identity/routes, and the
`checksops-production-prep-api` function and aliases. The role variable must
be exactly
`CHECKSOPS_PRODUCTION_READONLY_INSPECT_ROLE_ARN=arn:aws:iam::806168576068:role/ChecksOpsGitHubProductionReadOnlyInspect`.
No application Lambda is invoked. Lambda code is read via `GetFunction` and
the returned temporary download URL; only hashes of the relevant ZIP members
are reported. Secrets and all non-allowlisted Lambda environment values are
never printed.

The production environment must supply
`CHECKSOPS_PRODUCTION_INSPECT_DATABASE_URL` as a secret for the dedicated
`checksops_prod_inspector` role, connecting directly to
`db.nbcqwpysqgyxrrbgtmkw.supabase.co:5432/postgres` with TLS verification.
The inspector pins that endpoint and role, sets PostgreSQL's default
transaction to read-only, starts a `READ ONLY` transaction, runs only
catalog/privilege `SELECT` queries, verifies read-only role properties, and
rolls back. Missing credentials, role mismatch, an unsafe role, source drift,
or any failed inspection prevents a positive authorization assessment.
Provisioning this role, GitHub environment, secret, and IAM role is outside
the inspector and requires separate authorization.

To inspect, dispatch **Production read-only fingerprint inspection**, workflow
`.github/workflows/production-readonly-inspect.yml`, job `inspect`, and approve
the `production-readonly` environment if GitHub requires it. This task does
not dispatch the workflow. It never promotes artifacts, changes configuration,
applies SQL, invokes business operations, or writes production data.
