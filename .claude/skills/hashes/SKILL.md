---
name: hashes
description: Analyze a ChecksOps hash (source_sha256, intended_replacement_sha256, expected_live_definition_sha256, tree_hash, receipt before/after) - where it comes from, why it differs, and what the correct fix is. Use whenever a test, validator, pin or review mentions a hash, before changing any file that records one.
---

# Hashes: derive, never copy

Every hash in this repository is one of five kinds. Know which kind you are looking at before
you touch anything, because the right action differs for each.

| kind | recorded in | derived from | changes when |
|---|---|---|---|
| `source_sha256` | production pin (`ops/deployment-guard/*-production-apply.json`), staging pin (`scripts/deployment-guard/lib/sql-executor-auth.mjs`), release-lock `required_sql`, applied-migrations ledger | sha256 of the migration file bytes on an LF checkout | the file bytes change. On an applied or pinned migration this is forbidden: write a new numbered migration. |
| `intended_replacement_sha256` (and `intended_post_state.fingerprint`) | both pins | `releaseIntendedHash(key, file bytes)` in `scripts/deployment-guard/lib/release-sql-state.mjs`: the state the file leaves (function language, volatility, SECURITY DEFINER, result, proconfig, body hash, EXECUTE ACL, policies, renderings) | the file leaves a different state, or the spec in `release-sql-specs.mjs` changes. Re-derived by the executor tests on PostgreSQL 16. |
| `expected_live_definition_sha256` | both pins (`null` until an inspect) | a read-only inspect of the live database (`--inspect`, read-live, `--phase inspect`) | the live database changes. It can never be computed from code. `null` means no inspect has been recorded. |
| `tree_hash` | `ops/release-locks/locked-components.json` | `computeOwnershipHashes`: sha256 over `<rel>\0<sha256(file)>` lines of the ownership group's files in `protected-paths.json` | any file of the group changes, including a merge from main that brings someone else's change into the group. |
| receipt `before_hash` / `after_hash`, `live_definition_sha256`, tarball sha256 | `applied` records, `production_inspect`, runbooks | observed by a run | never. They are history. |

## Procedure

1. Run the report before forming a theory:

   ```bash
   node scripts/hash-report.mjs                 # every pin and every lock, with findings
   node scripts/hash-report.mjs sql109          # one migration
   node scripts/hash-report.mjs --file aws/workflows/sql/109_moov_transfer_webhook_status.sql
   node scripts/hash-report.mjs --hash <64 hex> # where it is recorded and what produces it
   ```

   It is read-only and compares the working tree, `HEAD` and `origin/main` against every pin,
   the staging pins and the release locks. Exit 1 means at least one finding needs an answer.
2. Read the first line. `core.autocrlf=true` or `crlf files>0` means the checkout is wrong, not
   the file: fix the checkout (`git config core.autocrlf false`, re-checkout) and run again.
   `behind main>0` means merge `origin/main` into the branch first: most tree-hash "drift" is a
   file someone else changed on main.
3. For each finding, name the bytes that changed and why, with `git log -p origin/main -- <file>`
   or `git diff origin/main...HEAD -- <file>`. The report tells you whether `origin/main` still
   carries the pinned bytes (then the change is yours) or differs too (then main moved).
4. Decide the action from the kind, using the table. Only then edit, and only in the PR that
   owns the change.

## Interpreting the common cases

- **Executor test says `intended_replacement_sha256` differs** after you changed a migration
  that is not yet applied anywhere: the file now leaves a different state. Update the staging
  pin, the production pin and every test that pins it in the same PR, each value derived from
  the bytes (`node -e` against `releaseIntendedHash`, or the report's `derived` column). Say in
  the PR body that the fingerprint changed and why.
- **`source_sha256` differs and the pin has an `applied` block**: the migration is history. Do
  not touch it or its pin. The fix is a new numbered migration (as SQL 103 was for SQL 29 and
  SQL 104 for SQL 91) through the guarded path. The hook refuses the edit for this reason.
- **`tree_hash` differs and `files_changed_vs_main` lists your files**: expected. Update
  `components.<id>.source.tree_hash` from `node scripts/validate-release-locks.mjs --print-hashes`
  in this PR, keep `git_sha` honest (the commit you started from, then the landing commit),
  and run `node scripts/check-pr-path-overlap.mjs --require`. Say "pending owner approval" in
  the commit if the lock change waits on the owner.
- **`tree_hash` differs and no file of the group differs from main**: the recorded hash was
  stale on main before you started. Check whether another open PR already carries the update
  (the overlap check will tell you). Do not fix someone else's lock silently; say so on the PR.
- **Two pins disagree with each other** (staging vs production `source_sha256` or intended):
  one was written from different bytes. Find which commit authored the file last
  (`git log -1 --format=%H origin/main -- <file>`); that is the staging pin's `commit`.
- **A hash you cannot produce from any file or ref**: it is a live hash (an inspect, a
  receipt) and only a run can confirm it. Read the runbook that recorded it instead.

## Never

- Never copy a hash out of a failing assertion into a pin, a test or a lock. The assertion is
  the check that caught your change; the value belongs to the bytes, so derive it from them.
- Never change `applied`, `production_evidence`, `source_sha256`, the expected or intended
  hashes, `staging_acceptance` or `production_inspect` of a pin that has an `applied` block.
- Never edit a migration under `aws/workflows/sql/` (or `aws/rls/sql/`, `aws/financial/sql/`)
  that exists on main. New number, new file, same path through staging and production.
- Never compute hashes on a CRLF checkout, and never hand-write a `tree_hash`.
