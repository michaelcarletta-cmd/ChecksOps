# ChecksOps Written Information Security Program (WISP)

**Effective date:** 2026-01-01  
**Owner / Qualified Individual:** Michael Carletta, CEO — security@checksops.com  
**Last reviewed:** 2026-11-06 (rewritten for production on AWS)  
**Review cadence:** Annually, or after any material change

This document satisfies the FTC Safeguards Rule (16 CFR Part 314) and Gramm-Leach-Bliley Act (15 U.S.C. §§ 6801–6809) obligations for ChecksOps. It is also the security policy for the SOC 2 control matrix (`docs/compliance/SOC2_CONTROL_MATRIX.md`). The schedule and records for the recurring controls below are in `docs/compliance/EVIDENCE_CALENDAR.md`.

Production runs in AWS account `806168576068`, region `us-east-1` (`docs/AWS_MIGRATION.md`, `aws/production/LIVE_RESOURCES.md`). Statements marked **OWNER TO CONFIRM** have not been checked against live AWS since this rewrite.

---

## 1. Designation of Qualified Individual

Michael Carletta, CEO, is the Qualified Individual. He oversees, implements and enforces this WISP. Because the Qualified Individual is also the CEO, the annual written report (§7) goes to the board of directors. If there is no board, the Qualified Individual signs the report and keeps it with the compliance records.

## 2. Risk Assessment

A written risk assessment is performed at least annually and after any material change. The move of production from Supabase and Lovable to AWS (2026) is a material change, and the first assessment under this version is due by 2026-12-31 (evidence calendar row R-1). The assessment covers:

- Customer information collected, processed, stored and transmitted
- Foreseeable internal and external threats (unauthorized access, insider misuse, vendor breach, ransomware, phishing, credential theft)
- Sufficiency of the safeguards in place to control the identified risks
- Re-evaluation of vendor risk

## 3. Safeguards in Place

### 3.1 Access Controls
- **Tenant isolation, no roles inside a tenant** (owner policy, confirmed 2026-11-06): every member of a tenant (company) has the same full access to that tenant's data and actions, money movement included (`aws/functions/api/privileged-auth.mjs`). The boundary is the tenant: Postgres row-level security scoped to `tenant_id` on RDS `checksops-production` keeps each tenant's members out of every other tenant's data. Because no one inside a tenant is limited, the controls that carry the weight are MFA for every member, prompt removal of leavers, and the tenant's quarterly review of its member list.
- Sign-in through Amazon Cognito (pool `us-east-1_h00WorYMT`) with an email one-time code or a passkey (WebAuthn)
- **Multi-factor authentication for every user:** required by this policy. **Not met today.** Read live 2026-11-06 18:16 UTC: the production Cognito pool `us-east-1_h00WorYMT` (13 users) has `MfaConfiguration` `OPTIONAL`, so sign-in does not require a second factor for any role. **Decision (owner, 2026-11-06): MFA for every user.** Cognito cannot require MFA while users sign in with an email code, so the application will require an authenticator-app code (TOTP) after every email-code sign-in, reusing the existing TOTP enrollment; a passkey with user verification counts as MFA on its own. It ships as a code change through staging first; until then this control is not met.
- Financial actions (wallet funding, disbursements, bank changes, CheckAlt deposit submit and approve) need an application-level TOTP step-up, recorded in `financial_stepup_log`, with rate limiting and lockout (SQL 97, 106, 129–133)
- Administrators can reset a teammate's two-factor, which also signs that teammate out everywhere (`aws/functions/api/admin-reset-totp.mjs`)
- Quarterly access reviews of every tenant's member list and the platform owner accounts, Cognito users, AWS IAM users and roles, and GitHub collaborators (evidence calendar row A-1)
- Access removed within 24 hours of a person leaving (row A-2)
- AWS root account: MFA on, and not used for day-to-day work. Daily administration uses a named admin login. Root MFA confirmed on 2026-11-06 (IAM account summary `AccountMFAEnabled` = 1). GuardDuty has recorded root CloudShell use since 2026-09-07; that day-to-day use should move to the named admin login.
- Machine access is least privilege: each GitHub workflow assumes its own OIDC role (`ops/deployment-guard/github-oidc-trust`), and the AI-agent IAM user is limited per `ops/security/IAM_CLAUDE_CODE_LEAST_PRIVILEGE.md`
- 4-digit PINs for the client portal are rate-limited and scoped to a single claim

### 3.2 Data Inventory and Classification
- Consumer PII fields are masked by default in the application (`src/hooks/usePIIMasking.tsx`, `src/components/ui/masked-field.tsx`); every reveal is logged to `pii_reveal_logs`
- Full bank routing and account numbers entered for Moov are sent to Moov and not kept by ChecksOps; ChecksOps keeps the bank name and last four digits (`payment_provider_methods`, `stakeholder_accounts.provider_last_four`) (`aws/functions/api/providers/onboarding/handlers.mjs`)
- Moov onboarding PII: EIN and representative date of birth are stored KMS-encrypted; the SSN is sent to Moov and only its last four digits are kept (`aws/functions/api/providers/onboarding/crypto.mjs`, `store.mjs`)
- CheckAlt deposit account numbers are kept in `checkalt_tenant_accounts` and returned to browsers as the last four digits only (`aws/functions/api/providers/checkalt-account-mask.mjs`)
- Check images, endorsement packets and tenant documents are stored in the production private-files bucket `checksops-production-privatefiles-806168576068`

### 3.3 Encryption
- **In transit:** TLS for all traffic, terminated at CloudFront (SPA and API) with the browser security headers policy `checksops-production-browser-security-headers` and a Content Security Policy (`ops/security/SH1_ACCEPTED_PRODUCTION_BASELINE.md`, `ops/deployment-guard/PRODUCTION_CSP_HEADERS.md`)
- **At rest:** RDS storage encrypted with KMS; the private-files bucket encrypted with SSE-KMS (`ops/production-files-bucket-encryption.md`, applied 2026-11-04); Moov onboarding fields encrypted with KMS at the application layer (§3.2)
- **Storage:** S3 Block Public Access is on for the account and for every bucket (`ops/security/AWS_ACCOUNT_HARDENING_2026_11.md` item 3). Files are served to browsers through short-lived signed URLs only.
- **Secrets:** API keys, provider credentials and database credentials are in AWS Secrets Manager under `checksops/<environment>/…`, read by the API at run time. Never in source.

### 3.4 Network Security
- CloudFront with AWS WAF `checksops-production-cloudfront-waf` in front of the SPA and the API
- RDS is not publicly accessible and runs only in the two private subnets (`ops/security/RDS_PRIVATE_SUBNETS_PLAN_2026_11.md`, applied 2026-11-03); its security group admits Postgres only from the production Lambda group and the SQL runner group
- The SQL runner `i-0c35557c4e5385406` sits in a private subnet, is reached only through SSM, and is stopped between runs
- The default security group has no rules; EBS snapshot public sharing and SSM document public sharing are blocked (hardening items 2, 4, 5)

### 3.5 Secure Development and Change Management
- Every change ships through a reviewed pull request on GitHub. Production changes to the database, Lambdas, the SPA and CloudFront go through the guarded workflows only (`.github/workflows/guarded-*.yml`, `ops/deployment-guard/README.md`); direct deploys are refused by the deployment guard.
- Database and Lambda changes follow the guarded path: staging apply, read-only production inspect, a pin PR approved by the owner, a production apply with the owner's verbatim approval for that run, and a record PR (`CLAUDE.md`, `ops/production-sql-one-shot.md`). Migrations and recorded evidence are append-only (`AGENTS.md`).
- Automated checks before merge: `aws-migration-ci.yml`, `release-locks.yml`, `deployment-guard.yml`, `tax-profile-migration-guard.yml`, CodeQL and Semgrep
- Branch protection on `main` requires those checks and a review. **OWNER TO CONFIRM**, and export the settings each quarter (row C-2).
- Changes to AWS account settings that no guarded workflow covers (for example the November 2026 hardening) need the owner's explicit go phrase for that step and are recorded afterwards, with the CloudTrail event, in the runbook's "Applied" section.

### 3.6 Vendor Management
Written addenda and an annual security review (SOC 2 report or questionnaire) on file for each vendor (evidence calendar row S-1):

| Vendor | Purpose | Data |
|---|---|---|
| Amazon Web Services | Hosting: CloudFront, API Gateway, Lambda, Cognito, RDS, S3, KMS, Secrets Manager, logging | All customer data |
| Moov | ACH payments (wallet funding, disbursements, fee collection), bank verification, tenant KYC/KYB | Business profile and EIN; representative name, address, DOB, SSN, contact details; compliance documents; bank routing/account numbers; recipient names and emails; transfer amounts; IP address and user agent at terms acceptance |
| CheckAlt (FinCapture) | Remote check deposit | Check front/rear images, deposit amounts, tenant deposit account number, depositor name and email |
| Microsoft Azure (Document Intelligence) | Check OCR (`prebuilt-check.us`) | Check images and the fields read from them |
| Resend | Transactional email (endorsement and payee-setup email) | Recipient email and message content |
| OpenAI | AI inference, only for tenants who add their own API key (stored per tenant in Secrets Manager) | Claim text the tenant sends |
| GitHub | Source code, CI, deployment workflows | Source and configuration; no customer data |

- **Supabase / Lovable:** the previous hosting. The old Supabase project remains only for the temporary migration bridges, which are read-only or sign-only, until the teardown in `aws/cutover/BRIDGE_TEARDOWN.md`. **OWNER TO CONFIRM** the teardown date and what customer data remains in that project. Remove this row once it is torn down.
- **Retired:** Actum Processing, Plaid and QuickBooks were retired in October 2026 and are no longer vendors; their historical tables remain in the database (`docs/ACH_RISK_FRAUD_MONITORING.md` §1). Tavily and Mailgun are not called by the AWS API.
- **OWNER TO CONFIRM:** written addenda on file for Moov, CheckAlt, Azure and Resend.

### 3.7 Logging and Monitoring
**Cloud account**
- CloudTrail trail `checksops-production-mgmt-events`: all regions, management events, log-file validation on, delivered to `checksops-production-security-logs-806168576068`
- AWS Config recorder `checksops-production-config-items`; Security Hub with AWS Foundational Security Best Practices; GuardDuty; Inspector (EC2, ECR, Lambda and Lambda code); VPC flow log `fl-0913268bc96a95205`
- 14 CloudWatch security alarms notify SNS `checksops-production-security-alerts`, delivered to support@checksops.com (`aws/cutover/OPERATOR_SECURITY_HANDOFF_2TO6.md`)
- Security Hub, GuardDuty and Inspector findings reviewed monthly (row V-1)

**Application** (in the production database)
- `audit_logs` — all privileged actions
- `pii_reveal_logs` — every masked-field reveal
- `glba_security_events` — admin overrides, exports, retention purges, incidents
- `check_audit_log`, `check_status_audit`, `deposit_audit_log` — financial workflow
- `payment_event_log`, `payment_transfers` — Moov account, bank and transfer events; `checkalt_deposits` — CheckAlt deposit attempts and status
- `financial_stepup_log` — financial two-factor step-ups (server-written only, append-only; SQL 97, 106)
- `aws_provider_webhook_receipts` — every signature-verified Moov and CheckAlt webhook, once per event

**Retention:** audit logs are kept 7 years (`docs/DATA_RETENTION.md` §2). Confirmed 2026-11-06: the security-logs bucket keeps CloudTrail and Config 7 years (Glacier after 90 days) and every CloudWatch log group has a retention set (`ops/security/LOG_RETENTION_AND_DR_2026_11.md`).

### 3.8 Secure Disposal
See `docs/DATA_RETENTION.md`. Default retention is 7 years after claim closure, configurable per tenant via `tenants.data_retention_years`. The automated purge from the Supabase era has not been rebuilt on AWS; `docs/DATA_RETENTION.md` §4 says what applies until it is.

### 3.9 Backups and Availability
- RDS `checksops-production` is Multi-AZ (primary `us-east-1f`, standby `us-east-1a`), with automated backups kept 35 days, point-in-time restore, and deletion protection on
- Recovery follows `aws/cutover/INCIDENT_RESPONSE_AWS.md` §9: restore to a new instance, never over the live one
- A restore test is run and recorded once a year (row B-1)

### 3.10 Incident Response
See `docs/INCIDENT_RESPONSE.md` (notification roles) and `aws/cutover/INCIDENT_RESPONSE_AWS.md` (AWS playbooks). A tabletop exercise is run annually (row I-1), and every incident gets a post-mortem in `docs/incidents/YYYY-MM-DD.md` within 14 days.

- Detection → Containment → Eradication → Recovery → Post-mortem
- **Notification:** FTC notified within 30 days for breaches involving ≥ 500 consumers; affected consumers notified per applicable state law (often 30–60 days)
- Contact: security@checksops.com

### 3.11 Employee Training
- Security and privacy training required at onboarding and annually (row T-1)
- Phishing simulation at least twice per year (row T-2)
- Completion records kept in the compliance records (not in this repository)

## 4. Continuous Monitoring or Penetration Testing
- **Continuous monitoring:** Security Hub, AWS Config, GuardDuty and Inspector (§3.7); CodeQL and Semgrep on every pull request
- **Penetration test:** annual third-party engagement (row V-2)
- **Vulnerability assessments:** at minimum every 6 months and after material changes; the SQL runner is patched monthly and on any critical Inspector finding (row V-3)

## 5. Service Provider Oversight
- Each provider listed in §3.6 is reviewed annually
- New providers are gated by a security questionnaire before contract signature
- Provider access and credentials are revoked within 24 hours of contract termination

## 6. Plan Evaluation and Adjustment
This WISP is reviewed at least annually and whenever the risk assessment changes materially (row R-2). Updates are tracked in git history.

## 7. Reporting
The Qualified Individual delivers a written report at least annually (row R-4) to the board, or self-certifies it as described in §1. It covers:
- Overall status of the information security program
- Material matters: risk assessment, risk management, testing results, security events, vendor arrangements, recommendations for change

## 8. Privacy Notices
- Initial privacy notice presented at customer onboarding (the `/privacy-notice` page, `src/pages/PrivacyNotice.tsx`)
- Annual privacy notice delivered by email each January (row P-1)
- Acknowledgments tracked in `privacy_notice_acknowledgments`

## 9. Payments Compliance (ACH / AML / WEB Debit)

ChecksOps moves ACH payments through Moov and deposits checks through CheckAlt, under a documented risk-based framework:

- **ACH Risk and Fraud Monitoring Policy** — `docs/ACH_RISK_FRAUD_MONITORING.md` (satisfies the NACHA rule effective 2026-06-22).
- **AML / BSA Program** — `docs/AML_PROGRAM.md` (KYC, monitoring, SAR filing, training, independent review).
- **WEB Debit Rule compliance** — Moov bank verification (micro-deposit code, at most 3 attempts) through the `moov-micro-deposit-initiate` / `moov-micro-deposit-confirm` handlers, recorded in `payment_method_verifications`; debits use only Moov's `ach-debit-fund` method for verified banks. The older `micro_deposit_verifications` table is dormant. Documented in ACH policy §2.
- **Financial two-factor** — wallet funding, disbursements, bank changes and CheckAlt deposit submit/approve need a financial TOTP code once per login, recorded in `financial_stepup_log` (ACH policy §3.2).
- **Non-custodial model** — ChecksOps never holds, pools, or routes customer funds through a ChecksOps-owned account (only ChecksOps' own fees reach the ChecksOps platform Moov wallet); this is the basis for the current money-transmitter-license position and must be preserved (ACH policy §7).

---

**Acknowledgment of this WISP** is tracked per tenant in `tenants.wisp_acknowledged_at` / `wisp_acknowledged_by`.
