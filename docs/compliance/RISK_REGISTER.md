# Risk assessment and risk register

**Owner:** Michael Carletta, CEO (Qualified Individual) — security@checksops.com
**Assessment date:** 2026-11-06 (first assessment under `docs/WISP.md` §2; evidence calendar row R-1)
**Trigger:** material change — production moved from Supabase and Lovable to AWS in 2026
**Status:** draft prepared from the repository and read-only AWS reads (`user/claude-code`). It
counts as the R-1 record once the owner approves it (sign-off at the end).
**Matrix rows:** CC3.1, CC3.2, CC3.4, CC9.1 in `docs/compliance/SOC2_CONTROL_MATRIX.md`

## 1. Method

- **Scope:** the system in `docs/compliance/SYSTEM_DESCRIPTION.md` §3, which covers the production AWS
  account `806168576068`, the GitHub repository and its workflows, the people who operate it, and
  the vendors in §4 of that file.
- **Information assets:** the data listed in `SYSTEM_DESCRIPTION.md` §3 "Data". The most sensitive
  are bank details and Moov onboarding identity data (EIN, date of birth, SSN last four), check
  images, homeowner and payee contact details, and the ability to move money.
- **Likelihood** (1–5): 1 rare, 2 unlikely, 3 possible, 4 likely, 5 almost certain within a year.
- **Impact** (1–5): 1 negligible, 2 minor (one tenant, no data exposure), 3 moderate (one tenant's
  data or funds exposed, or a day of downtime), 4 major (several tenants, or a reportable breach),
  5 severe (cross-tenant exposure, loss of funds at scale, or loss of the payment partners).
- **Inherent risk** = likelihood × impact before the controls; **residual** = the same after the
  controls in place today. Residual 12 or more is **high** and needs a treatment with a date; 6–11
  is **medium** (treat or accept, with the owner's name on the decision); 5 or less is **low**.
- **Treatment:** mitigate, transfer (insurance or a vendor), avoid, or accept.
- Reviewed at least annually and after any material change (`docs/WISP.md` §2, §6).

## 2. Register

| # | Risk | Assets | L×I inherent | Controls in place (evidence) | L×I residual | Treatment, owner, date |
|---|---|---|---|---|---|---|
| R1 | A tenant user's sign-in is taken over (stolen email account, phishing) and used to read data or move money. Every tenant member has full access, money included. | All tenant data; funds in the tenant's Moov wallet | 4×5 = 20 | Login MFA for every user since 2026-11-06: an authenticator code after every sign-in (`aws/functions/api/login-mfa.mjs`, production config run 42293184319); financial TOTP step-up for money actions (`financial_stepup_log`); Moov bank verification; alerts | 2×4 = 8 | **Mitigate.** Tenants review their member lists quarterly (CUEC 3). Track first-week support requests about MFA. Owner, 2026-12-31. |
| R2 | A defect in tenant isolation exposes one tenant's data to another. | All tenant data | 3×5 = 15 | Postgres row-level security on `tenant_id`; tenant-scope migrations with production apply records; CI test suites, including the `*-pg` RLS matrices; CodeQL and Semgrep | 2×5 = 10 | **Mitigate.** The penetration test (V-2) includes cross-tenant testing. Owner, before the Type II window. |
| R3 | An owner or administrator credential to AWS or GitHub is compromised. | The whole platform | 3×5 = 15 | Root MFA on; Identity Center admin sign-in; CloudTrail with alarms to SNS; GuardDuty; least-privilege OIDC roles per workflow; the deployment guard refuses direct deploys | 2×5 = 10 | **Mitigate.** Stop day-to-day root use (GuardDuty records root CloudShell use); turn on branch protection on `main`; confirm whether both Identity Center admin users are needed (access review 2026-Q4). Owner, 2026-12-31. |
| R4 | A bad change (code, SQL or configuration) breaks production or corrupts data. | Availability; data integrity | 4×4 = 16 | One reviewed PR per step, staging first, the owner's verbatim approval per production run, hash pins and append-only migrations (`docs/compliance/CHANGE_MANAGEMENT.md`); point-in-time restore | 2×4 = 8 | **Mitigate.** Run and record the restore test (B-1) to prove the 4-hour recovery target. Owner, 2027-01-31. |
| R5 | ACH fraud: a payee's bank details are changed or a fraudulent disbursement is approved. | Tenant and homeowner funds | 3×4 = 12 | Moov bank verification; financial TOTP step-up for disbursements and bank changes; `docs/ACH_RISK_FRAUD_MONITORING.md`; tenants check payee details (CUEC 4) | 2×4 = 8 | **Mitigate.** Continue the program reviews (R-3). |
| R6 | Confidential data is kept longer than the retention policy allows. | Claim, check and homeowner records | 3×3 = 9 | `docs/DATA_RETENTION.md`; no closed claim reaches its purge date before about 2032 | 1×3 = 3 | **Mitigate before it matters:** decide between rebuilding the automated purge on AWS and a recorded manual purge (matrix C1.2, row D-1). Owner, 2027-06-30. |
| R7 | Loss of `us-east-1`: a region outage or an account-level event. | Availability; the files | 2×5 = 10 | Database backups copied to `us-east-2` since 2026-11-06 (status `replicating`); Multi-AZ RDS; code in GitHub | 2×4 = 8 for files, 1×4 = 4 for the database | **Mitigate:** copy the private-files bucket outside `us-east-1` (matrix CC9.1). **Accept** a multi-hour region recovery time meanwhile (owner decision needed below). |
| R8 | A key vendor (Moov, CheckAlt, Azure OCR, Resend, AWS) is breached or unavailable. | Bank and identity data held by Moov; deposits; email | 3×4 = 12 | Carve-out vendors with their own SOC reports; the vendor table in WISP §3.6; status notices to tenants (`ops/status-notice.md`) | 3×3 = 9 | **Mitigate:** collect each vendor's SOC 2 report and contract addendum, and record the annual review (S-1). Owner, 2026-12-31. |
| R9 | Key-person dependency: one person approves changes and administers AWS. | Availability; incident response | 4×4 = 16 | Backup person named (Austin Sukanick, `docs/compliance/BCP_DR.md`); runbooks in `ops/` | 4×3 = 12 (**high**) | **Mitigate:** set up Austin's access (AWS, GitHub, the email inbox) and walk him through the incident runbook once. Owner, 2026-12-31. |
| R10 | An AI coding agent makes an unapproved or wrong production change. | Production | 3×4 = 12 | Agents work only through PRs and the guarded workflows; the Claude Code hook refuses pushes to main, force pushes and direct deploys; the agent IAM user is denied infrastructure changes; every production run needs the owner's words | 1×4 = 4 | **Accept**, monitor through the quarterly change sample (C-1). |
| R11 | A vulnerable dependency or code flaw is exploited. | Application and data | 3×4 = 12 | CodeQL, Semgrep, Inspector Lambda code scanning; Dependabot alerts (13 open on main when read 2026-11-06: 2 high, 7 moderate, 4 low); triaged in `docs/compliance/evidence/2026-11-06-V-1-dependency-triage.md`: none in the production API, 2 reach users (`xlsx`) | 3×3 = 9 | **Mitigate:** triage the open Dependabot alerts and record the result each month with V-1; annual pen test (V-2). Owner, 2026-11-30. |
| R12 | Staff are unaware of security duties (phishing, data handling). | All | 3×3 = 9 | Policies written (WISP, personnel security) | 3×3 = 9 | **Mitigate:** training at hire and annually, phishing tests twice a year (T-1, T-2). Owner, 2026-12-31. |

## 3. Highest residual risks

1. **R9 key-person dependency** (12): the backup person has no access yet.
2. **R2 tenant isolation** and **R3 admin compromise** (10 each): no third-party test yet, and day-to-day
   root use and branch protection are still open.
3. **R8 vendor oversight** and **R11 dependencies** (9 each): records not yet collected.

Login MFA (R1) was the highest risk before 2026-11-06 (residual 20); it is now 8.

## 4. Decisions for the owner

- [ ] Accept the R7 interim position: the files are not copied outside `us-east-1` until the
      replication change ships.
- [ ] Approve the treatment dates above.
- [ ] Approve this register as the 2026 risk assessment (row R-1).

Approved by: ______________________ (Michael Carletta, CEO)  Date: __________
