---
name: verify
description: Run what ChecksOps CI runs, locally and before every push - the release-lock validator, the hash report, the overlap check, and the tests that cover the files in the diff - with the dependency setup each needs. Use before pushing, before declaring a change done, and after merging origin/main.
---

# Verify before you push

Done means verified. Run the checks CI runs, read their output, and report counts and exit
codes, not impressions.

## 0. Dependencies (once per checkout)

```bash
bun install --frozen-lockfile          # root; vite build, bun run scripts
npm ci --prefix aws/functions/api      # the API runtime the aws/tests load
sudo apt-get install -y poppler-utils  # signature placement tests (Linux); brew install poppler (macOS)
```

The `*-pg` tests need PostgreSQL 16 reachable as a non-root user; they skip with a reason when
it is absent. A skipped `-pg` test is not a pass: say so in the report when the diff touches
SQL, the release engine or a tool that applies it.

## 1. Always

```bash
node scripts/validate-release-locks.mjs
node scripts/hash-report.mjs
node scripts/check-pr-path-overlap.mjs --require     # needs gh signed in; CI sets GH_TOKEN
```

All three must exit 0. A non-zero exit is a finding to resolve (`/hashes`, `/ci-triage`), never
a number to update.

## 2. The tests for the diff

```bash
git diff --name-only origin/main...HEAD
```

| diff touches | run |
|---|---|
| anything under `aws/`, `scripts/`, `src/`, `package.json`, `bun.lock` | `node --experimental-strip-types --test aws/tests/*.test.mjs` (the whole suite; it is what `aws-migration-guards` runs) |
| a migration, pin, spec or production tool | the pin's `tooling.tests` list, `aws/tests/production-sql-one-shot.test.mjs`, `aws/tests/production-sql-inspect-hygiene.test.mjs`, plus the whole suite |
| `ops/release-locks/**`, `scripts/lib/release-locks.mjs`, the lock scripts | `node --test ops/release-locks/tests/*.test.mjs`, `node scripts/production-deploy-guard.mjs` |
| `.claude/**`, `CLAUDE.md`, `AGENTS.md`, `.gitattributes` | `node --test aws/tests/claude-checksops-guard-hook.test.mjs aws/tests/claude-session-brief.test.mjs aws/tests/hash-report.test.mjs` |
| `supabase/security/**`, tax-profile migrations | `npm run check:tax-profile-migrations` and the three `supabase/security` test scripts in `package.json` |
| frontend (`src/**`) | `bun run lint`, `bun run build:aws` |

The full suite is long; run it in the background and keep working, but do not push before
it finishes. Read the tail: `# pass`, `# fail`, `# skipped`. Any `fail` blocks the push. Any
`skipped` in a file that covers the diff is reported by name.

## 3. Re-read the diff adversarially

```bash
git diff origin/main...HEAD --stat
git diff origin/main...HEAD
```

Ask: which test pins a value I changed? Which protected group did I touch? Did a merge from
main move a tree hash? Is every hash in the diff derived or observed, never typed? Does the
PR do one step only? Fix what you find before pushing.

## 4. Report

State, with numbers: validator exit code, hash report summary line, test totals (pass, fail,
skipped) and which files skipped, lint and build results if run. State plainly what was not
verified (no PostgreSQL, no `gh` login, suite still running). Then push:

```bash
git push -u origin <branch>
```
