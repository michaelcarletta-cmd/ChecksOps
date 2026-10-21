---
name: steward
description: Drive a ChecksOps pull request to mergeable - merge conflicts, red CI, review comments, lock and pin updates, and a status report with evidence. Use on any PR event or whenever asked to get a PR green, in the cloud or on the desktop.
---

# Steward a ChecksOps PR

A PR is done when all of these hold on its current head: no merge conflict, every CI check
green, every review thread answered or resolved, the body says what the PR does and does not
do, and the owner has approved. Until then it is yours at every event and every check-in.
Merging itself is the owner's decision (see `/merge-pr`).

## Look at the whole PR first

```bash
gh pr view <n> --json number,title,state,isDraft,mergeable,mergeStateStatus,headRefName,baseRefName,reviewDecision,url
gh pr checks <n>
gh pr view <n> --comments
git fetch origin main <head-branch>
```

Work the items in this order, and do all of them, not just the first.

## 1. Merge conflict or behind main

Merge, never rebase, never force-push a pushed branch:

```bash
git checkout <head-branch> && git merge origin/main
```

Resolve, then regenerate anything derived (tree hashes with
`node scripts/validate-release-locks.mjs --print-hashes`, never by hand). Lockfiles only with
the repo's tooling (`bun install`, `npm ci --prefix aws/functions/api`). Ask the owner only when
both sides changed the same logic and picking either loses behavior. After the merge, run
`/verify` and `/hashes` again: a merge from main often moves a protected group's tree hash.

## 2. Red CI

Find the root cause before touching anything (`/ci-triage`). The rules that bind here:

- Never edit an expected hash, a fingerprint or recorded evidence to make a test pass.
- Never skip, disable or quarantine a test. Never push an empty commit to re-run CI.
- Re-run a job at most once, and only when the failure is in code this PR does not touch. A
  second failure is real.
- A failure that is red on `origin/main` too is not this PR's, but it is not silent either:
  say on the PR which check, why it is not this PR's, and what fix exists.
- `aws-migration-guards` runs only when `aws/**`, `src/**`, `scripts/**`, `package.json`,
  `bun.lock` or the env examples change; `release-locks` always runs.

## 3. Review comments

- A human reviewer's small, local ask (a nit, a rename, a test, a one-function change): do it
  and push. A larger ask on a PR you did not open: propose on the thread, do not push.
- A bot finding is a claim to verify: trace a real path from a caller or input to the failure.
  Fix it when the path is real and the fix is proportionate; otherwise answer the thread with
  the path you traced. Optional findings never start a push on their own; carry the plainly
  correct ones into the next push that already changes the file.
- A finding that your own commits on this PR introduced is yours to fix now.
- Resolve the threads you addressed, and re-request the reviewer after pushing.

## 4. ChecksOps-specific checks before every push

- The PR is one step (`/guarded-step`): a staging pin, an inspect record, a pin PR, a record
  PR, a code change. Do not fold a second step in to save a round trip.
- Protected files changed? `node scripts/check-pr-path-overlap.mjs --require`. An overlap with
  another open PR is a conversation with the owner, or an `overlap-allowlist.json` entry
  naming the PR, the exact path, an expiry and a reason; never a silent takeover.
- Hashes agree? `node scripts/hash-report.mjs` exits 0.
- Locks agree? `node scripts/validate-release-locks.mjs` exits 0.
- Tests of the files you touched pass (`/verify`).

## 5. Report with evidence

Refresh the PR body or a single status comment so the thread shows live state:
what changed, which commands ran and their results (run ids, test counts, hashes), what was
not verified, and what the PR does not do (nothing applied, no release-lock change, no
`execute` change). Never present a guess as a result. Reply only when a round resolves the
task, hits a real blocker, or raises a question; the diff is the record.
