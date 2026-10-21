# ChecksOps deployment guard

Permanent repository-level safeguard so independent Cursor chats, agents,
branches, and workstreams cannot overwrite, restore, regress, or silently
replace each other's staging or production work.

This directory does **not** deploy, change staging, change production, change
database data, or change AWS resources. It is source-only enforcement.

## Relationship to release-locks

`ops/release-locks/` remains the **source / evidence lock**:

- protected-path hashes
- SQL apply ledger
- PR path overlap
- production SPA baseline pins
- `scripts/production-deploy-guard.mjs` candidate fingerprints

This guard is the **live concurrent-deploy lock**. It does not replace
release-locks. Future chats must satisfy **both**.

| Concern | release-locks | deployment-guard |
|---|---|---|
| Concurrent source edits | PR path overlap | allowed |
| Shared-target deploy | fingerprint vs locked artifact | lease + live TOCTOU + overlay membership |
| Lambda overlay CAS | not implemented | CodeSha256 + RevisionId |
| Stale ZIP/dist | superseded SPA bundles (prod) | reject all old packages |
| Same-file Lambda member | not implemented | `SOURCE_RECONCILIATION_REQUIRED` |
| Accepted feature contracts | implicit via tests/locks | extensible registry |
| Staging lease | none | short-lived local lease |
| Cursor inheritance | OPERATOR.md (human) | `.cursor/rules` + `AGENTS.md` |

## Core rule

Independent **source** work may happen concurrently.

Independent **deployment** to a shared target may not overwrite another
workstream.

If live state changed after a workstream's preflight: **STOP**. Never restore,
reclaim, redeploy an old baseline, put an old dist back, reuse an old Lambda
ZIP, or overwrite newer live state.

## Official commands

```bash
# Identity + evaluate + receipt (no AWS)
node scripts/deployment-guard/manifest.mjs --input path/to/workstream.json
node scripts/deployment-guard/preflight.mjs --acquire-lease --receipt --input path/to/workstream.json
node scripts/deployment-guard/lease.mjs acquire --workstream-id ID --environment staging --component checksops-staging-api --commit $(git rev-parse HEAD)
node scripts/deployment-guard/lambda-overlay.mjs --input path/to/overlay.json
node scripts/deployment-guard/spa-promote.mjs --input path/to/spa.json
node scripts/deployment-guard/spa-upload.mjs --environment production
node scripts/deployment-guard/sql-apply.mjs --input path/to/sql.json
node scripts/deployment-guard/sql53-production-apply.mjs --input path/to/sql53-production-apply.json
node scripts/deployment-guard/github-sql53-production-apply.mjs
# Production SQL 29 / SQL 30 (Mortgage Ops library; ops/production-sql-29-30-apply.md)
node scripts/deployment-guard/sql29-mortgage-ops-library-parity-production-apply.mjs --inspect
node scripts/deployment-guard/sql30-tenant-documents-doc-type-production-apply.mjs --inspect
# Production SQL 90-102 (release 2026-10-17; ops/production-sql-90-97-apply.md), one tool per migration
node scripts/deployment-guard/sql90-users-only-tenant-roles-production-apply.mjs --inspect
node scripts/deployment-guard/sql98-tenant-fee-collection-production-apply.mjs --inspect
node scripts/deployment-guard/sql100-mortgage-desk-live-access-production-apply.mjs --inspect   # inspect only: a no-op on production
node scripts/deployment-guard/sql101-invite-identity-insert-order-production-apply.mjs --inspect   # after SQL 90, before tenant-admin.mjs
node scripts/deployment-guard/sql102-platform-owner-tenant-profile-production-apply.mjs --inspect   # after SQL 98, before tenant-billing-handlers.mjs
node scripts/deployment-guard/sql103-share-library-trigger-acl-production-apply.mjs --inspect   # immediately before SQL 29 (ops/production-sql-103-apply.md)
node scripts/deployment-guard/sql104-payment-idempotency-keys-grant-production-apply.mjs --inspect   # any time after SQL 91 (ops/production-sql-104-apply.md)
node scripts/deployment-guard/sql105-onboarding-payment-table-grants-production-apply.mjs --inspect   # any time after SQL 91 (ops/production-sql-105-apply.md)
node scripts/deployment-guard/sql106-moov-transfer-webhook-status-production-apply.mjs --inspect   # any time after SQL 91 (ops/production-sql-106-apply.md)
# Production SQL 71, 77-89 and 90-102 on the runner, one invocation (ops/production-sql-one-shot.md)
node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql80 --phase inspect ...
node scripts/deployment-guard/verify-live.mjs --input path/to/live.json
node scripts/deployment-guard/scan-bypass.mjs

# Legacy script (must not be invoked directly against a shared target)
node scripts/deployment-guard/wrap-legacy.mjs --input path/to/workstream.json -- node aws/cutover/scripts/hardening-batch4-apply.mjs

# Tests (no live AWS)
npm run test:deployment-guard
```

The `guarded-staging-lambda-overlay.yml` workflow defaults to read-only `inspect`.

Full-package rebuilds (the whole `aws/functions/api` tree plus a lockfile install, needed when a
dependency or a module the overlay cannot carry must reach a Lambda) go through
`guarded-staging-lambda-rebuild.yml` and `guarded-production-lambda-rebuild.yml`, gated by
`ops/deployment-guard/lambda-rebuild-plan.json`: apply is refused while any live-vs-candidate
difference is not listed there. Runbook: `ops/production-lambda-rebuild.md`.

Environment-variable changes (one reviewed key at a time, never code, never role/memory/timeout/VPC)
go through `guarded-staging-lambda-config.yml` and `guarded-production-lambda-config.yml`, gated by
`ops/deployment-guard/lambda-config-plan.json`: apply is refused unless every listed key still holds
its recorded live value. Runbook: `ops/lambda-configuration-change.md`.

The production HTTP API CORS allow-list (`*` to checksops.com and www.checksops.com, nothing else)
goes through `guarded-production-cors.yml`. Runbook: `ops/production-cors-allowlist.md`.
It reports the requested repository member as `PRESENT` (with its SHA-256) or
`ABSENT`, alongside the live Lambda CodeSha256 and RevisionId. Absence is not
deployment authorization. For `apply`, explicitly select `add` for an absent
member or `replace` for a present member; REPLACE still requires the exact
reviewed live member SHA-256. Both require the approved main commit, a lease,
and a KMS-signed receipt bound to a fresh live fingerprint. Issuance also attaches
the local issuer HMAC used as the single-use consumption key; authorization
verifies both the HMAC and the pinned KMS signature before consumption. The receipt owns
exactly one member in `owned_member_ops.add` or `.replace`, never both.
Only the official overlay writer mutates the current live ZIP, preserving all
unrelated member contents and refusing member appearance or fingerprint drift.

`sql_before` holds apply in staging too. A member whose entry in
`ops/deployment-guard/production-api-overlay-plan.json` names `sql_before` is refused
(`DEPLOYMENT_COLLISION`, before any AWS call, lease or receipt) until that SQL file is recorded
with `verified_live: true` in `ops/deployment-guard/staging-sql-live.json`, the staging
equivalent of the plan's `sql_prerequisites[].verified_live` (a missing entry counts as not
live). `inspect` reports the hold (`sql_before`). Record a staging apply there only in a
reviewed change that names the guarded staging SQL executor run.

For source reconciliation, `inspect` with `export_live_member: true` uploads the
live `.mjs`/`.js` member's exact bytes as a 1-day artifact. The bytes are
re-hashed against the inspected SHA-256, and the export is refused if the member
is absent or carries key material. `apply` refuses it before any AWS call.

Never:

- `aws lambda update-function-code` directly
- `aws s3 sync` / `aws s3 cp` of `index.html` or `dist/`
- CloudFront invalidation as a reclaim
- `sam deploy` of a thin `aws/template.yaml` over a live overlay Lambda
- restore / reclaim staging or production

## Phase 1 analysis (read-only, completed before implement)

### A. Existing deployment scripts

In-repo writers that can change Lambda, S3, CloudFront, or SQL:

- `aws/cutover/scripts/hardening-batch3-apply.mjs` / `hardening-batch4-apply.mjs` — live ZIP overlay + `UpdateFunctionCode` on `checksops-production-prep-api` without RevisionId CAS
- `aws/origin-verify/apply-gate3a.mjs` — production authorizer `UpdateFunctionCode`
- `aws/origin-verify/apply-gate3b.mjs` / `operator-apply-gate3b.mjs` — CloudFront distribution update
- `aws/cloudfront/apply-step1.mjs` — CloudFront function + distribution update
- `scripts/staging-partner-integrity-inspect.mjs` / `scripts/c1c-partner-share-aws-inspect.mjs` — oneshot Lambda create/update
- `aws/db-copy/rehearsal/scripts/bridge-db-rehearsal.mjs` / `aws/write-path/scripts/run-parity-schema-rehearsal.mjs` — rehearsal oneshots
- `aws/storage/*.mjs` / `bridge-storage-copy.mjs` — `s3api put-object`
- `scripts/run-hosted-tax-profile-containment.mjs` — authorized hosted SQL
- `aws/cutover/scripts/hardening-batch5-apply.mjs` — CloudFormation monitoring stack

There is **no** centralized SPA upload script in `scripts/`; production SPA
safety today is fingerprint-only in `scripts/lib/production-spa-baseline.mjs`.

### B. Existing release locks / safeguards

Reuse; do not duplicate:

- `ops/release-locks/*`
- `scripts/lib/release-locks.mjs`
- `scripts/production-deploy-guard.mjs`
- `scripts/lib/production-spa-baseline.mjs`
- `.github/workflows/release-locks.yml`

### C. Existing protected-path mechanisms

`ops/release-locks/protected-paths.json` + PR overlap. Protects **git paths**,
not live ZIP members or index.html bytes.

### D. Existing accepted-contract mechanisms

Scattered tests (`aws/tests/*`, OCR lock tests, financial write tests). No
extensible deploy-time contract registry existed.

### E. Direct AWS deployment bypasses

See `bypass-inventory.json`. Classification: SAFE / NEEDS_GUARD / LEGACY/BYPASS.

### F. Staging / production deployment targets

- Lambda: `checksops-staging-api`, `checksops-production-prep-api`
- SPA: staging.checksops.com, checksops.com / `E1B0ZWWO5559U5` / `checksops-production-frontend-806168576068`
- SQL: staging and production application DBs (release-lock ledger + hosted wrapper)

### G. What can be reused

Release-lock fingerprints, production SPA pins, SQL ledger hashes, existing
contract test files (referenced, not copied).

### H. Proposed minimal architecture (implemented)

Sibling of release-locks:

```
ops/deployment-guard/          registries + inventory + this README
scripts/deployment-guard/      official CLIs + pure evaluators
aws/tests/deployment-guard.test.mjs
.cursor/rules/deployment-guard.mdc
AGENTS.md
```

All evaluators are injectable and default to a forbidden AWS adapter.

### I. Files added / changed

Added only. No edits to `ops/release-locks/*`, existing apply scripts, or
feature branches. Local lease state is `.deployment-guard/` (gitignored).

### J. Migration plan for existing deployment scripts

1. Keep scripts in tree (do not delete).
2. Classify in `bypass-inventory.json`.
3. Shared-target writers call `enforceScriptGuard` / `enforceSharedLambdaTarget`
   / `enforceS3Target` before AWS mutation.
4. Overlay scripts must pass through `evaluateLambdaOverlay` (owned members +
   fresh live ZIP + RevisionId CAS) before `UpdateFunctionCode`.
5. Direct invocation without a receipt fails with `DEPLOYMENT_GUARD_REQUIRED`.

## Phase 2 — repository enforcement

Inventoried writers cannot mutate a shared target unless a short-lived
machine-readable receipt exists. Receipts live under
`.deployment-guard/receipts/${environment}::${component}.json` and bind:

- `workstream_id`
- `target_environment`
- `target_component`
- `commit`
- `deployment_type`
- `preflight_live_fingerprint`
- `lease`
- `expiry` (15 minutes default, 60 minutes max)

A staging Lambda receipt cannot authorize staging SPA or production.
`CHECKSOPS_DEPLOYMENT_GUARD_APPLY`, `CHECKSOPS_DEPLOYMENT_GUARD_BYPASS`, and
`CHECKSOPS_SKIP_DEPLOYMENT_GUARD` are not bypasses.

Receipts are HMAC-SHA256-signed with a local issuer key at
`.deployment-guard/issuer.key` (gitignored, never a repo secret). Hand-written
JSON without that MAC is `RECEIPT_FORGED`. This is repository collision
protection, not an AWS security boundary: a process that can read the local
key or call `issueReceipt` after `acquireLease` can still obtain a valid
receipt. Out-of-repo AWS/CloudShell authority is a later IAM phase.

CI runs `scripts/deployment-guard/scan-bypass.mjs` against a reviewed
registry. New unregistered `update-function-code`, SPA `index.html` upload,
CloudFront mutation, CloudFormation mutate, or API Gateway route/integration
writers fail the scan.

`npm run deploy:staging` and `npm run deploy:production` are evaluate-only
guarded entrypoints. They do not write AWS.

## IAM hardening (recommendations only; not applied)

- Deny `lambda:UpdateFunctionCode` on shared functions except a dedicated
  deploy role that requires `RevisionId` compare-and-swap.
- Deny `s3:PutObject` on production `index.html` except that role.
- Deny `cloudfront:CreateInvalidation` / `UpdateDistribution` except that role.
- Do not grant Cursor oneshot roles `UpdateFunctionCode` on
  `checksops-staging-api` or `checksops-production-prep-api`.
- Keep `AWS_*_ENABLED` money flags false unless a reviewed production lock
  says otherwise.

This PR does not change IAM.

## Staging DB diagnostic approval stop

`.github/workflows/staging-db-readonly-diagnostic-deploy.yml` is disabled with a
false job condition until an independent approval boundary is configured and
verified. Do not dispatch it or deploy this diagnostic. Its `approved_commit`
input only compares a caller-supplied value with `GITHUB_SHA`; it is not an
approval record.

The current deployer is create-only, not an updater: its preflight fingerprint
requires `stack_state: must-be-absent`, it refuses a stack returned by
`DescribeStacks`, and it calls CloudFormation `CreateStack`. The diagnostic
function and a published immutable version already exist in staging (reported
for this issue; not independently queried here), so this path cannot safely
deploy to the current target. The stack is registered as a CloudFormation
target, but the generic Lambda overlay only accepts registered shared Lambda
targets; the diagnostic function is not one. Do not work around this mismatch
with CloudFormation update or an unregistered Lambda overlay.

An issue-comment/API verifier in this repository would not be an independent
gate: a principal able to change `main` can change or remove the verifier in
the same commit. Comment records also do not provide an atomic one-time claim
that prevents concurrent or replayed deployment attempts. The Deployment Guard
lease and receipt prevent target collisions; they do not establish human
approval or make the workflow verifier immutable.

Resume only after an authorized administrator establishes and independently
verifies enforcement outside this mutable workflow. Acceptable options include
a supported protected GitHub environment with required independent reviewers
and bypass disabled, or an external promotion controller with a separately
controlled verifier, atomic single-use authorization, and AWS OIDC trust bound
to that controller. Also restrict who can update `main` and the enforcement
configuration, and prevent self-approval. Before enabling any deployment,
independently review and test rejection of a wrong SHA, unapproved/self-
approving actor, replay, branch or tag mismatch, changed verifier/workflow,
missing GitHub permission, and concurrent attempts. Re-verify live staging and
AWS role policies, then separately authorize a single deployment; this
source-only change performs none of those actions.

Any future update path must first have an independently controlled approval
boundary and a dedicated target-only writer. A single reviewed `main` SHA must
be bound to that approval; the writer must freshly read the live target and
fingerprints, acquire its exact staging diagnostic lease/receipt, and compare
the fresh code SHA and revision immediately before mutation, refusing all
drift. It must update only the diagnostic function, preserve its live
configuration and all unrelated resources, verify the exact resulting code
SHA, publish and verify an immutable version, then run only the read-only
version-pinned validation. Old fingerprints are comparison evidence, never
restore authority. Independently review the AWS role and OIDC trust so they
cannot write the staging API, production, SQL, SPA, or other builds.

After review/merge, an authorized administrator must establish and test that
external approval boundary, independently inspect the live stack/function,
version, and role policies, and approve any separately reviewed updater before
any deployment. Following an authorized update, verify its emitted
`version_arn` and `code_sha256`, then update the GitHub Actions variable
`CHECKSOPS_STAGING_DB_DIAGNOSTIC_VERSION_ARN` to that exact immutable version
ARN before invoking the diagnostic. The invoke workflow's existing
`workflow_dispatch` 403 remains an external caller/app/environment permission
blocker; resolve it there without broadening workflow permissions. No current
published version or AWS configuration was read by this source-only change.

The deployer and invocation contract tests
(`aws/tests/staging-db-readonly-diagnostic-deploy.test.mjs` and
`aws/tests/staging-db-readonly-lambda-diagnostic.test.mjs`) are offline: they
cover rejection of an existing target or non-absence drift, missing approval,
version mismatch, unrelated target selection, and allowlisted diagnostic
output. They do not prove live stack state, IAM/OIDC policy, environment
reviewer configuration, or AWS apply behavior; those require fresh AWS and
GitHub administrator evidence before a future authorization.
