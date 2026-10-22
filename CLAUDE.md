@AGENTS.md

# How ChecksOps ships (Claude Code)

The rules above are enforced for Claude Code by `.claude/settings.json` and
`.claude/hooks/checksops-guard.mjs`: direct deploys are denied, edits to an existing
migration or to an applied pin's recorded evidence are refused, and so are pushes to
`main` and force pushes. `.claude/hooks/session-brief.mjs` prints the branch, its distance
from `origin/main`, the line-ending state and the installed test dependencies at the start
of every session, so a desktop session starts from the same facts a cloud session is given.

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

## Skills (the same procedures in every session)

These live in `.claude/skills/` and load on demand, by name on the desktop (`/hashes`) or
when the task matches. Use them instead of improvising:

| skill | use it when |
|---|---|
| `/guarded-step` | starting any migration, pin, inspect, apply or record work: which step, which files, which template, when to stop |
| `/hashes` | a test, validator, pin or review mentions a hash; before editing any file that records one (`node scripts/hash-report.mjs`) |
| `/ci-triage` | a check is red: root cause from the log to the bytes, and the fix the rules allow |
| `/verify` | before every push and before saying "done": run what CI runs, with the dependencies it needs |
| `/steward` | driving a PR to mergeable: conflicts, red CI, review comments, status with evidence |
| `/merge-pr` | asked to merge or to say whether a PR can be merged: the readiness lines and the merge itself |

## How to think here

- **Read, then act.** The runbook for the step, the last PR of the same kind (it is the
  template), the live state through a read-only inspect, and `node scripts/hash-report.mjs`.
  Form the theory from the bytes and the logs, not from memory of a similar case.
- **Derive, never copy.** Every hash is derived from bytes, computed by the repo's own
  functions, or observed by a run you can cite. A value out of a failing assertion is never
  typed into a pin, a test or a lock.
- **One step, one PR, one approval.** A PR does one thing and says what it does not do.
  Approval is per PR and per run, verbatim; it never carries over.
- **Stop on the first surprise.** A differing hash, a guard refusal, a failed precondition, a
  step that is not on the approved list: report it with the evidence and return to the
  owner. Never work around, retry with different inputs, or fix forward.
- **Done means verified.** Report exit codes, test counts, run ids, SSM command ids and
  hashes. Say plainly what was not verified. Never present a guess as a result.

## Working habits

- Start from a fresh `origin/main` in a new branch or worktree; never stack work on a merged
  branch or on another workstream's branch. Merge `origin/main` into a pushed branch; never
  rebase or force-push it.
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

## Windows desktop on the Ubuntu (WSL) copy

If the working directory starts with `\\wsl.localhost\` or `\\wsl$\`, Claude Desktop on
Windows has opened the copy that lives inside WSL. The files are Linux files; your shell,
git and node are Windows ones. Then:

- Read and edit files directly through that path.
- Run every shell command inside the distribution, never Windows git, node, npm or bun on
  this folder. Windows git can rewrite line endings (every pinned hash then differs), and
  Windows node fails hundreds of tests on backslash paths. Take the distribution and the
  Linux path from the working directory (`\\wsl.localhost\Ubuntu\home\carle\ChecksOps` is
  `Ubuntu` and `/home/carle/ChecksOps`):

  ```bash
  wsl -d Ubuntu -- bash -ic 'cd /home/carle/ChecksOps && <command>'
  ```

  `bash -ic` loads `~/.bashrc`, which puts node (nvm), bun and claude on PATH; `bash -lc`
  does not. Quote the inner command in single quotes and use double quotes inside it. Some
  `wsl` versions have no `--cd`, so `cd` goes inside the command.
- `sudo` needs the owner's password: ask the owner to run `apt` installs in the Ubuntu
  terminal.
- Inside the distribution the full test suite is a real signal, as in CI, apart from the
  `*-pg` tests when PostgreSQL 16 is not installed there. Run on Windows paths, it is not.
- The guard hook checks wrapped commands too: a push to main or a deploy inside
  `bash -ic '...'` is refused like an unwrapped one.

Before pushing, run what CI runs (`/verify`):
`node scripts/validate-release-locks.mjs`, `node scripts/hash-report.mjs` and
`node --experimental-strip-types --test aws/tests/*.test.mjs`
(the `*-pg` tests need PostgreSQL 16 and a non-root user).
