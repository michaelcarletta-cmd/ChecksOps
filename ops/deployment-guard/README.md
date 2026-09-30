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
node scripts/deployment-guard/verify-live.mjs --input path/to/live.json
node scripts/deployment-guard/scan-bypass.mjs
node scripts/deployment-guard/preserve-builds.mjs

# Legacy script (must not be invoked directly against a shared target)
node scripts/deployment-guard/wrap-legacy.mjs --input path/to/workstream.json -- node aws/cutover/scripts/hardening-batch4-apply.mjs

# Tests (no live AWS)
npm run test:deployment-guard
```

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

## Phase 3 — preserve accepted builds

Independent Cursor chats must not overwrite accepted fixes or deploy a
stale SPA/Lambda package. This phase extends the existing guard; it does
not replace leases, receipts, overlays, or release-locks.

Always-apply Cursor rule: `.cursor/rules/preserve-builds.mdc`.

Official evaluator:

```bash
node scripts/deployment-guard/preserve-builds.mjs --input path/to/preserve.json
```

Additional fail-closed checks on mutating evaluates:

- separate branch + worktree isolation (`WORKTREE_ISOLATION_REQUIRED`)
- reconcile against current `origin/main` (`MAIN_RECONCILIATION_REQUIRED`)
- accepted source-composition registry (`ops/deployment-guard/accepted-source-composition.json`)
- exclusive lease + mutation-boundary live fingerprint
- reject stale SPA dist and stale/full Lambda packages
- accepted-contract **and** accepted-composition regression gates
- no automatic rollback / reclaim over another workstream

Preserved accepted work includes Signature Requests, Claim Ledger /
claim-number Save, OCR, and endorsement fixes. A boolean
`accepted_composition` flag is not enough; the composed file list must
include every accepted preserved path.

Remaining holes that in-repo scripts cannot close (IAM, out-of-repo AWS
CLI, per-checkout leases) are listed in
`ops/deployment-guard/enforcement-gaps.json`.

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
