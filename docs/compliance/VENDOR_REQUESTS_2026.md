# Vendor report requests, 2026 (row S-1)

**Owner:** the Qualified Individual (`docs/WISP.md` §1) — security@checksops.com
**Drafted:** 2026-11-09, from the repository on main `17419cbc`
**Matrix rows:** CC9.2. **Risk register:** R8. **Evidence calendar:** row S-1, due 2026-12-31.
**Audit readiness plan:** November 2026, "request vendor SOC reports and addenda"; gap "Vendor
reports not on file".

What to ask each carve-out vendor for, where to ask, and what to check when it arrives. Each
report, once received, is reviewed with `docs/compliance/VENDOR_REVIEW_TEMPLATE.md`. Reports,
NDAs and contracts go to the restricted compliance folder, never this repository
(`docs/compliance/EVIDENCE_CALENDAR.md`, "Where records go").

## Vendor list

The carve-out list in `docs/compliance/SYSTEM_DESCRIPTION.md` §4 and the vendor table in
`docs/WISP.md` §3.6 agree on six vendors: **AWS, Moov, CheckAlt, Microsoft Azure, Resend and
GitHub**. Two differences to settle (not changed by this document):

- **OpenAI** is in WISP §3.6 but not in system description §4. It is called only for tenants who add
  their own OpenAI API key, so the contract is between the tenant and OpenAI. Decide whether it is a
  ChecksOps subservice organization (then add it to §4 and review it here) or a tenant-chosen
  service (then say so in §4 and in the tenant terms, as a CUEC). See "OpenAI" at the end.
- `docs/compliance/SOC2_CONTROL_MATRIX.md` "System boundary" lists "the email provider and OpenAI"
  and omits Microsoft Azure. Align it with §4 when the owner decides the OpenAI question.

Also note: the API sends some transactional email through Amazon SES
(`aws/functions/api/email.mjs`) and the endorsement and payee-setup email through Resend
(`aws/functions/api/endorsement-parity.mjs`, `aws/functions/api/providers/payees/email.mjs`). SES is
part of AWS; check that it is listed in the AWS report's in-scope services.

## What to request from every vendor

1. The most recent **SOC 2 Type II** report (Security at least; Availability and Confidentiality if
   they are covered), with its period and the service auditor's opinion.
2. A **bridge (gap) letter** if the report's period ended more than about three months ago.
3. Confirmation that the **service ChecksOps uses is in the report's scope**.
4. Their **subservice organizations** and whether they are carved out.
5. The **contract documents** on file for ChecksOps: the agreement, the data processing addendum
   (DPA), and a security or GLBA addendum where WISP §3.6 requires "written addenda". WISP §3.6 still
   marks the addenda for Moov, CheckAlt, Azure and Resend "OWNER TO CONFIRM".
6. If there is no SOC 2 report: a SOC 1 Type II, an ISO 27001 certificate with its statement of
   applicability, or a completed security questionnaire (WISP §5).

Expect most vendors other than AWS and Microsoft to ask for an NDA before releasing the report.
Sign it as ChecksOps, store it with the report, and log the date in the record.

## Summary

| Vendor | Criticality (suggested) | Where to get the report | NDA |
|---|---|---|---|
| AWS | High | AWS Artifact, in the AWS console of account `806168576068` | Accepted in Artifact (click-through) |
| Moov | High | Moov's trust center if it has one, else the Moov account contact | Likely |
| CheckAlt (FinCapture) | High | CheckAlt account contact or trust center | Likely |
| Microsoft Azure | Medium | Microsoft Service Trust Portal (sign-in required) | Terms accepted in the portal |
| Resend | Medium | Resend's trust center if it has one, else Resend support or account contact | Likely |
| GitHub | Medium | GitHub's trust portal; see the GitHub section for plan limits | Likely |

Criticality is a suggestion for the owner to confirm in each record: High where the vendor holds
customer, bank or identity data or its outage stops money movement; Medium where its data or outage
impact is narrower.

---

## 1. Amazon Web Services

**What ChecksOps uses it for.** All hosting, in account `806168576068`, `us-east-1` (system
description §3): CloudFront and AWS WAF, S3, API Gateway and Lambda, Cognito, RDS PostgreSQL, KMS,
Secrets Manager, EC2 with Systems Manager (the SQL runner), SES, CloudTrail, AWS Config, Security
Hub, GuardDuty, Inspector, CloudWatch and SNS. Backups are also copied to `us-east-2`. Holds all
customer data.

**What to request and where.**
- In the AWS console, **AWS Artifact → Reports**: download the current **AWS SOC 2 Type II**
  (Security, Availability, Confidentiality) report. Artifact asks you to accept its terms before
  download. Also download any bridge or continuing-operations letter Artifact offers for that
  report.
- Check the report's in-scope services list for each service above, and the regions.
- **AWS Artifact → Agreements**: check which agreements are accepted for the account. The AWS
  Customer Agreement and the AWS Service Terms apply to every account; record which data-protection
  terms apply and where they are.
- Download as the owner or another administrator: the `claude-code` IAM user is read-only and is not
  set up for Artifact.

**CUECs to look for** (AWS's shared responsibility model; the report's list governs):

| Likely CUEC | How ChecksOps meets it |
|---|---|
| Customer manages its IAM users, roles and credentials, with MFA | Root MFA on; admin through IAM Identity Center; `claude-code` least privilege (`ops/security/IAM_CLAUDE_CODE_LEAST_PRIVILEGE.md`); quarterly access review (row A-1). Open: day-to-day root use (matrix CC6.1). |
| Customer configures encryption of its data at rest and in transit | Matrix CC6.1 "Encryption at rest" and CC6.7; KMS customer-managed keys |
| Customer configures network access (security groups, subnets, public access) | RDS in private subnets (`ops/security/RDS_PRIVATE_SUBNETS_PLAN_2026_11.md`); S3 Block Public Access; WAF |
| Customer enables and reviews logging and monitoring | CloudTrail, Config, Security Hub, GuardDuty, Inspector; monthly review (row V-1); alarms (row I-3) |
| Customer backs up its data and tests recovery | RDS Multi-AZ, 35-day PITR, `us-east-2` copies; restore test (row B-1) |
| Customer patches its EC2 operating systems | SQL runner patching (row V-3) |

**Request email.** Not needed; AWS reports come from Artifact.

---

## 2. Moov

**What ChecksOps uses it for.** ACH payments from each tenant's own Moov wallet: wallet funding,
disbursements to payees, fee collection and invoices, bank account verification, and tenant KYC/KYB
onboarding (WISP §3.6, §9). Calls go to `api.moov.io`
(`aws/functions/api/providers/moov.mjs`, `aws/functions/api/providers/production/moov-*.mjs`);
webhooks are signature-verified (`aws/functions/api/providers/moov-webhook-confirm.mjs`) and recorded
in `aws_provider_webhook_receipts`. Data: business profile and EIN; representative name, address,
DOB, SSN, contact details; compliance documents; bank routing and account numbers; recipient names
and emails; transfer amounts.

**What to request and where.** Ask the Moov account contact, or Moov's trust center if it has one,
for the SOC 2 Type II report and bridge letter, their sponsor or partner bank arrangements as they
affect ChecksOps's transfers (whether those banks are carved out), and the signed DPA or security
addendum.

**CUECs to look for:**

| Likely CUEC | How ChecksOps meets it |
|---|---|
| Customer protects its API keys and credentials | Kept in Secrets Manager (`checksops/production/providers`), read only by the API execution role |
| Customer verifies webhook signatures | `moov-webhook-confirm.mjs`; each verified event recorded once in `aws_provider_webhook_receipts` |
| Customer restricts and reviews access to the Moov dashboard | To add to the access review (row A-1): Moov dashboard users are not in the 2026 Q4 list |
| Customer authorizes transfers and verifies payee bank details | Financial TOTP step-up (`financial_stepup_log`); tenant CUEC 4 (system description §5) |
| Customer obtains the end user's consent and terms acceptance | Moov terms acceptance captured with IP and user agent (WISP §3.6) |
| Customer monitors for ACH fraud and returns | `docs/ACH_RISK_FRAUD_MONITORING.md`, `docs/AML_PROGRAM.md` (row R-3) |

**Request email:**

> Subject: SOC 2 report request — ChecksOps
>
> Hello,
>
> ChecksOps uses Moov for ACH payments, bank account verification and KYC/KYB onboarding. As part of
> our SOC 2 readiness, we review each provider's assurance report every year. Could you send us:
>
> 1. Your most recent SOC 2 Type II report, and a bridge letter if its period ended more than three
>    months ago;
> 2. Confirmation that the services we use are in its scope, and which subservice organizations
>    (including partner banks) it carves out;
> 3. The data processing or security addendum that applies to our account, or the one we should sign.
>
> We are happy to sign your NDA. Please reply to security@checksops.com.
>
> Thank you,
> ChecksOps security

---

## 3. CheckAlt (FinCapture)

**What ChecksOps uses it for.** Remote check deposit (system description §1; WISP §3.6): check front
and rear images, deposit amounts, the tenant's deposit account number, and the depositor's name and
email go to CheckAlt (`aws/functions/api/providers/production/checkalt-*.mjs`). Account numbers come
back masked to the last four (`checkalt-account-mask.mjs`); deposits use dual control and holds
(`checkalt-dual-control.mjs`, `checkalt-holds.mjs`); deposit attempts are logged in
`checkalt_deposits` and `deposit_audit_log`.

**What to request and where.** Ask the CheckAlt account contact (or CheckAlt's trust center, if it
has one) for the SOC 2 Type II report covering FinCapture remote deposit, with a bridge letter. A
deposit processor may instead have a **SOC 1 Type II**; if so, take it and ask whether a SOC 2 or a
security questionnaire is available for the security criteria. Also ask how long CheckAlt keeps
check images and where, and for the security addendum.

**CUECs to look for:**

| Likely CUEC | How ChecksOps meets it |
|---|---|
| Customer protects its CheckAlt credentials | Secrets Manager (`checkalt-secrets.mjs`); production refuses UAT hosts (`checkalt-config.mjs`) |
| Customer reviews deposits and exceptions, and reconciles | `checkalt-status-reconcile.mjs`, `check-reconciliation.mjs`; tenant review of deposits |
| Customer submits images of adequate quality and prevents duplicate presentment | `checkalt-image-compliance.mjs`, `checkalt-idempotency.mjs` |
| Customer restricts who can submit deposits | Dual control and financial step-up (`checkalt-dual-control.mjs`, `financial_stepup_log`) |
| Customer restricts and reviews access to the CheckAlt portal | To add to the access review (row A-1) |

**Request email:**

> Subject: SOC report request — ChecksOps (FinCapture remote deposit)
>
> Hello,
>
> ChecksOps uses CheckAlt FinCapture for remote check deposit. As part of our SOC 2 readiness, we
> review each provider's assurance report every year. Could you send us:
>
> 1. Your most recent SOC 2 Type II report covering FinCapture (or your SOC 1 Type II if that is what
>    you have), and a bridge letter if its period ended more than three months ago;
> 2. Which subservice organizations it carves out, and how long and where check images are retained;
> 3. The data protection or security addendum that applies to our agreement.
>
> We are happy to sign your NDA. Please reply to security@checksops.com.
>
> Thank you,
> ChecksOps security

---

## 4. Microsoft Azure (Document Intelligence)

**What ChecksOps uses it for.** Check OCR with the `prebuilt-check.us` model of Azure AI Document
Intelligence (`aws/functions/api/azure-check-ocr.mjs`). Check images and the fields read from them
are sent to the endpoint stored in Secrets Manager `checksops/production/providers/azure-document-intelligence`.

**What to request and where.**
- **Microsoft Service Trust Portal** (sign in with the Microsoft account that owns the Azure
  subscription): download the current **Azure SOC 2 Type II** report and any bridge letter.
- Check that **Azure AI Document Intelligence** (it may be listed under Azure AI services or its
  former name, Form Recognizer) is in the report's in-scope services, and the region of the
  ChecksOps resource (read the endpoint's region in the Azure portal).
- Record the **Microsoft Products and Services Data Protection Addendum** as the DPA in force for
  the subscription, with the version date shown in the Azure agreement.

**CUECs to look for:**

| Likely CUEC | How ChecksOps meets it |
|---|---|
| Customer protects its Azure keys and rotates them | Key in Secrets Manager, read only by the API; record the last rotation date in the review |
| Customer manages access to its Azure subscription, with MFA | To add to the access review (row A-1): Azure subscription users are not in the 2026 Q4 list |
| Customer decides what data it sends and how long results are kept | Only check images are sent; results stored in ChecksOps's database under its retention schedule |

**Request email.** Not needed; Azure reports come from the Service Trust Portal.

---

## 5. Resend

**What ChecksOps uses it for.** Transactional email for endorsements and payee setup, sent to
`api.resend.com` (`aws/functions/api/endorsement-parity.mjs`,
`aws/functions/api/providers/payees/email.mjs`). Data: recipient email addresses and message
content. The API key is `RESEND_API_KEY` in the provider secret (`aws/functions/api/provider-secrets.mjs`).

**What to request and where.** Ask Resend support or the account contact (or Resend's trust center,
if it has one) for the SOC 2 Type II report and bridge letter, its subprocessor list, and its DPA.

**CUECs to look for:**

| Likely CUEC | How ChecksOps meets it |
|---|---|
| Customer protects its API keys and scopes them to sending | Key in Secrets Manager; confirm in the review that the key is send-only |
| Customer authenticates its sending domain (SPF, DKIM, DMARC) | Confirm the DNS records for the sending domain in the review |
| Customer controls message content and recipients | Templates in the repository; recipients come from the tenant's workflow |
| Customer restricts and reviews access to the Resend dashboard | To add to the access review (row A-1) |

**Request email:**

> Subject: SOC 2 report request — ChecksOps
>
> Hello,
>
> ChecksOps uses Resend to send transactional email to our customers' homeowners and payees. As part
> of our SOC 2 readiness, we review each provider's assurance report every year. Could you send us:
>
> 1. Your most recent SOC 2 Type II report, and a bridge letter if its period ended more than three
>    months ago;
> 2. Your current subprocessor list;
> 3. Your data processing addendum, or confirmation of the one that applies to our account.
>
> We are happy to sign your NDA. Please reply to security@checksops.com.
>
> Thank you,
> ChecksOps security

---

## 6. GitHub

**What ChecksOps uses it for.** The repository `michaelcarletta-cmd/ChecksOps`: source, pull
request review, GitHub Actions CI (CodeQL and the guard checks), and the guarded deployment
workflows; 23 of the 33 workflows in `.github/workflows/` request a GitHub OIDC token to assume
AWS roles. No customer
data (WISP §3.6). A compromise could change what is deployed, so integrity of the repository and
Actions is what ChecksOps relies on.

**What to request and where.** GitHub's **trust portal** lists GitHub's SOC reports. The SOC 2 Type
II is released to customers; on GitHub Enterprise Cloud it is available to enterprise owners under
the enterprise's compliance settings. The repository is on a personal account, so first confirm the
plan; if the full report is not available on it, take the public SOC 3 and ask GitHub through its
trust portal for the SOC 2 Type II. The agreement is GitHub's Customer Agreement or Terms of Service
for the plan in use; record which, and its DPA.

**CUECs to look for:**

| Likely CUEC | How ChecksOps meets it |
|---|---|
| Customer manages who has access to its repositories and organizations | Collaborators reviewed quarterly (row A-1: one collaborator, the owner) |
| Customer requires two-factor authentication | Confirm 2FA on the owner's GitHub account in the review |
| Customer configures branch protection and required reviews | Open: turn on branch protection (audit readiness plan, November); then row C-2 quarterly |
| Customer protects Actions secrets and limits workflow permissions | AWS access by OIDC roles rather than stored keys; guarded workflows (`ops/deployment-guard/README.md`) |
| Customer reviews third-party apps with access to the repository | Lovable's access removed 2026-11-06 (WISP §3.6); add installed apps to row A-1 |

**Request email** (only if the trust portal does not release the report for the plan in use):

> Subject: SOC 2 Type II report request — ChecksOps
>
> Hello,
>
> ChecksOps uses GitHub for source control, pull request review and GitHub Actions, including
> deployment workflows. As part of our SOC 2 readiness, we review each provider's assurance report
> every year. Could you tell us how to obtain your most recent SOC 2 Type II report (and any bridge
> letter) on our current plan, and which data processing addendum applies to our account?
>
> Please reply to security@checksops.com.
>
> Thank you,
> ChecksOps security

---

## OpenAI (pending the owner's decision)

ChecksOps calls OpenAI only with an API key a tenant adds for itself, stored per tenant in Secrets
Manager (WISP §3.6). If the owner decides it is a ChecksOps subservice organization, request its
SOC 2 Type II through OpenAI's trust portal or account contact and review it like the others. If it
is the tenant's own service, add a CUEC to system description §5 ("tenants who connect their own AI
provider are responsible for that provider") and drop it from the vendor review.

## Tracking

| Vendor | Requested on | Received on | Report period | Reviewed on (S-1 log) |
|---|---|---|---|---|
| AWS | | | | |
| Moov | | | | |
| CheckAlt | | | | |
| Microsoft Azure | | | | |
| Resend | | | | |
| GitHub | | | | |

Fill this table in a PR as requests go out and reports arrive (dates and periods only). The review
itself is recorded as described in `VENDOR_REVIEW_TEMPLATE.md`, "Where filled records go".
