# SOC 2 audit readiness plan

**Owner:** Michael Carletta, CEO (Qualified Individual) — security@checksops.com
**Drafted:** 2026-11-06
**Status:** plan. No CPA firm is engaged, no auditor has reviewed anything, and no SOC 2 report exists.
The dates are targets for the owner to confirm.

This is the route from today's readiness draft (`docs/compliance/SOC2_CONTROL_MATRIX.md`) to a
SOC 2 Type I report, then a Type II report.

## 1. What to ask the auditor for

| Decision | Recommendation | Why |
|---|---|---|
| Trust Services Criteria | **Security** (required) + **Availability** + **Confidentiality** | Matches the matrix. Tenants trust ChecksOps with confidential claim and bank data and depend on it to move money. Leave Processing Integrity out of the first report; add it later if customers ask. |
| Report sequence | **Type I first**, then **Type II** | Type I tests the design on one date and can be done soon. Type II tests that the controls kept running over a period, and most customers' vendor reviews ask for it. |
| Type II period | **6 months** (3 is possible for a first report) | A 3-month first period is common and gets a report out sooner. Six months gives buyers more assurance. The firm can advise. |
| Subservice organizations | **Carve-out**: AWS, Moov, CheckAlt, Microsoft Azure, Resend, GitHub | Each has its own SOC report. ChecksOps reviews those reports instead of having its auditor test them (`SYSTEM_DESCRIPTION.md` §4). |
| SOC 1 | Not now | Only if a customer's financial auditor relies on ChecksOps for payment records. Revisit when a customer asks. |

## 2. Choosing a CPA firm

Only a licensed CPA firm can issue a SOC 2 report. Ask two or three firms for proposals. Check that
each firm:

- issues SOC 2 reports regularly for small SaaS or fintech companies (ask for the number per year and
  a sample redacted report);
- is AICPA peer-reviewed (ask for the latest peer review letter);
- separates readiness work from the audit. A firm may not audit controls it designed, so a
  readiness review by the same firm must stay advisory;
- prices Type I and Type II separately, states the fieldwork dates, and accepts evidence exported
  from this repository and AWS (or from a compliance tool, if one is chosen);
- has worked with payment or lending clients (NACHA and the GLBA Safeguards Rule).

**Rough market ranges, to check against real quotes:** a readiness review of a few thousand to
about $15k; a Type I report of about $10k–$30k; a Type II report of about $15k–$50k. Small, simple
systems are at the low end. Separate costs: a penetration test (about $5k–$20k) and, if chosen, a
compliance platform (about $7k–$15k a year).

**Compliance tool (optional).** Vanta, Drata or Secureframe connect to AWS and GitHub, collect
evidence automatically and hold policies, training and vendor reviews. With one owner and this
repository's evidence calendar, a tool is not required. It saves time during a Type II period,
mainly for training records, access reviews and vendor tracking. Several CPA firms work with these
tools and offer a discount for them.

### Email to send to the firms (draft)

> Subject: SOC 2 Type I and Type II proposal request — ChecksOps
>
> ChecksOps is a multi-tenant SaaS for insurance-claim and mortgage check handling, hosted on AWS
> (one account, us-east-1), with ACH through Moov and remote deposit through CheckAlt. We are a
> small team with one production system.
>
> We would like a proposal for:
> 1. a SOC 2 readiness assessment (advisory), in December 2026;
> 2. a SOC 2 Type I report covering Security, Availability and Confidentiality, as of about
>    January 31, 2027;
> 3. a SOC 2 Type II report on the same criteria for an observation period starting after the
>    Type I, of 3 or 6 months (please price both).
>
> We use the carve-out method for AWS, Moov, CheckAlt, Microsoft Azure, Resend and GitHub. We have
> a control matrix, system description, policies and an evidence calendar ready to share under
> NDA. Please include your fees, timeline, how you collect evidence, and your latest peer review
> letter.
>
> Michael Carletta, CEO — security@checksops.com

## 3. Timeline (targets)

| When | Step | Done when |
|---|---|---|
| Nov 2026 | Book the penetration test; request vendor SOC reports and addenda; turn on branch protection; sign off the access review, risk register and QI report; set up the backup person's access | Each has a record under `docs/compliance/evidence/` or in the restricted folder |
| Nov–Dec 2026 | Send the proposal request (§2); choose a firm | Engagement letter signed |
| Dec 2026 | **Readiness review** with the firm; fix what it finds | Readiness findings list, each with an owner and a date |
| Dec 2026–Jan 2027 | Close the remaining gaps (§4): training, restore test, vendor reviews, purge decision, tabletop | Matrix rows move to In place |
| ~2027-01-31 | **Type I "as of" date** | All controls designed and in place on that date |
| Feb–Mar 2027 | Type I fieldwork and report | **Type I report issued** |
| 2027-02-01 → 2027-07-31 | **Type II observation period** (6 months; or to 2027-04-30 for 3 months) | Every recurring control has a record in the evidence calendar for each time it was due |
| Aug–Sep 2027 | Type II fieldwork and report | **Type II report issued** |
| Every year after | Renew the Type II for the next 12-month period | |

## 4. Before the Type I date: gaps to close

From the matrix (2026-11-06, after login MFA shipped):

| Gap | Matrix | Owner action | Claude can help with |
|---|---|---|---|
| Risk assessment not approved | CC3.1–3.2 | Review and sign `RISK_REGISTER.md` | Updates after the owner's review |
| Annual QI report not signed | CC1.2 | Edit and sign `QI_ANNUAL_REPORT_2026.md` | |
| Access review not signed off | CC6.3 | Mark the named list, sign, store outside the repo | The role clean-up runbook for the roles found unused |
| No training records | CC1.5 | Choose training (a tool or a short internal course), have everyone complete it | A training outline from the WISP |
| No penetration test | CC4.1 | Book a firm | The scope description |
| Vendor reports not on file | CC9.2 | Request the SOC 2 reports from AWS (AWS Artifact), Moov, CheckAlt, Azure, Resend and GitHub | The vendor review template (row S-1) |
| No restore test | A1.3 | Run it in CloudShell from the runbook | The runbook and the record |
| Backup person without access | CC9.1, R9 | Create the accounts | The walkthrough checklist |
| Branch protection not exported | CC8.1 | Turn it on in GitHub settings | The export as evidence |
| Root used day to day | CC6.1 | Use the Identity Center admin sign-in | |
| Files not copied outside `us-east-1` | CC9.1 | Approve the replication change | The runbook |
| Retention purge not on AWS | C1.2 | Decide automated or manual | Either path |
| No incident tabletop | CC7.3–7.4 | Hold a 1-hour tabletop | The scenario and the record |
| Open Dependabot alerts (13) | CC7.1, R11 | Approve the fixes | Triage and fix PRs |

## 5. During the Type II period

The auditor samples each recurring control in `docs/compliance/EVIDENCE_CALENDAR.md`. A missed
occurrence is an exception in the report, so the calendar dates matter more than anything else
during the period:

- monthly: Security Hub snapshot (V-1), SQL runner patching (V-3);
- quarterly: access review (A-1), change sample (C-1), branch protection export (C-2);
- each event: offboarding within 24 hours (A-2), post-mortem within 14 days (I-2);
- once in the period: restore test (B-1), tabletop (I-1), alert test (I-3), vendor reviews (S-1),
  training and phishing (T-1, T-2), risk register review (R-1).

## 6. Not covered here

- No choice of firm or tool: that is the owner's decision.
- No AWS, database or application change.
