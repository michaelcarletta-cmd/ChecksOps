@AGENTS.md

# How ChecksOps ships (Claude Code)

The rules above are enforced for Claude Code by `.claude/settings.json` and
`.claude/hooks/checksops-guard.mjs`: direct deploys are denied, and edits to an
existing migration or to an applied pin's recorded evidence are refused.

Every database or Lambda change goes through the guarded path, one reviewed PR
per step, and each production step waits for the owner's explicit approval of
that run:

1. Staging read-live, then staging apply (`guarded-staging-sql-executor.yml`).
2. Read-only production inspect through the one-shot (`--phase inspect`).
3. Pin PR: record the production pre-state and staging acceptance, set
   `execute: true`. The owner reviews and merges it.
4. Production apply through `production-sql-one-shot.mjs --phase apply` with
   the owner's exact words (`ops/production-sql-one-shot.md`).
5. Record PR: record `applied`, set `execute: false` again.

Runbooks: `ops/production-sql-one-shot.md`, `ops/production-sql-90-97-apply.md`,
`ops/deployment-guard/README.md`.

## Working habits

- Start from a fresh `origin/main` in a new branch or worktree; never stack work on a merged
  branch or on another workstream's branch.
- Read before you act: the runbook for the step, the last record of the same kind (the
  previous pin or record PR is the template), and the live state through a read-only
  inspect. Never assume production matches staging.
- Approval is per run and verbatim. Pass the owner's exact words as the approval statement;
  an approval for one PR, run or environment never covers the next one. Merging needs the
  owner's approval and green CI on the current head.
- Do not touch another workstream's PR, branch or live members. If it is wrong, explain why
  on the PR and stop.
- Report what happened with evidence: SSM command ids, run ids, hashes, test counts. Say
  plainly what was not verified. Never present a guess as a result.
- Keep each PR to one step, and say in its body what it does not do (nothing applied, no
  release-lock change).

Before pushing, run what CI runs:
`node scripts/validate-release-locks.mjs` and
`node --experimental-strip-types --test aws/tests/*.test.mjs`
(the `*-pg` tests need PostgreSQL 16 and a non-root user).
