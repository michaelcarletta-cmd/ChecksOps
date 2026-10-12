# Guarded staging SQL executor

`.github/workflows/guarded-staging-sql-executor.yml` deploys and invokes the
staging VPC SQL executor `checksops-staging-guarded-sql-executor` from `main`
through the official writers `sql-executor-ensure.mjs` and
`sql-executor-invoke.mjs`. It never targets production, never accepts SQL
text, and only offers reviewed pins (today: `ledger-20261007193200`).

## One-time setup (owner)

1. Create IAM role `ChecksOpsGitHubStagingSqlExecutor` in account `806168576068`:
   - trust policy: `aws/staging-sql-executor/policies/trust-policy.json`
     (GitHub OIDC, `repo:michaelcarletta-cmd/ChecksOps:environment:staging` only)
   - permissions: `aws/staging-sql-executor/policies/permissions-policy.json`
2. In the GitHub `staging` environment, add variable
   `CHECKSOPS_STAGING_SQL_EXECUTOR_ROLE_ARN` =
   `arn:aws:iam::806168576068:role/ChecksOpsGitHubStagingSqlExecutor`.
   `CHECKSOPS_STAGING_DEPLOYMENT_GUARD_KMS_KEY_ARN` is already set.

Each mode narrows the role with an inline session policy: `inspect` can only
read the executor, `deploy` cannot invoke or sign, `apply` cannot change code.

## Run order for one migration

1. **Staging DB read-only diagnostic** (`staging-db-readonly-diagnostic.yml`):
   record the live definition hash of the pinned function.
2. **inspect**: records the live executor `CodeSha256` and whether it already
   carries main's package. The inventory accepts a live member only when it
   equals main's bytes or a version main once carried (full git history); a
   member main never had stops with `DEPLOYMENT_COLLISION`, and a member the
   new package would drop stops with `SOURCE_RECONCILIATION_REQUIRED`.
3. **deploy** (only if inspect shows the executor is not current):
   `approved_commit` = main SHA, `expected_executor_code_sha256` from step 2.
   Refuses if the executor environment would change. After `sql-executor-ensure`
   it re-inspects and requires the live executor to equal main's package.
4. **apply**: `approved_commit`, `expected_executor_code_sha256` (post-deploy
   value), `expected_live_definition_sha256` from step 1 (must equal the pin's
   pre-apply hash). Runs the accepted contracts, evaluates, takes the
   `staging/staging-sql` lease, issues a KMS-signed `sql-executor-invoke`
   receipt, and invokes the executor once with a one-use id. The executor
   re-checks every precondition inside its transaction.
5. **Staging DB read-only diagnostic** again: expect the pin's intended hash.

Production is out of scope and needs its own reviewed record and approval.
