---
name: guarded-step
description: Run one step of the ChecksOps guarded database or Lambda path - staging read-live and apply, read-only production inspect, pin PR, production apply through the one-shot, record-and-retire PR - with the files, commands, template and stop conditions for that step. Use before starting any migration, pin, inspect, apply or record work.
---

# One guarded step at a time

Every database or Lambda change is a sequence of reviewed PRs, one per step, each waiting for
the owner's explicit approval of that run. Start every step from a fresh branch off
`origin/main`, read the runbook and the last PR of the same kind (it is the template), and
read the live state through a read-only inspect. Never assume production matches staging.

## Which step am I on?

```bash
node scripts/hash-report.mjs <key>      # pins, execute, applied, staging acceptance, expected live
gh pr list --search "<key>" --state all --limit 10
```

| step | the pin says | this PR does | this PR does not |
|---|---|---|---|
| 0. New migration | no pin yet | adds `aws/workflows/sql/<next>_<name>.sql` (next free number; check open PRs for a collision, SQL 107 became SQL 109 that way), its spec in `release-sql-specs.mjs`, its staging pin in `sql-executor-auth.mjs`, its production pin, tool, runbook `ops/production-sql-<n>-apply.md`, tests, and registers it in `ONE_SHOT_TOOLS` and the staging workflow choice | apply anything; set `execute` |
| 1a. Staging read-live | staging pin `expected_live_definition_sha256: null` | runs `guarded-staging-sql-executor.yml` read-live for the choice; records nothing in git | change pins |
| 1b. Staging pin + apply | read-live reported `already_applied false`, `precondition_failures []` | records the read-live `LIVE_DEFINITION_SHA256` as the staging pin's `expected_live_definition_sha256`, an owner-approved `authorization`, `execute: true` (reviewed PR); after the owner merges, the staging apply run with the owner's approval of that run; then read-live again (`already_applied true`) | touch production |
| 2. Production inspect | production pin `production_inspect.status: pending` | runs the tool's `--inspect` or the one-shot `--phase inspect` on the runner (read-only, no approval); keeps the SSM command id and the JSON | write anything |
| 3. Pin PR | inspect recorded | records `production_inspect` (date, SSM command id, source commit, `live_definition_sha256`, `precondition_failures`, `apply_preconditions_met`), copies `live_definition_sha256` into `expected_live_definition_sha256`, records `staging_acceptance` (`ok: true`, run references, basis), sets an owner-approved `authorization` and `execute: true`. The owner reviews and merges it. | apply |
| 4. Production apply | pin merged with `execute: true`, staged by the transfer workflow | the transfer run; `production-sql-one-shot.mjs --migration <key> --approval-scope <key> ... --phase inspect`, then the owner-named `--phase apply` with the owner's exact words as `--approval-statement` (`ops/production-sql-one-shot.md`) | change git |
| 5. Record PR | apply succeeded | adds the `applied` block from the run's `details.applied` plus the SSM command id and transfer run id, sets `execute: false`, appends the ledger `apply_evidence` row and any `sql_prerequisites` note; updates the runbook and the one-shot runbook's pin list | change any recorded evidence, hash or `source_sha256` |

Lambda and SPA steps follow the same shape with their own plans and runbooks:
`ops/lambda-configuration-change.md`, `ops/production-lambda-rebuild.md`,
`ops/production-spa-deploy.md`, `ops/deployment-guard/README.md`.

## Before opening the PR for a step

- Branch: `git fetch origin main && git checkout -b claude/<step-name> origin/main`.
- Template: `git log --oneline origin/main -- ops/deployment-guard/<previous-pin>.json` and
  read that PR's diff. Match its fields, wording and body sections.
- Hashes: every value you write is derived (`/hashes`), observed by a run you cite, or copied
  from the staging pin that already pins it. Nothing is typed from memory.
- Tests: the pin's `tooling.tests` list, `aws/tests/production-sql-one-shot.test.mjs`,
  `aws/tests/production-sql-inspect-hygiene.test.mjs`, then `/verify`.
- Body: what this step does, the evidence (run ids, SSM ids, hashes, test counts), what it
  does not do ("nothing applied", "no release-lock change", "execute stays false"), and the
  next step.

## Stop and return to the owner when

- a hash differs from the plan (source, tarball, live pre-state, after-state);
- a guard refuses (`DEPLOYMENT_COLLISION`, `SOURCE_RECONCILIATION_REQUIRED`,
  `SOURCE_COMPOSITION_REQUIRED`, `SQL_COLLISION`, `PRODUCTION_APPROVAL_REQUIRED`, any code);
- an inspect reports `precondition_failures` other than `[]`, a missing predecessor, or
  `already_applied` where it should be false;
- anything is not on the approved list: a new step, a changed command, a different target.

A stop is never worked around, retried with different inputs, or fixed forward.

## Never

- Never edit a migration that exists on main; a fix is a new number.
- Never apply SQL by hand, in any environment.
- Never set `execute: true` and apply in the same PR, or carry one approval into another run.
- Never hand-write a receipt, a manifest or an `applied` block the run did not print.
