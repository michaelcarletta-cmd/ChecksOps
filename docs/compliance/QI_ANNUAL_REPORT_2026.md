# Qualified Individual's annual report on the information security program, 2026

**From:** Michael Carletta, CEO, Qualified Individual (`docs/WISP.md` §1)
**To:** the board of directors. If there is no board, this report is self-certified as WISP §1 allows.
**Period:** the program year ending 2026-11-06 (first report under the AWS version of the WISP)
**Status:** draft prepared 2026-11-06 for the Qualified Individual to review, edit and sign. It is
the R-4 record once signed. Matrix row CC1.2. Required by the FTC Safeguards Rule
(16 CFR 314.4(i)) and WISP §7.

## 1. Overall status of the program

The program covers the ChecksOps production system on AWS (`docs/compliance/SYSTEM_DESCRIPTION.md`).
In 2026 production moved from Supabase and Lovable to AWS. The WISP, the data retention policy and
the supporting policies were rewritten for AWS (#1648), and Supabase and Lovable were shut down
(`ops/supabase-project-shutdown.md`). A SOC 2 readiness effort started on 2026-11-06, with a control
matrix (`docs/compliance/SOC2_CONTROL_MATRIX.md`) and an evidence calendar
(`docs/compliance/EVIDENCE_CALENDAR.md`).

Overall: **the core technical safeguards are in place. The recurring records an auditor will sample
are only starting now.** The program is ready for a CPA readiness review
(`docs/compliance/AUDIT_READINESS_PLAN.md`), not yet for a Type I report.

## 2. Material matters

### Risk assessment and risk management

The first risk assessment under the AWS WISP is `docs/compliance/RISK_REGISTER.md` (2026-11-06).
The highest residual risks are:

- **key-person dependency (R9):** the named backup person, Austin Sukanick, has no access yet;
- **tenant isolation (R2)** and **administrator compromise (R3):** no third-party test yet, day-to-day
  root use, and no branch protection on `main`;
- **vendor oversight (R8)** and **dependency vulnerabilities (R11).**

The previous top risk, sign-in without a second factor (R1), was treated during the period (see the
next section).

### Safeguards added or strengthened in 2026

- **Login MFA for every user (2026-11-06):** every sign-in now needs an authenticator-app code, and
  users without one enroll at their next sign-in. Shipped through staging, tested by the owner
  ("staging MFA works"), then switched on in production (guarded configuration run 42293184319,
  read back as `"true"`).
- **AWS account hardening (November 2026):** Security Hub reduced to 0 active CRITICAL/HIGH findings
  (2026-11-06); databases moved to private subnets; S3 Block Public Access account-wide; the
  private-files bucket encrypted with KMS (`ops/security/AWS_ACCOUNT_HARDENING_2026_11.md`).
- **Log retention matched to policy:** security logs kept 7 years, every log group has a retention
  (`ops/security/LOG_RETENTION_AND_DR_2026_11.md`).
- **Disaster recovery:** database backups copied to `us-east-2` (replicating since 2026-11-06).
- **Change control:** every production change goes through a reviewed PR and a guarded workflow with
  the owner's approval per run (`docs/compliance/CHANGE_MANAGEMENT.md`).

### Testing results

- Continuous monitoring: Security Hub, GuardDuty, Inspector, AWS Config, CodeQL and Semgrep are on.
  Security Hub had 0 active CRITICAL/HIGH findings on 2026-11-06.
- No third-party penetration test has been done yet. One is planned before the Type II window (row V-2).
- No backup restore test has been recorded yet (row B-1, due 2027-01-31).

### Security events

**QUALIFIED INDIVIDUAL TO CONFIRM.** No post-mortem is on file (`docs/incidents/` does not exist), and
the repository records no security incident affecting tenant data in the period. GuardDuty has
recorded root CloudShell use by the owner since 2026-09-07. That is expected activity, not an
incident, but it is a practice to stop (R3).

### Service provider arrangements

The providers are AWS, Moov, CheckAlt, Microsoft Azure (OCR), Resend and GitHub
(`SYSTEM_DESCRIPTION.md` §4). Their SOC reports and the Moov and CheckAlt contract addenda are not
yet on file (row S-1, due 2026-12-31).

## 3. Recommendations for change

1. Give the backup person (Austin Sukanick) AWS, GitHub and inbox access, and walk him through the
   incident runbook.
2. Book a third-party penetration test, including cross-tenant testing.
3. Turn on branch protection on `main` and keep its export as evidence (row C-2).
4. Stop day-to-day use of the AWS root account; use the Identity Center admin sign-in.
5. Start the recurring records: quarterly access review (first one prepared 2026-11-06,
   `docs/compliance/evidence/2026-11-06-A-1-access-review.md`), training and phishing tests, the
   monthly Security Hub snapshot, and vendor reviews.
6. Run and record a database restore test.
7. Copy the private-files bucket outside `us-east-1`.
8. Decide how retention purges run on AWS: rebuild the automated purge, or document a manual purge.
9. Engage a CPA firm for a SOC 2 readiness review (`docs/compliance/AUDIT_READINESS_PLAN.md`).

## 4. Certification

I have reviewed the information security program described in `docs/WISP.md` and this report.

Signed: ______________________ Michael Carletta, CEO, Qualified Individual    Date: __________

Board acknowledgment (if there is a board): ______________________    Date: __________
