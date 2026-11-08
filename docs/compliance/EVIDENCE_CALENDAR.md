# SOC 2 evidence calendar

**Owner:** Michael Carletta, CEO (Qualified Individual) — security@checksops.com
**Started:** 2026-11-06

A Type II auditor samples each recurring control across the observation period and asks for the
record of each occurrence. This file is the schedule and the index of those records. The control IDs
are from `docs/compliance/SOC2_CONTROL_MATRIX.md`.

## Where records go

- **In this repository** (`docs/compliance/evidence/YYYY-MM-DD-<row>.md`): records with no personal
  data and no secrets. Examples: a Security Hub count, a restore test's timings, a tabletop summary.
- **Outside the repository**, in the restricted compliance folder (or the compliance tool, once one
  is chosen): anything with people's names or emails, vendor reports under NDA, the pen test
  report, training completions. Add a line to the log below with the date and where it is stored,
  never the content itself.

Each record says: date, who did it, what was checked, the result, and the follow-up (if any) with
its PR or ticket.

## Schedule

| Row | Control (matrix ID) | How often | What the record shows | Next due |
|---|---|---|---|---|
| 2026-11-06 | CC7.1, CC9.1 | Owner (CloudShell); verified by Claude read-only 18:56 UTC | Log retention to policy and database backups to `us-east-2`: `ops/security/LOG_RETENTION_AND_DR_2026_11.md` "Applied" |
| V-1 | Security Hub, GuardDuty and Inspector review (CC4.1, CC4.2) | Monthly | Count of active CRITICAL and HIGH findings per source, each open one with an owner and a target date | 2026-11-30 |
| V-2 | Third-party penetration test (CC4.1) | Annually | Report (stored outside), findings and their fixes | Before the Type II window starts |
| V-3 | SQL runner OS patching (CC6.8) | Monthly, and on any CRITICAL Inspector finding | Before and after kernel and release versions, SSM command ids (as in hardening item 7) | 2026-12-02 |
| A-1 | Access review: app admin and staff users, Cognito users, IAM users and roles, GitHub collaborators (CC6.2, CC6.3) | Quarterly | Who was reviewed, who was removed, date signed off | 2026-12-31 |
| A-2 | Offboarding: access removed within 24 hours (CC6.2) | Each departure | Date of departure, date each access was removed | As it happens |
| C-1 | Production changes went through a reviewed PR (CC8.1) | Quarterly sample | 5 merged PRs from the quarter: PR link, reviewer or owner approval, green checks, run id | 2026-12-31 |
| C-2 | Branch protection on `main` unchanged (CC8.1) | Quarterly | Export of the branch protection or ruleset settings | 2026-12-31 |
| I-1 | Incident response tabletop (CC7.3–7.4) | Annually | Scenario, attendees, gaps found, follow-up PRs | 2027-01-31 |
| I-2 | Post-mortem for every incident (CC7.4) | Within 14 days of each incident | `docs/incidents/YYYY-MM-DD.md` | As it happens |
| I-3 | Alert path test (CC7.2) | Annually | A test alarm reached `checksops-production-security-alerts` and the inbox | 2026-12-31 |
| B-1 | Backup restore test (A1.3, CC7.5) | Annually | Point-in-time restore to a new instance, time taken, row-count check, instance deleted after | 2027-01-31 |
| D-1 | Retention purge ran (C1.2) | Each run, plus the quarterly sample of 5 purged claims (`docs/DATA_RETENTION.md` §7) | Counts purged; sample result | After the AWS purge exists |
| R-1 | Risk assessment and risk register (CC3.1–3.2) | Annually and after material change | Register with likelihood, impact, owner and treatment | 2026-12-31 (the move to AWS is a material change) |
| R-2 | WISP and policy review (CC1.1) | Annually | PR updating `docs/WISP.md` and related policies | 2027-10-21 |
| R-3 | ACH fraud and AML program reviews (CC3.3) | As those programs require | Per `docs/ACH_RISK_FRAUD_MONITORING.md` and `docs/AML_PROGRAM.md` | Per those documents |
| R-4 | Qualified Individual's written report (CC1.2) | Annually | Report covering WISP §7 topics | 2027-01-31 |
| S-1 | Vendor review: SOC 2 report or questionnaire, contract addendum (CC9.2) | Annually per vendor | One line per vendor: report period, exceptions noted, date reviewed | 2026-12-31 |
| T-1 | Security and privacy training (CC1.5) | At hire and annually | Completion per person (stored outside) | 2026-12-31 |
| T-2 | Phishing simulation (CC1.5) | Twice a year | Date, click rate, follow-up | 2027-03-31 |
| P-1 | Annual privacy notice sent (CC2.3) | Each January | Send date and recipient count | 2027-01-31 |

## Log

Newest first. Records that already exist from before this calendar are listed so the period has a
starting point.

| Date (UTC) | Row | Who | Record |
|---|---|---|---|
| 2026-11-08 | V-1 | Claude (read-only); owner to sign | November monthly review: `docs/compliance/evidence/2026-11-08-V-1-monthly-security-review.md`. Security Hub, GuardDuty, Inspector 0 critical and 0 high; 118 medium and 32 low Security Hub controls grouped with decisions; dependencies 0 high (xlsx replaced, #1675) |
| 2026-11-08 | B-1, I-1, CC9.1 | Claude (documents) | Ready for the owner to run: restore test `ops/security/RESTORE_TEST_RUNBOOK.md`, tabletop `docs/compliance/INCIDENT_TABLETOP_2026.md`, files bucket copy to `us-east-2` `ops/security/FILES_BUCKET_REPLICATION_2026_11.md` |
| 2026-11-06 | V-1 (R11) | Claude (`npm audit` on every lockfile); owner to sign | Dependency triage: `docs/compliance/evidence/2026-11-06-V-1-dependency-triage.md`. 13 open alerts (2 high, 7 moderate, 4 low), 0 in the production API. 2 reach users (`xlsx`, fix by 2026-11-30), 5 patch fixes, 6 build-only accepted |
| 2026-11-06 | R-1, R-4 | Claude (draft) | Risk register `docs/compliance/RISK_REGISTER.md` and Qualified Individual's report `docs/compliance/QI_ANNUAL_REPORT_2026.md` drafted; each becomes the record once the owner signs it |
| 2026-11-06 | A-1 | Claude (read-only, `user/claude-code`); owner to sign | First access review prepared: `docs/compliance/evidence/2026-11-06-A-1-access-review.md` (counts); the named list was given to the owner for the restricted folder |
| 2026-11-06 | CC6.1 | Owner approval; guarded workflows | Login MFA required for every user: production configuration run 42293184319 at 21:01 UTC (staging run 42283026717, owner-tested), read back `AWS_LOGIN_MFA_REQUIRED` `"true"`; record #1667 |
| 2026-11-06 | CC9.1 | Claude (read-only) | 19:58 UTC: `us-east-2` automated backup replication for `checksops-production` is `replicating`, restore window 19:02–19:43 UTC |
| 2026-11-06 | CC7.1, CC9.1 | Claude (read-only, `user/claude-code`) | 18:20 UTC: security-logs bucket lifecycle expires after 365 days, versioning on, no Object Lock; CloudTrail log group 365 days; 319 of 325 log groups never expire; private-files bucket versioning on, no replication; no AWS Backup plans; RDS Multi-AZ, 35-day backups, no cross-region backup replication. Recorded in the matrix and `docs/compliance/BCP_DR.md` |
| 2026-11-06 | V-1, CC6.1 | Claude (read-only, `user/claude-code`) | 18:16 UTC: Security Hub 0 active CRITICAL/HIGH; RDS.46 PASSED for both databases; root `AccountMFAEnabled` = 1; Cognito pool `us-east-1_h00WorYMT` `MfaConfiguration` `OPTIONAL` (13 users). Recorded in `docs/compliance/SOC2_CONTROL_MATRIX.md` and `docs/WISP.md` §3.1 |
| 2026-11-04 | CC6.1 | Owner | Private-files bucket SSE-KMS applied: `ops/production-files-bucket-encryption.md` "Applied" |
| 2026-11-03 | V-1 | Claude (read-only) | Security Hub read after hardening: `ops/security/AWS_ACCOUNT_HARDENING_2026_11.md` "Security Hub, read-only, 2026-11-03 06:45" |
| 2026-11-03 | CC6.6 | Owner | Production and staging databases moved to private subnets: `ops/security/RDS_PRIVATE_SUBNETS_PLAN_2026_11.md` "Applied" |
| 2026-11-02 | V-3 | Claude through SSM | SQL runner patched to Amazon Linux 2023.12.20261102: hardening runbook item 7 |
| 2026-11-02 | CC4.2 | Owner and Claude | Hardening items 1–5 and 8 applied: hardening runbook "Applied" |
