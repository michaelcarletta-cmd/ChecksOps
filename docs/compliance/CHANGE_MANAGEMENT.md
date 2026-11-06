# Change management policy

**Owner:** Michael Carletta, CEO (Qualified Individual) — security@checksops.com
**Effective:** 2026-11-06 • Matrix rows CC8.1 in `docs/compliance/SOC2_CONTROL_MATRIX.md`

This writes down, for an auditor, the rules ChecksOps already follows. The detailed procedures are
in `CLAUDE.md`, `AGENTS.md`, `ops/deployment-guard/README.md` and `ops/production-sql-one-shot.md`;
where they differ, they win.

## 1. Scope

Every change to production: application code (SPA and API), database schema, grants and data
fixes, Lambda configuration, CloudFront and WAF, IAM, network and other AWS account settings, and
the deployment tooling itself.

## 2. Normal changes

1. **Pull request.** Every change starts as a pull request against `main`. A PR does one step and
   says in its body what it does not do.
2. **Automated checks.** `release-locks`, `deployment-guard`, `aws-migration-guards` (when the
   change touches `aws/`, `src/`, `scripts/` or dependencies), CodeQL and Semgrep must pass on the
   head commit being merged.
3. **Approval.** The owner approves each merge for that PR and that head commit. An approval of one
   PR, an earlier head or a plan does not carry over. No one, person or AI agent, merges their own
   change without the owner's approval.
4. **Deployment.** Production changes are deployed only by the guarded workflows
   (`.github/workflows/guarded-*.yml`) or the production SQL one-shot. Direct deploys are refused by
   the deployment guard; a hand-written receipt is rejected as forged.
5. **Database and Lambda changes** follow the guarded path: staging read-live and apply, read-only
   production inspect, a pin PR the owner merges, a production apply with the owner's exact
   approval words for that run, and a record PR (`CLAUDE.md`).
6. **Append-only history.** Migrations that exist on `main` are never edited; a fix is a new
   numbered migration. Recorded evidence of an applied change is never edited (`AGENTS.md`).
7. **Testing.** Staging acceptance is required before production for every database and Lambda
   change. Production is never assumed to match staging: it is read before each change.

## 3. AWS account changes outside the guarded workflows

Some account settings have no guarded workflow (for example the November 2026 hardening and the
database subnet move). For those:

1. A runbook PR states the read-only pre-check, the change, the verification and the rollback, and
   is merged before anything runs.
2. Each step runs only on the owner's go phrase for that step, either by the owner in CloudShell
   or by an agent the phrase names.
3. The result is recorded afterwards in the runbook's "Applied" section: who, when, the CloudTrail
   event or request id, and the verified after state.

## 4. Emergency changes

An emergency change is one needed to stop an active security incident, data loss or an outage, that
cannot wait for the normal path.

1. **Who may.** Only the owner, or someone the owner authorizes for that incident by name.
2. **Minimum.** Make the smallest change that contains the problem. Do not fix forward beyond
   containment.
3. **Record within 2 business days.** A PR that records what was changed, why, when, by whom, the
   CloudTrail event, and how it was verified, linked from the incident's post-mortem
   (`docs/incidents/YYYY-MM-DD.md`).
4. **Reconcile.** If the change left production different from `main`, a normal PR brings `main`
   in line, or reverts the change, within 5 business days.
5. **Review.** Every emergency change is listed in the quarterly change sample (evidence calendar
   row C-1).

## 5. Segregation of duties

ChecksOps is small. The control is that every change is visible in a pull request, checked by
automated tests and approved by the owner, and that AI agents cannot approve or merge on their own
judgment. Where the author and the approver are the same person, the quarterly change sample
(row C-1) is the compensating review. **OWNER TO CONFIRM** whether a second reviewer, an advisor or
the auditor-recommended compensating control is used as headcount grows.

## 6. Branch protection

`main` requires the checks in §2 and a pull request; direct pushes are refused (also by the guard
hook in `.claude/hooks/checksops-guard.mjs`). **OWNER TO CONFIRM** the GitHub ruleset settings and
export them each quarter (row C-2).
