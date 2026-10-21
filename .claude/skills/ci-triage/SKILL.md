---
name: ci-triage
description: Root-cause a failing ChecksOps CI check (aws-migration-guards, release-locks, tax-profile guard, deployment-guard) from the log down to the bytes, and pick the fix the rules allow. Use the moment a check is red, before any edit.
---

# CI triage: root cause first

A red check is a question. Answer it from the log and the bytes before changing a line.

## 1. Get the failure text

```bash
gh pr checks <n>
gh run list --branch <head-branch> --limit 10
gh run view <run-id> --log-failed | sed -n 1,200p
```

Reproduce locally with the same command CI ran (`.github/workflows/*.yml` names them):

| check | what it runs | needs |
|---|---|---|
| `aws-migration-guards` (`aws-migration-ci.yml`) | `bun run check:publish-keys`, `bun run test:aws-api` (`node --experimental-strip-types --test aws/tests/*.test.mjs`), `bun run build:aws`, template activation greps | `bun install --frozen-lockfile`, `npm ci --prefix aws/functions/api`, poppler-utils; the `*-pg` tests need PostgreSQL 16 and a non-root user (they skip without one, CI has one) |
| `release-locks` (`release-locks.yml`) | `node scripts/validate-release-locks.mjs`, `node --test ops/release-locks/tests/*.test.mjs`, `node scripts/production-deploy-guard.mjs`, `node scripts/check-pr-path-overlap.mjs --require` | `RELEASE_LOCK_BASE_SHA` = the PR's base sha (locally `origin/main`), `GH_TOKEN` for the overlap check |
| `tax-profile-migration-guard` | `npm run check:tax-profile-migrations`, the `supabase/security/*.test.mjs` tests | nothing extra |
| `deployment-guard` | the guard test list in `package.json` `test:deployment-guard` | `npm ci --prefix aws/functions/api` |

## 2. Match the failure to its cause

- **"protected source tree changed without an explicit manifest source.tree_hash update"**: a
  file of that ownership group changed (yours, or main's via a merge). `/hashes` shows which.
  Update `locked-components.json` from `--print-hashes` in this PR; never hand-write it.
- **"SQL source hash changed"** or an executor test asserting `source_sha256` /
  `intended_replacement_sha256`: the migration bytes or their rendered state changed. If the
  migration is applied or pinned, revert your edit and write a new migration. If it is new in
  this PR, re-derive every pinned value from the bytes (`/hashes`).
- **Overlap check fails**: another open PR already changed the same protected path. Read that
  PR. Either wait for it, ask the owner, or add a reviewed `overlap-allowlist.json` entry
  (`other_pr`, exact `path`, `expires` or `review_condition`, a reason of 20+ characters).
- **Append-only ledger error**: a ledger row was edited, removed or promoted. Put the original
  row back and append a new `apply_evidence` row instead.
- **Duplicate JSON key / unknown property / schema error**: the strict schema in
  `ops/release-locks/schema` or the pin schema rejected a field. Fix the field; do not loosen
  the schema.
- **Hook test (`claude-checksops-guard-hook.test.mjs`) fails**: `.claude/settings.json`,
  `CLAUDE.md`, `AGENTS.md` or `.gitattributes` lost a line the test pins.
- **`bun install --frozen-lockfile` fails**: `package.json` and `bun.lock` disagree. Run
  `bun install` to regenerate the lockfile; never edit it by hand.
- **A `-pg` test fails only in CI**: it skipped locally. Install PostgreSQL 16 or read the
  assertion against the SQL with the migration applied in order; the executor tests apply the
  real files as a non-superuser owner.
- **The failure is in code this PR does not touch and is red on `origin/main` too**: not this
  PR's. Say so on the PR (check name, why, the fix that exists). Re-run once at most.
- **The job died before any test ran** (checkout, install, runner): re-run once. A second
  failure is real.

## 3. Prove the fix before pushing

Run the same command locally and show it passing, then re-read the diff adversarially: what
would make CI reject this again? One validated push beats three speculative ones.

## Never

- Never edit expected hashes, fingerprints or recorded evidence to make a test pass.
- Never skip, disable, rename or quarantine a check, and never replace a workflow with a
  no-op that keeps the check's name.
- Never push an empty commit or close and reopen a PR to kick CI.
