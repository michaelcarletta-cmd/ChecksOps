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
| CC1.2 | Named security owner who reports on the program | WISP §1, §7: the Qualified Individual delivers a written annual report | Gap: no annual report on file. The owner is also the CEO, so the report goes to the board, or is self-certified if there is no board. |
| CC1.3 | Roles and responsibilities for security and operations | WISP §1; `docs/INCIDENT_RESPONSE.md` §2 roles; `CLAUDE.md` / `AGENTS.md` for changes made through AI agents | In place |
| CC1.4 | Hiring, background checks, onboarding and offboarding | none | Gap: write an HR security policy (background checks, confidentiality agreements, offboarding checklist). |
| CC1.5 | Security training at onboarding and annually; phishing tests twice a year | WISP §3.11 says HR keeps records | Gap: no training record. Start the record (calendar row T-1, T-2). |

## CC2 — Communication and information

| ID | Control | Evidence | Status |
|---|---|---|---|
| CC2.1 | System description and data inventory | WISP §3.2 and §3.6; `aws/production/LIVE_RESOURCES.md`; this file's system boundary | Partial: the auditor needs one system description (SOC 2 "Section III"). Draft it from these. |
| CC2.2 | Internal communication of policies and of how changes ship | `CLAUDE.md`, `AGENTS.md`, `ops/deployment-guard/README.md`, the runbooks in `ops/` | In place |
| CC2.3 | External communication: privacy notice, security contact, status | `src/pages/PrivacyNotice.tsx`, acknowledgments in `privacy_notice_acknowledgments`; WISP acknowledgment in `tenants.wisp_acknowledged_at`; `/status.json` notices (`ops/status-notice.md`); security@checksops.com | Partial: the annual January privacy-notice email (WISP §8) has no record yet. |

## CC3 — Risk assessment

| ID | Control | Evidence | Status |
|---|---|---|---|
| CC3.1–3.2 | Written risk assessment, at least annually and after material change | WISP §2 describes it | Gap: no assessment on file. The move to AWS is a material change. Write a risk register (calendar row R-1). |
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
| CC6.1 | Encryption at rest | RDS storage encrypted (`RDS_PRIVATE_SUBNETS_PLAN_2026_11.md` live state); private-files bucket SSE-KMS (`ops/production-files-bucket-encryption.md`, applied 2026-11-04); Moov onboarding EIN and date of birth KMS-encrypted (`aws/functions/api/providers/onboarding/crypto.mjs`) | In place |
| CC6.1 | Sensitive fields masked; every reveal logged | `src/components/ui/masked-field.tsx`, `src/hooks/usePIIMasking.tsx`, `pii_reveal_logs`; CheckAlt account numbers returned as last four only (`aws/functions/api/providers/checkalt-account-mask.mjs`) | In place |
| CC6.2 | Users added and removed through a controlled process | Invites through the API (Cognito admin create only: `ops/deployment-guard/cognito-admin-create-only`); two-factor reset with global sign-out (`aws/functions/api/admin-reset-totp.mjs`, `ops/team-two-factor-reset-iam.md`) | Partial: no written offboarding procedure with a time limit. |
| CC6.3 | Least privilege for people and machine identities | Per-workflow GitHub OIDC roles (`ops/deployment-guard/github-oidc-trust`); read-only inspect role; `ops/security/IAM_CLAUDE_CODE_LEAST_PRIVILEGE.md` | Partial: confirm the least-privilege change for `user/claude-code` is applied and record it. |
| CC6.3 | Quarterly access review of admin, staff and AWS identities | WISP §3.1 | Gap: no review on file. First review this quarter (row A-1). |
| CC6.1 | Login MFA required for admin and staff | WISP §3.1 and the public security page (`src/pages/checkops/CheckOpsSecurity.tsx`) both say so. On AWS, login is Cognito EMAIL_OTP or passkey (WebAuthn); the docs record the pool's MFA setting as OFF (`aws/cutover/COGNITO_PRODUCTION_TRANSITION.md`). Financial actions require an app-level TOTP step-up (`financial_stepup_log`, SQL 97, 106, 129–133). | **Verify**: read the production pool's MFA configuration. If MFA is not required for admin and staff, either enforce it or correct the WISP and the public page. |
| CC6.1 | Root account protected | GuardDuty `Policy:IAMUser/RootCredentialUsage`, recurring since 2026-09-07 (owner's CloudShell use); a separate admin login `michael-admin` exists | Gap: record that root has MFA, and stop day-to-day use of root (use `michael-admin`). |
| CC6.6 | Network perimeter | CloudFront with WAF `checksops-production-cloudfront-waf` (`ops/security/SH1_ACCEPTED_PRODUCTION_BASELINE.md`); RDS not publicly accessible and only in private subnets (`RDS_PRIVATE_SUBNETS_PLAN_2026_11.md`, applied 2026-11-03); account-wide S3 Block Public Access and EBS snapshot block (hardening items 3c, 4); empty default security group (item 5) | In place |
| CC6.7 | Encryption in transit; browser security headers | TLS through CloudFront; response headers policy `checksops-production-browser-security-headers`; CSP (`ops/deployment-guard/PRODUCTION_CSP_HEADERS.md`, `ops/security/SPA_CSP_ROLLOUT.md`) | In place |
| CC6.8 | Malicious and unauthorized software | Inspector (Lambda code on), GuardDuty malware protection for EC2, CodeQL (`.github/workflows/codeql.yml`), SQL runner patching (hardening item 7) | In place; the runner needs a patch cadence (row V-3). |
| CC6.4 | Physical access | Inherited from AWS (carved out) | Inherited |

## CC7 — System operations

| ID | Control | Evidence | Status |
|---|---|---|---|
| CC7.1 | Audit logging of the cloud account | CloudTrail `checksops-production-mgmt-events`: multi-region, log-file validation on, into `checksops-production-security-logs-806168576068` (`aws/cutover/OPERATOR_SECURITY_SERVICES.md`); VPC flow log `fl-0913268bc96a95205` | In place |
| CC7.2 | Application audit logging | `audit_logs`, `pii_reveal_logs`, `glba_security_events`, `check_audit_log`, `check_status_audit`, `deposit_audit_log`, `payment_event_log`, `financial_stepup_log` (append-only, SQL 106), `aws_provider_webhook_receipts` | In place |
| CC7.2 | Alerts reach a person | 14 CloudWatch security alarms to SNS `checksops-production-security-alerts`, subscription confirmed (`OPERATOR_SECURITY_HANDOFF_2TO6.md`) | In place. Record a test alert once a year (row I-3). |
| CC7.3–7.4 | Incident response plan; post-mortems | `docs/INCIDENT_RESPONSE.md`, `aws/cutover/INCIDENT_RESPONSE_AWS.md`; post-mortems due in `docs/incidents/YYYY-MM-DD.md` | Partial: `docs/incidents/` does not exist yet, and there is no tabletop record (row I-1). |
| CC7.5 | Recovery from incidents | `aws/cutover/INCIDENT_RESPONSE_AWS.md` §9 (point-in-time restore to a new instance), `aws/cutover/ROLLBACK.md` | Partial: no recorded restore test (row B-1). |

## CC8 — Change management

| ID | Control | Evidence | Status |
|---|---|---|---|
| CC8.1 | Every production change through a reviewed PR | One PR per step, the owner's verbatim approval per run, staging acceptance before production (`CLAUDE.md`; `ops/production-sql-one-shot.md`); pin and record files per change (`ops/deployment-guard/sql*-production-apply.json`) | In place |
| CC8.1 | Direct deploys blocked | Deployment guard (`ops/deployment-guard/README.md`, `bypass-inventory.json`, receipts); guarded workflows in `.github/workflows/guarded-*.yml`; the Claude Code hook refuses pushes to main and force pushes | In place |
| CC8.1 | Automated checks before merge | `aws-migration-ci.yml`, `release-locks.yml`, `deployment-guard.yml`, `tax-profile-migration-guard.yml`, `codeql.yml` | In place |
| CC8.1 | Branch protection on `main` (required review, required checks) | Configured in GitHub, not in the repository | **Verify**: export the branch protection or ruleset settings and keep them as evidence (row C-2). |
| CC8.1 | Migrations and applied evidence are append-only | `AGENTS.md` rules; hash pins checked by `scripts/hash-report.mjs` and `scripts/validate-release-locks.mjs` | In place |
| CC8.1 | Emergency changes | AWS account changes made by the owner in CloudShell are recorded after the fact in the runbook's "Applied" section with CloudTrail events | Partial: write down the emergency-change rule (who may, what must be recorded, by when). |

## CC9 — Risk mitigation and vendors

| ID | Control | Evidence | Status |
|---|---|---|---|
| CC9.1 | Business continuity and disaster recovery | Multi-AZ RDS (primary 1f, standby 1a), 35-day backups, deletion protection, `aws/cutover/WRITE_FREEZE_DRILL.md` | Gap: no BCP/DR document with recovery time and recovery point targets. |
| CC9.2 | Vendor inventory, contracts and annual review | WISP §3.6 vendor table | Gap: collect each vendor's SOC 2 report and the contract addendum, and record an annual review (row S-1). The WISP still marks Moov and CheckAlt addenda "OWNER TO CONFIRM". |
| CC9.2 | Complementary user-entity controls | none | Gap: list what tenants must do themselves (manage their own users, protect devices). Goes in the system description. |

## A1 — Availability

| ID | Control | Evidence | Status |
|---|---|---|---|
| A1.1 | Capacity and health monitoring | CloudWatch alarms; API Gateway 5xx and Lambda error metrics (`SH1_ACCEPTED_PRODUCTION_BASELINE.md` acceptance gate) | Partial: no documented capacity review. |
| A1.2 | Backups and protection against loss | RDS automated backups 35 days with point-in-time restore, encrypted, deletion protection on; WAF | In place |
| A1.3 | Recovery tested | none | Gap: restore the latest backup into a new instance once a year and record the time taken (row B-1). |

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

1. **Retention purge does not run on AWS** (C1.2), although the policy and the WISP say it runs
   nightly.
2. **Login MFA**: the policy and the public security page say MFA is required for admin and staff;
   confirm against the live Cognito pool (CC6.1).
3. **Policies out of date for AWS** (CC1.1): WISP and data retention. Separate PR.
4. **No records yet for the recurring controls** (CC1.5, CC3.1, CC4.1, CC6.3, CC7.4, A1.3): start
   them from `docs/compliance/EVIDENCE_CALENDAR.md`.
5. **Root account** in daily use; MFA not recorded (CC6.1).
6. **Missing documents**: HR security policy, BCP/DR with recovery targets, emergency change rule,
   system description, complementary user-entity controls.
7. **Vendor SOC reports and addenda** not on file (CC9.2).
8. **Security Hub**: zero active CRITICAL/HIGH findings has not been confirmed since the 2026-11-03
   production database move. RDS.46 for `checksops-production` had not re-evaluated at 17:01 UTC
   that day. Record a snapshot (row V-1).

## Not covered here

- No AWS, database or application change.
- No choice of auditor or compliance tool. The matrix is in plain Markdown so it can be imported
  into one.
