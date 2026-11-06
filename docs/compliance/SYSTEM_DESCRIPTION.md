# ChecksOps system description (SOC 2 draft)

**Owner:** Michael Carletta, CEO (Qualified Individual) — security@checksops.com
**Drafted:** 2026-11-06 from the repository and read-only AWS reads as `user/claude-code`
**Status:** draft for the readiness review. The auditor's own template ("Section III") governs the
final form. Matrix rows CC2.1 and CC9.2 in `docs/compliance/SOC2_CONTROL_MATRIX.md`.

## 1. Services provided

ChecksOps is a multi-tenant web application for insurance-claim and mortgage-servicing check
handling. Tenants (contractors, public adjusters, mortgage desks) use it to:

- record claims and the checks issued on them;
- capture and deposit checks through CheckAlt remote deposit, with OCR of the check;
- collect endorsements and signatures from homeowners and co-payees;
- disburse funds and collect fees by ACH through Moov, from the tenant's own Moov wallet.

ChecksOps is non-custodial: it never holds, pools or routes customer funds through a
ChecksOps-owned account (`docs/WISP.md` §9).

## 2. Principal service commitments

- Customer data is isolated per tenant and readable only by that tenant's authorized users.
- Customer data is encrypted in transit and at rest.
- Confidential data is kept for the retention schedule in `docs/DATA_RETENTION.md` and then disposed of.
- Security incidents affecting a tenant are reported to it within 72 hours of confirmation
  (`docs/INCIDENT_RESPONSE.md` §4).
- **OWNER TO CONFIRM:** the availability commitment, if any, in tenant contracts (an uptime figure,
  support hours). The Availability criteria are tested against what the contracts promise.

## 3. Components of the system

### Infrastructure (AWS account `806168576068`, region `us-east-1`)

| Layer | Component |
|---|---|
| Edge | CloudFront distribution `E1B0ZWWO5559U5`, AWS WAF `checksops-production-cloudfront-waf`, response headers policy `checksops-production-browser-security-headers` |
| Front end | React single-page app served from S3 through CloudFront |
| API | API Gateway HTTP API and the Lambda `checksops-production-prep-api` (Node.js), in private subnets of the production VPC |
| Identity | Cognito user pool `us-east-1_h00WorYMT` |
| Database | RDS PostgreSQL 18 `checksops-production`: Multi-AZ, encrypted, private subnets only, 35-day point-in-time restore, deletion protection |
| Files | S3 `checksops-production-privatefiles-806168576068`: SSE-KMS, versioning on, Block Public Access |
| Secrets and keys | Secrets Manager (`checksops/production/…`), KMS customer-managed keys |
| Operations | SQL runner EC2 `i-0c35557c4e5385406` (private subnet, SSM only, stopped between runs) |
| Logging and detection | CloudTrail, AWS Config, Security Hub, GuardDuty, Inspector, VPC flow logs, CloudWatch alarms to SNS |

`aws/production/LIVE_RESOURCES.md` records the pre-cutover state (2026-09-05) and is out of date for
the items above.

### Software

One repository, `michaelcarletta-cmd/ChecksOps` on GitHub: the SPA (`src/`), the API
(`aws/functions/api/`), the database migrations (`aws/workflows/sql/`) and the deployment tooling
(`scripts/deployment-guard/`, `.github/workflows/`). Changes follow
`docs/compliance/CHANGE_MANAGEMENT.md`.

### People

**OWNER TO CONFIRM:** headcount and roles. Today the owner is the only person who approves
production changes and the only AWS administrator; AI coding agents prepare changes under the
rules in `CLAUDE.md` and `AGENTS.md` and cannot approve or merge on their own judgment.

### Data

Claim records, check images and fields, endorsement and signature documents, payee and homeowner
names and contact details, the bank last four digits, Moov onboarding data (EIN and date of birth
KMS-encrypted; SSN kept only as last four), payment and deposit records, and audit logs. Full bank
account numbers for Moov are sent to Moov and not kept (`docs/WISP.md` §3.2).

### Procedures

`docs/WISP.md`, `docs/DATA_RETENTION.md`, `docs/INCIDENT_RESPONSE.md` with
`aws/cutover/INCIDENT_RESPONSE_AWS.md`, `docs/compliance/CHANGE_MANAGEMENT.md`,
`docs/compliance/BCP_DR.md`, `docs/compliance/PERSONNEL_SECURITY.md`,
`docs/ACH_RISK_FRAUD_MONITORING.md`, `docs/AML_PROGRAM.md`, and the runbooks in `ops/`.

## 4. Subservice organizations (carve-out method)

Their controls are not tested in ChecksOps's report. ChecksOps reviews each one's SOC report every
year (evidence calendar row S-1).

| Subservice organization | Service | Controls ChecksOps relies on |
|---|---|---|
| Amazon Web Services | Hosting, identity, storage, keys, logging | Physical security, hardware and network operations, availability of the managed services, encryption key protection |
| Moov | ACH payments, bank verification, KYC/KYB | Safeguarding of bank account numbers and identity data; ACH processing and NACHA compliance |
| CheckAlt (FinCapture) | Remote check deposit | Deposit processing and image retention on its side |
| Microsoft Azure | Check OCR (Document Intelligence) | Handling of check images it processes |
| Resend | Transactional email | Delivery and protection of message content |
| GitHub | Source control, CI, deployment workflows | Integrity and access control of the repository and Actions |

Complementary subservice organization controls are the controls above that each provider must
operate for ChecksOps's controls to meet the criteria.

## 5. Complementary user entity controls (CUECs)

Each tenant is responsible for:

1. Adding only people who should have full access to the company's ChecksOps data and money
   actions (every member has the same full access; there are no limited roles), and removing
   leavers promptly.
2. Making sure its users protect their sign-in factors (email account, passkey device, authenticator
   app) and enroll the financial two-factor before handling money.
3. Reviewing its users at least quarterly.
4. Checking payee and bank details before approving a disbursement.
5. Protecting the devices and networks its users sign in from.
6. Telling ChecksOps (security@checksops.com) promptly of any suspected unauthorized access.
7. Meeting its own record-keeping and consent obligations for the homeowner and claim data it
   enters.

## 6. Changes during the period, and known exceptions

To be completed for the report period. Known now:
- Production moved from Supabase and Lovable to AWS in 2026.
- Login MFA is optional on the production pool although the WISP requires it for every user
  (matrix CC6.1).
- The automated retention purge has not been rebuilt on AWS (matrix C1.2).
- Log retention does not match the retention policy (matrix CC7.1, read 2026-11-06).
