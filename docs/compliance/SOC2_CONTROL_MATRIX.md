# SOC 2 control matrix

**Owner:** Michael Carletta, CEO (Qualified Individual, `docs/WISP.md` §1) — security@checksops.com
**Drafted:** 2026-11-06, from the repository on main `69e9eb96`
**Status:** readiness draft. No auditor has reviewed it, and no SOC 2 report exists yet.

This maps the 2017 Trust Services Criteria (revised points of focus, 2022) to the ChecksOps control
that meets each one and to the record that proves it. It is the working list for a readiness review
with a CPA firm. It changes nothing in AWS, the database or the application.

**Proposed scope.** Security (common criteria, required), Availability and Confidentiality.
Processing Integrity is listed in §PI as optional. A SOC 1 may also be asked for by customers whose
auditors rely on ChecksOps for payment records; decide that separately.

**System boundary.** Production AWS account `806168576068`, `us-east-1`: CloudFront and WAF, the SPA,
API Gateway and the Lambda API, Cognito pool `us-east-1_h00WorYMT`, RDS `checksops-production`,
the production S3 buckets and KMS keys, the SQL runner `i-0c35557c4e5385406`, and the GitHub
repository with its workflows. Carved out (their own SOC reports cover them): AWS, Moov, CheckAlt,
GitHub, the email provider and OpenAI. See CC9.2.

## How to read the status column

| Status | Meaning |
|---|---|
| **In place** | The control exists and the repository holds a dated record of it working. |
| **Partial** | The control exists, but part of it is missing or the record does not cover a whole period. |
| **Gap** | A policy promises it, or SOC 2 expects it, and there is no control or no record. |
| **Verify** | The repository says one thing; live state has not been read since. Read it before the auditor does. |

Every recurring control has a row in `docs/compliance/EVIDENCE_CALENDAR.md`, which says how often it
runs and where its dated record goes. A Type II audit tests that record over the whole observation
period.

## CC1 — Control environment

| ID | Control | Evidence | Status |
|---|---|---|---|
| CC1.1 | Written information security program, reviewed at least annually | `docs/WISP.md` (last reviewed 2026-10-21); git history of the file | Partial: the WISP still describes Supabase and Lovable. The AWS rewrite is a separate PR. |
| CC1.2 | Named security owner who reports on the program | WISP §1, §7: the Qualified Individual delivers a written annual report | Partial: 2026 report drafted (`docs/compliance/QI_ANNUAL_REPORT_2026.md`, 2026-11-06); in place once the Qualified Individual signs it. The owner is also the CEO, so the report goes to the board, or is self-certified if there is no board. |
| CC1.3 | Roles and responsibilities for security and operations | WISP §1; `docs/INCIDENT_RESPONSE.md` §2 roles; `CLAUDE.md` / `AGENTS.md` for changes made through AI agents | In place |
| CC1.4 | Hiring, background checks, onboarding and offboarding | `docs/compliance/PERSONNEL_SECURITY.md` (adopted 2026-11-06) | Partial: policy written; no records yet of checks, agreements or acknowledgments. |
| CC1.5 | Security training at onboarding and annually; phishing tests twice a year | WISP §3.11 says HR keeps records | Gap: no training record. Start the record (calendar row T-1, T-2). |

## CC2 — Communication and information

| ID | Control | Evidence | Status |
|---|---|---|---|
| CC2.1 | System description and data inventory | WISP §3.2 and §3.6; `aws/production/LIVE_RESOURCES.md`; this file's system boundary | Partial: draft in `docs/compliance/SYSTEM_DESCRIPTION.md`; headcount and contract commitments still OWNER TO CONFIRM. |
| CC2.2 | Internal communication of policies and of how changes ship | `CLAUDE.md`, `AGENTS.md`, `ops/deployment-guard/README.md`, the runbooks in `ops/` | In place |
| CC2.3 | External communication: privacy notice, security contact, status | `src/pages/PrivacyNotice.tsx`, acknowledgments in `privacy_notice_acknowledgments`; WISP acknowledgment in `tenants.wisp_acknowledged_at`; `/status.json` notices (`ops/status-notice.md`); security@checksops.com | Partial: the annual January privacy-notice email (WISP §8) has no record yet. |

## CC3 — Risk assessment

| ID | Control | Evidence | Status |
|---|---|---|---|
| CC3.1–3.2 | Written risk assessment, at least annually and after material change | WISP §2 describes it | Partial: first assessment drafted after the move to AWS (`docs/compliance/RISK_REGISTER.md`, 2026-11-06, 12 risks); in place once the owner approves it (row R-1). |
| CC3.3 | Fraud risk | `docs/ACH_RISK_FRAUD_MONITORING.md`, `docs/AML_PROGRAM.md` | In place (policy). Its own recurring reviews go in the calendar (row R-3). |
| CC3.4 | Risk from changes: vendors, architecture, people | WISP §5; per-change runbooks in `ops/` and `aws/cutover/` | Partial: covered for infrastructure changes, not for vendor or staffing changes. |

## CC4 — Monitoring activities

| ID | Control | Evidence | Status |
|---|---|---|---|
| CC4.1 | Continuous configuration monitoring against a benchmark | Security Hub (AWS Foundational Security Best Practices), AWS Config recorder `checksops-production-config-items`, Inspector (EC2, ECR, Lambda, Lambda code), GuardDuty (`aws/cutover/OPERATOR_SECURITY_HANDOFF_2TO6.md`; `ops/security/AWS_ACCOUNT_HARDENING_2026_11.md`) | In place |
| CC4.1 | Annual third-party penetration test; vulnerability assessment every six months | WISP §4 | Gap: no report on file. Book one before the Type II window starts (row V-2). |
| CC4.2 | Deficiencies tracked to closure | The hardening runbook records each finding, the change, the CloudTrail event and the after state (`AWS_ACCOUNT_HARDENING_2026_11.md` "Applied"; `RDS_PRIVATE_SUBNETS_PLAN_2026_11.md` "Applied") | In place for November 2026. Keep a monthly Security Hub snapshot (row V-1). |

## CC5 — Control activities

| ID | Control | Evidence | Status |
|---|---|---|---|
| CC5.1–5.2 | Controls chosen for the risks; technology general controls | The CC6–CC8 rows below | See below |
| CC5.3 | Policies put into practice through procedures | Runbooks for each production step (`ops/production-sql-*.md`, `ops/production-sql-one-shot.md`); the guard hook `.claude/hooks/checksops-guard.mjs` | In place |

## CC6 — Logical and physical access

| ID | Control | Evidence | Status |
|---|---|---|---|
| CC6.1 | Tenant isolation in the database | Postgres row-level security scoped to `tenant_id`; tenant-scope migrations (for example SQL 87, 88, 125, 126, 136) with production apply records in `ops/deployment-guard/sql*-production-apply.json` | In place |
| CC6.1 | Encryption at rest | RDS storage encrypted (`RDS_PRIVATE_SUBNETS_PLAN_2026_11.md` live state); private-files bucket default SSE-S3 (`AES256`, SSE-C blocked), with compliance documents written SSE-KMS under `alias/checksops-production-compliance-documents` (`ops/production-files-bucket-encryption.md`, Bucket Key change applied 2026-11-04; read live 2026-11-08); Moov onboarding EIN and date of birth KMS-encrypted (`aws/functions/api/providers/onboarding/crypto.mjs`) | In place |
| CC6.1 | Sensitive fields masked; every reveal logged | `src/components/ui/masked-field.tsx`, `src/hooks/usePIIMasking.tsx`, `pii_reveal_logs`; CheckAlt account numbers returned as last four only (`aws/functions/api/providers/checkalt-account-mask.mjs`) | In place |
| CC6.2 | Users added and removed through a controlled process | Invites through the API (Cognito admin create only: `ops/deployment-guard/cognito-admin-create-only`); two-factor reset with global sign-out (`aws/functions/api/admin-reset-totp.mjs`, `ops/team-two-factor-reset-iam.md`) | Partial: offboarding within 24 hours is now written (`docs/compliance/PERSONNEL_SECURITY.md` §5); no records yet (row A-2). |
| CC6.3 | Least privilege for people and machine identities | Per-workflow GitHub OIDC roles (`ops/deployment-guard/github-oidc-trust`); read-only inspect role; `ops/security/IAM_CLAUDE_CODE_LEAST_PRIVILEGE.md` | Partial: confirm the least-privilege change for `user/claude-code` is applied and record it. |
| CC6.3 | Quarterly access review of tenant member lists, platform owner accounts and AWS identities (every tenant member has full access within the tenant; there are no roles to review) | WISP §3.1; `docs/compliance/evidence/2026-11-06-A-1-access-review.md` | Partial: first review prepared 2026-11-06 (13 production users, 2 Identity Center admins, 1 IAM user, 30 IAM roles, 1 GitHub collaborator; 8 roles flagged as unused); in place once the owner signs it off and the decided removals are made (row A-1). |
| CC6.1 | Login MFA required for every user | WISP §3.1. Sign-in is a Cognito email code or passkey, then an authenticator-app (TOTP) code: `aws/functions/api/login-mfa.mjs` refuses every signed-in request until this sign-in has passed the code (`financial_stepup_log`, action `login.mfa`), and the sign-in screen (`src/components/auth/LoginMfaGate.tsx`) enrolls users who have no authenticator. Code: PR #1657; production overlay runs 42283495148, 42284228921, 42284721201; website upload 42285187951. Switch: `AWS_LOGIN_MFA_REQUIRED` `"true"`, staging run 42283026717 (owner tested: "staging MFA works"), production run 42293184319 (#1664, record #1667). Financial actions keep their own TOTP step-up (SQL 97, 106, 129–133). | In place since 2026-11-06 21:01 UTC: read back from the production API configuration as `"true"` (50 variables, RevisionId `eb9f5362`). The Cognito pool's own `MfaConfiguration` stays `OPTIONAL` by design (Cognito cannot require MFA with email-code sign-in); the application enforces it. |
| CC6.1 | Root account protected | GuardDuty `Policy:IAMUser/RootCredentialUsage`, recurring since 2026-09-07 (owner's CloudShell use); a separate admin login `michael-admin` exists | Partial: root MFA confirmed 2026-11-06 (`AccountMFAEnabled` = 1). Still to do: stop day-to-day use of root (use `michael-admin`). |
| CC6.6 | Network perimeter | CloudFront with WAF `checksops-production-cloudfront-waf` (`ops/security/SH1_ACCEPTED_PRODUCTION_BASELINE.md`); RDS not publicly accessible and only in private subnets (`RDS_PRIVATE_SUBNETS_PLAN_2026_11.md`, applied 2026-11-03); account-wide S3 Block Public Access and EBS snapshot block (hardening items 3c, 4); empty default security group (item 5) | In place |
| CC6.7 | Encryption in transit; browser security headers | TLS through CloudFront; response headers policy `checksops-production-browser-security-headers`; CSP (`ops/deployment-guard/PRODUCTION_CSP_HEADERS.md`, `ops/security/SPA_CSP_ROLLOUT.md`) | In place |
| CC6.8 | Malicious and unauthorized software | Inspector (Lambda code on), GuardDuty malware protection for EC2, CodeQL (`.github/workflows/codeql.yml`), SQL runner patching (hardening item 7) | In place; the runner needs a patch cadence (row V-3). |
| CC6.4 | Physical access | Inherited from AWS (carved out) | Inherited |

## CC7 — System operations

| ID | Control | Evidence | Status |
|---|---|---|---|
| CC7.1 | Audit logging of the cloud account | CloudTrail `checksops-production-mgmt-events`: multi-region, log-file validation on, into `checksops-production-security-logs-806168576068` (`aws/cutover/OPERATOR_SECURITY_SERVICES.md`); VPC flow log `fl-0913268bc96a95205` | In place: retention matches `docs/DATA_RETENTION.md` §2 since 2026-11-06 (security-logs bucket 7 years, Glacier after 90 days; every log group has a retention; `ops/security/LOG_RETENTION_AND_DR_2026_11.md`). |
| CC7.2 | Application audit logging | `audit_logs`, `pii_reveal_logs`, `glba_security_events`, `check_audit_log`, `check_status_audit`, `deposit_audit_log`, `payment_event_log`, `financial_stepup_log` (append-only, SQL 106), `aws_provider_webhook_receipts` | In place |
| CC7.2 | Alerts reach a person | 14 CloudWatch security alarms to SNS `checksops-production-security-alerts`, subscription confirmed (`OPERATOR_SECURITY_HANDOFF_2TO6.md`) | In place. Record a test alert once a year (row I-3). |
| CC7.3–7.4 | Incident response plan; post-mortems | `docs/INCIDENT_RESPONSE.md`, `aws/cutover/INCIDENT_RESPONSE_AWS.md`; post-mortems due in `docs/incidents/YYYY-MM-DD.md`; tabletop scenario `docs/compliance/INCIDENT_TABLETOP_2026.md` | Partial: `docs/incidents/` does not exist yet; the tabletop is written, not yet held (row I-1). |
| CC7.5 | Recovery from incidents | `aws/cutover/INCIDENT_RESPONSE_AWS.md` §9 (point-in-time restore to a new instance), `aws/cutover/ROLLBACK.md` | Partial: no recorded restore test (row B-1). |

## CC8 — Change management

| ID | Control | Evidence | Status |
|---|---|---|---|
| CC8.1 | Every production change through a reviewed PR | One PR per step, the owner's verbatim approval per run, staging acceptance before production (`CLAUDE.md`; `ops/production-sql-one-shot.md`); pin and record files per change (`ops/deployment-guard/sql*-production-apply.json`) | In place |
| CC8.1 | Direct deploys blocked | Deployment guard (`ops/deployment-guard/README.md`, `bypass-inventory.json`, receipts); guarded workflows in `.github/workflows/guarded-*.yml`; the Claude Code hook refuses pushes to main and force pushes | In place |
| CC8.1 | Automated checks before merge | `aws-migration-ci.yml`, `release-locks.yml`, `deployment-guard.yml`, `tax-profile-migration-guard.yml`, `codeql.yml` | In place |
| CC8.1 | Branch protection on `main` (required review, required checks) | Configured in GitHub, not in the repository | **Verify**: export the branch protection or ruleset settings and keep them as evidence (row C-2). |
| CC8.1 | Migrations and applied evidence are append-only | `AGENTS.md` rules; hash pins checked by `scripts/hash-report.mjs` and `scripts/validate-release-locks.mjs` | In place |
| CC8.1 | Emergency changes | AWS account changes made by the owner in CloudShell are recorded after the fact in the runbook's "Applied" section with CloudTrail events | In place (policy): `docs/compliance/CHANGE_MANAGEMENT.md` §3–4. No emergency change recorded under it yet. |

## CC9 — Risk mitigation and vendors

| ID | Control | Evidence | Status |
|---|---|---|---|
| CC9.1 | Business continuity and disaster recovery | `docs/compliance/BCP_DR.md`; Multi-AZ RDS (primary 1f, standby 1a), 35-day backups, deletion protection; private-files bucket versioning on; `aws/cutover/WRITE_FREEZE_DRILL.md` | Partial: targets written; database backups replicated to `us-east-2` since 2026-11-06. Private-files bucket copied to `us-east-2` since 2026-11-09 (1,592 versions, 0 failed; `ops/security/FILES_BUCKET_REPLICATION_2026_11.md` "Applied"); the KMS-encrypted compliance documents are phase 2. Backup person named (Austin Sukanick); access not yet set up. No restore test yet. |
| CC9.2 | Vendor inventory, contracts and annual review | WISP §3.6 vendor table | Gap: collect each vendor's SOC 2 report and the contract addendum, and record an annual review (row S-1). The WISP still marks Moov and CheckAlt addenda "OWNER TO CONFIRM". |
| CC9.2 | Complementary user-entity controls | `docs/compliance/SYSTEM_DESCRIPTION.md` §5 | Partial: drafted; to be reflected in tenant terms. |

## A1 — Availability

| ID | Control | Evidence | Status |
|---|---|---|---|
| A1.1 | Capacity and health monitoring | CloudWatch alarms; API Gateway 5xx and Lambda error metrics (`SH1_ACCEPTED_PRODUCTION_BASELINE.md` acceptance gate) | Partial: no documented capacity review. |
| A1.2 | Backups and protection against loss | RDS automated backups 35 days with point-in-time restore, encrypted, deletion protection on; WAF | In place |
| A1.3 | Recovery tested | `ops/security/RESTORE_TEST_RUNBOOK.md` (restore to a new instance, read-only data check, delete, record template) | Gap until the first run: runbook ready 2026-11-08; the owner runs it by 2027-01-31 (row B-1). |

## C1 — Confidentiality

| ID | Control | Evidence | Status |
|---|---|---|---|
| C1.1 | Confidential data identified and protected | WISP §3.2; masking and reveal logging (CC6.1); private buckets with signed URLs only | In place |
| C1.2 | Confidential data disposed of on schedule | `docs/DATA_RETENTION.md` names the Supabase edge function `glba-retention-purge` as the nightly purge. `aws/providers/EDGE_FUNCTION_INVENTORY.md` lists it as not ported to AWS. | **Gap**: no automated purge runs on AWS. Either build it through the guarded path or change the policy to a documented manual purge, and record each run (row D-1). |

## PI — Processing integrity (optional)

| ID | Control | Evidence | Status |
|---|---|---|---|
| PI1.2–1.4 | Payment inputs are complete, accurate and processed once | Payment idempotency keys (SQL 104); webhook receipts once per verified event (`aws_provider_webhook_receipts`); Moov transfer status from webhooks (SQL 109); restrictive money-write policies (SQL 136) | In place, if Processing Integrity is put in scope |
| PI1.5 | Records reconciled with providers | `ops/live-api-reconciliation-2026-10-21.md`, `ops/checkalt-status-reconcile-schedule.md` | Partial: make the reconciliation recurring and recorded. |

## Gaps to close before a Type II window starts

In rough order of audit risk:

1. **Retention purge does not run on AWS** (C1.2). Since #1648 the policy says so, and that until
   it is rebuilt each purge is an approved one-off. No closed claim is due before about 2032.
2. ~~Login MFA is optional~~ closed 2026-11-06 (see Closed).
3. ~~Log retention~~ closed 2026-11-06 (see Closed).
4. **No records yet for the recurring controls** (CC1.5, CC4.1, CC7.4, A1.3): start them from
   `docs/compliance/EVIDENCE_CALENDAR.md`. The risk register (CC3.1), the first access review
   (CC6.3) and the QI report (CC1.2) were drafted 2026-11-06 and wait for the owner's sign-off.
   Route to the audit: `docs/compliance/AUDIT_READINESS_PLAN.md`.
5. **Files copied outside `us-east-1`** (CC9.1) since 2026-11-09, except the KMS-encrypted compliance documents (phase 2). The database is, since 2026-11-06.
6. **Root account** in daily use (CC6.1). Root MFA is on (confirmed 2026-11-06).
7. **Vendor SOC reports and addenda** not on file (CC9.2).
8. **Documents drafted 2026-11-06, to adopt and keep records for**: personnel security, BCP/DR,
   change management with the emergency rule, system description with complementary user-entity
   controls.

Closed:
- **Login MFA** (CC6.1): required for every user since 2026-11-06 21:01 UTC (production configuration
  run 42293184319), enforced by the application after the email-code or passkey sign-in.
- **Log retention** (CC7.1): matches the policy since 2026-11-06.
- **Policies out of date for AWS** (CC1.1): WISP and data retention rewritten, #1648 (2026-11-06).
- **Security Hub** (CC4.1): 2026-11-06 18:16 UTC, 0 active CRITICAL/HIGH findings; RDS.46 PASSED for
  `checksops-production` and `checksops-staging`. Keep the monthly snapshot (row V-1).

## Not covered here

- No AWS, database or application change.
- No choice of auditor or compliance tool. The matrix is in plain Markdown so it can be imported
  into one.
