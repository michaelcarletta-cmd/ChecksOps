# Operator guide: locked components

These controls are **fail-closed**. Missing evidence is a failure, not a skip. This guide does not authorize production writes.

## GitHub enforcement (blocking; not solved by this repository)

Repository validation protects the release process. It is **not** merge-ready merely because the PR-head `release-locks` workflow is green.

Until these are configured in GitHub, treat this workstream as **REVISION REQUIRED**:

- `CODEOWNERS` is advisory until branch protection requires code-owner review.
- The `release-locks` check must become a **required** status check.
- Direct pushes to the default branch must be disabled separately.
- Administrator bypasses must be disabled separately.
- GitHub Actions `pull_request` / `merge_group` still execute the workflow file from the PR snapshot. This PR does **not** use `pull_request_target` (that would execute untrusted PR code with secrets). A trusted **base-owned** required workflow cannot be completed safely inside this repository alone.

Hashing a changed validator with that same changed validator is **not** independent security. After merge, future PRs compare candidate lock history against the trusted base-branch ledger, but GitHub still has to require the base-owned check.

## Live AWS

Repository evidence (hashes, ledgers, fingerprints checked into git) does **not** itself prove live AWS state. Live state must be gathered by a separately reviewed, read-only verification process. No component may become `PRODUCTION_LOCKED` until that live collection and review is completed.

## Unrelated CI

The pre-existing `aws-migration-guards` failure is unrelated to this lock system. Do not hide, skip, or rename that check to make a lock PR look green.

## What the lock actually enforces

- Protected-path hashes in `locked-components.json` must match the current tree.
- Recorded SQL `source_sha256` values must match file bytes.
- The applied-migration ledger is **append-only against the trusted base ref** (`RELEASE_LOCK_BASE_SHA` or the verified merge base). Existing rows cannot be deleted, reordered in a meaning-changing way, mutated, or promoted from `applied=false` to `applied=true`. Application evidence is a **new** appended `apply_evidence` record linked to the original source record, with a tracked repository proof path and environment metadata.
- This PR is the genesis ledger (`genesis=true`, `immutable_starting_point=true`). After merge, all future validation compares candidate history against the base-branch ledger.
- `PRODUCTION_LOCKED` rejects self-attested booleans, `recorded=true` alone, and arbitrary 64-character hashes. SQL whose source contains `NOT_APPLIED` / `DO NOT APPLY` cannot be treated as applied. Proof and evidence references must be existing tracked repository paths. A deployment fingerprint must include at least one immutable production identifier (published Lambda version + code hash, SPA bundle filename + SHA-256, CloudFront distribution/deployment fingerprint, or applied SQL hash plus a database evidence record).
- `production_active=true` is forbidden unless classification is `PRODUCTION_LOCKED`.
- Duplicate JSON keys, unknown properties, incomplete classification names, component/group deletion with a replacement tree hash, and unowned files under watched production-provider directories fail closed.
- A production deploy candidate fingerprint must match locked artifacts. Live AWS comparison is disabled on purpose.
- Overlapping open PRs that already touch the same protected path fail CI unless an explicit `overlap-allowlist.json` exception is reviewed. Pagination of open PRs must be proven complete.

Documentation, chat history, and “merged” status are **not** production locks.

Control-plane files (CODEOWNERS, the release-locks workflow, `ops/release-locks/**`, and the lock scripts) are owned by `production-release`. A change to the protection system is a control-plane change.

## Partner-sharing production SQL (C1C)

`31_partner_safe_read.sql`, `32_partner_share_lifecycle.sql`,
`33_partner_stage_totals.sql`, and `34_c1c_partner_visibility.sql` are
**APPLIED IN PRODUCTION**. Proof:
`ops/release-locks/proof/c1c-partner-share-production-apply.md`.
Ledger `apply_evidence` rows link that proof. Do not reapply those files
to document them. Do not transfer `check_intake_items.tenant_id` or
duplicate parent checks to "fix" partner visibility. Read
`aws/rls/PARTNER_SHARING_INVARIANT.md` before touching partner Checks.

The application/API/UI repair that matches that SQL is PR #350
(`9aac7bb5b1ed0a8d03e305552797a9acfacc7f64`) and is not on main until
that PR is reviewed and merged. This guide does not authorize merging it.

## Intentionally updating a protected component

1. Open a **new** PR from latest `origin/main`. Do not reuse another agent’s branch.
2. Run `node scripts/check-pr-path-overlap.mjs --require` before editing. If another open PR already owns the path, stop.
3. Change the source files **and** in the same PR:
   - update `components.<id>.source.git_sha` to the parent/main SHA you started from, then to the commit that contains the change after it lands;
   - replace `source.tree_hash` with the value from `node scripts/validate-release-locks.mjs --print-hashes`;
   - if SQL bytes change, **append** a new ledger entry (never rewrite `applied=true` rows). Set `applied=false` until independent apply proof exists;
   - add missing-evidence notes or, for a real promotion, the production fingerprint fields after live read-only evidence collection.
4. Keep `fail_closed: true`. Do not delete CI jobs to get a green check. Do not replace `.github/workflows/release-locks.yml` with a no-op that keeps the same check name.
5. Request review. Do not merge from this guide.

## Promoting to PRODUCTION_LOCKED

Do not promote from this PR. A later reviewed PR may change classification only after a separate live, read-only evidence collection, when **all** of these are attached as repo evidence (not chat):

- merged git SHA for the exact source tree
- every `required_sql` row `applied=true`, `applied_environment=production`, `applied_sha256 === source_sha256`, and the SQL source does not contain `NOT_APPLIED` / `DO NOT APPLY`
- a new ledger `apply_evidence` row linked to the original source record, with a tracked proof path
- artifact identity plus an immutable production identifier in `deployment_fingerprint` (not `recorded=true` alone)
- production validation identifying environment, component, git SHA, artifact identity, validation timestamp, and evidence producer/type
- evidence refs that are existing tracked repository paths
- rollback git SHA **and** rollback artifact
- `missing_evidence` empty
- `production_active=true`

If any item is missing, the validator fails. Use `SOURCE_LOCKED_NOT_ACTIVE` or `UNVERIFIED` instead.

## Unlocking / rolling back

Unlocking means a reviewed PR that:

- sets classification to `UNVERIFIED` or `SOURCE_LOCKED_NOT_ACTIVE`
- sets `production_active=false`
- records rollback references
- does **not** delete historical ledger rows

Do not “unlock” by editing AWS, applying SQL, or force-pushing `main`.

## Production deploy guard

Operators who wrap a deploy script MUST run:

```bash
node scripts/production-deploy-guard.mjs --candidate path/to/fingerprint.json
```

`CHECKSOPS_PRODUCTION_DEPLOY=1` fails unless a candidate fingerprint is supplied **and** the targeted components are `PRODUCTION_LOCKED` with matching hashes. `--live` always fails.

## Overlap exceptions

`overlap-allowlist.json` is empty. An exception must name:

- `other_pr` (concrete number)
- a `path` that exactly equals a protected path or a specifically permitted protected prefix
- `expires` or `review_condition`
- `reason` (≥ 20 characters)

Empty paths and repository-wide entries are forbidden.

## Out of scope (do not do from a lock PR)

- merge to main from the agent
- `sam deploy`, `aws s3 sync`, CloudFront invalidation
- `psql` / migration apply
- Cognito user/pool changes
- secret rotation
- Moov/CheckAlt/SES/financial operations
