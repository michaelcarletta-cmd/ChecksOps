---
name: merge-pr
description: Merge-readiness check and the merge itself for a ChecksOps PR - owner approval verbatim, green CI on the current head, no conflict, no overlapping PR, one step per PR, and what to do right after. Use when asked to merge, or to say whether a PR can be merged.
---

# Merging a ChecksOps PR

Merging is the owner's decision for this PR, on this head. An approval of another PR, of an
earlier head, or of the plan that produced the PR does not cover it.

## Readiness, in this order

Read the live state, do not trust memory:

```bash
gh pr view <n> --json number,title,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,headRefName,baseRefName,url
gh pr checks <n>
gh pr view <n> --comments
```

Every line must be true before the merge:

1. **Owner approval, verbatim, for this PR.** The owner's words name this PR (number or
   unmistakable title) and say to merge. Quote them in your report. "Looks good" on the plan
   is not it. For a pin PR that sets `execute: true`, the owner reviews and merges it;
   the operator opens it and waits.
2. **CI green on the current head.** `gh pr checks` shows every check passing for
   `headRefOid`, not for an earlier commit. A pushed fix after the approval needs the owner's
   approval again.
3. **Mergeable, no conflict.** `mergeable` is `MERGEABLE` and `mergeStateStatus` is not
   `BEHIND`, `DIRTY` or `BLOCKED`. If behind, merge `origin/main` into the branch (never
   rebase a pushed branch), push, and start again at step 2.
4. **No overlapping open PR on a protected path**, or a reviewed allowlist entry.
   `node scripts/check-pr-path-overlap.mjs --require` on the branch.
5. **One step.** The PR does one thing from the guarded pipeline (`/guarded-step`) or one code
   change, and its body says what it does not do. A PR that quietly also flips `execute`,
   records an apply it did not observe, or edits a second workstream's files is not ready.
6. **Hashes and locks agree** on the branch: `node scripts/hash-report.mjs` and
   `node scripts/validate-release-locks.mjs` exit 0.
7. **Not a draft**, and every review thread is answered or resolved.

If any line fails, report which one, with the evidence, and stop. Do not fix forward past an
approval; a change after the approval returns the PR to the owner.

## The merge

The repository's history is merge commits (`Merge pull request #n from ...`); keep it that
way:

```bash
gh pr merge <n> --merge
```

Do not squash or rebase-merge: the staging pins record the commit that last authored a
migration's bytes, and squashing rewrites it. Do not delete the branch until the merge is
confirmed on `origin/main`.

Confirm:

```bash
git fetch origin main && git log --oneline -3 origin/main
```

## Right after

- Report: PR number, merge commit, the owner's approval words, the CI run ids that were green
  on the merged head.
- If this was a step of the pipeline, name the next step and its runbook (`/guarded-step`);
  the next step starts from a fresh branch off the new `origin/main`, never on this branch.
- If the merged PR changed a migration's bytes, the staging pin `commit` that other PRs cite
  may now be wrong for them: run `node scripts/hash-report.mjs` on `origin/main`.
- Other open PRs that touch the same protected paths now need `origin/main` merged in.

## Never

- Never merge on your own judgment of readiness. Ready is a report; merging is the owner's
  word.
- Never merge a PR whose head differs from the one the owner approved.
- Never merge to main by pushing (the guard refuses `git push` to main).
- Never merge two steps of the pipeline at once to save a round trip.
