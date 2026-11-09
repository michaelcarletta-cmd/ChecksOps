# Penetration test: scope and rules of engagement

**Owner:** Michael Carletta, CEO (Qualified Individual) — security@checksops.com
**Drafted:** 2026-11-09 from the repository (no AWS reads)
**Status:** draft for the owner to complete (the `<...>` placeholders and the checklist in §10) and
send to penetration-test firms. Nothing here has been agreed with a firm.
**Basis:** evidence calendar row V-2 (`docs/compliance/EVIDENCE_CALENDAR.md`); matrix CC4.1
(`docs/compliance/SOC2_CONTROL_MATRIX.md`, "Gap: no report on file"); risk register R2 tenant
isolation and R11 (`docs/compliance/RISK_REGISTER.md`); `docs/WISP.md` §4 (annual third-party
test); `docs/compliance/AUDIT_READINESS_PLAN.md` §3 (book the test in November 2026, before the
Type II window).

## 1. Objectives

1. Find exploitable weaknesses in the ChecksOps web application and its HTTP API before a
   customer or an attacker does, and fix them.
2. **Tenant isolation (risk R2):** show, with two test tenants, whether a user of one tenant can
   read, change, list, download or infer anything that belongs to the other. This is the most
   important objective; the risk register names this test as the treatment for R2.
3. Test the authentication chain end to end: sign-in, the required login MFA, the financial
   two-factor step-up, session handling and sign-out.
4. Test the unauthenticated surfaces: the public token routes homeowners and co-payees use, and
   the webhook receivers.
5. Produce a report that a SOC 2 auditor accepts as the annual third-party penetration test
   (CC4.1), followed by a retest that confirms the fixes.

## 2. System summary for the tester

ChecksOps is a multi-tenant SaaS for insurance-claim and mortgage-servicing check handling
(`docs/compliance/SYSTEM_DESCRIPTION.md` §1, §3). Every tenant member has the same full access
inside the tenant, money actions included; there are no limited roles. A separate platform-owner
function exists for ChecksOps staff (`aws/functions/api/tenant-admin.mjs`).

| Layer | Component (production) |
|---|---|
| Edge | CloudFront with AWS WAF and a security-headers policy |
| Web app | React single-page app from S3 through CloudFront |
| API | API Gateway HTTP API in front of one Node.js Lambda; the SPA calls it same-origin under `/prep`. Direct `execute-api` calls are refused by an origin-verify authorizer unless they come through CloudFront (`ops/production-cors-allowlist.md`). CORS allow-list `https://checksops.com`, `https://www.checksops.com` |
| Identity | Cognito user pool; sign-in by email code or passkey (WebAuthn, RP ID `checksops.com`). The **Lambda** checks the Cognito tokens and derives the user and tenant itself; tenant or user ids sent in headers (`x-tenant-id`, `x-user-id`, `x-role`), query strings or bodies are ignored (`ignoredSpoof` in `aws/functions/api/data.mjs`) |
| Login MFA | Required for every user since 2026-11-06: an authenticator (TOTP) code after every sign-in, enforced by the application (`aws/functions/api/login-mfa.mjs`) |
| Step-up | Financial two-factor (TOTP) before money actions, valid 30 minutes, recorded in `financial_stepup_log` (`aws/functions/api/financial-totp.mjs`) |
| Database | PostgreSQL with row-level security on `tenant_id` |
| Files | Private S3 bucket (SSE-KMS); browser uploads by short-lived presigned PUT; downloads by signed URL |
| Integrations | Moov (ACH), CheckAlt (remote deposit), Microsoft Azure (OCR), Resend (email) |

## 3. In scope

The firm tests only the hosts in the target list below and only the accounts in §6.

**Target list (owner to confirm before sending):**

| Target | Production | Staging |
|---|---|---|
| Web app | `https://www.checksops.com`, `https://checksops.com` | `https://staging.checksops.com` |
| API, as the SPA calls it | `https://www.checksops.com/prep/...` | `<staging API base URL>` (the repo's example config uses the staging HTTP API, stage `staging`; owner to confirm the URL the staging SPA uses) |
| Direct API endpoint (to confirm it refuses callers that bypass CloudFront) | `https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep` | `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging` |

**Areas:**

1. **Web application (SPA):** client-side storage of tokens, XSS (stored and reflected, including
   values that end up in emails and PDFs), CSP and other security headers, clickjacking, open
   redirects, secrets or internal URLs in the JavaScript bundle.
2. **HTTP API:** every route the SPA calls, including the generic data routes (`/data/query`,
   `/data/rpc`, `/data/write`), the workflow, financial and provider routes, `/identity/*` and
   `/authorization/*`. Injection, broken object-level and function-level authorization, mass
   assignment (fields a tenant user should not set), input validation, error messages that leak
   detail, rate limiting on sensitive routes.
3. **Authentication and session:**
   - email-code sign-in (`/auth/passwordless/*`, `/auth/email/*`), passkeys (`/auth/passkey/*`),
     token refresh and sign-out (`/auth/refresh`, `/auth/logout`), password reset
     (`/auth/forgot`, `/auth/confirm-forgot`);
   - **login MFA:** can any route other than the enrollment and check routes
     (`/auth/mfa/status`, `/auth/mfa/associate`, `/auth/mfa/verify`, `/auth/mfa/step-up`,
     `/identity/me`, `/identity/session`) be reached before the code is entered; does the check
     survive token refresh and end at sign-out; can a user re-enroll an authenticator without the
     old one; brute force of the 6-digit code;
   - **financial step-up:** can a money action (disbursement, bank-account change, fee
     collection) run without a fresh step-up, with a step-up from another user or session, or
     after it expires; can a step-up for one action be replayed for another;
   - account enumeration through sign-in, reset and invite responses.
4. **Tenant isolation (R2), with two test tenants A and B:** every read, list, write, delete,
   file and RPC path tried as a user of A against B's ids (claims, checks, deposits, payees,
   invoices, documents, members, settings), including ids guessed, copied from B's session, or
   sent in headers and bodies. Also a tenant user trying platform-owner functions (vertical
   escalation).
5. **Files:** upload (`/storage/upload-url`, `/storage/upload`) and download (`/storage/sign`,
   `/storage/sign-many`, `/storage/download`, `/storage/list`, `/storage/delete`,
   `/storage/move`), path traversal in object keys, uploading to another tenant's prefix,
   content-type and size checks, malicious files (HTML, SVG, polyglots), signed-URL lifetime and
   reuse. **Compliance documents** (identity and business documents sent on to Moov during
   onboarding, `aws/functions/api/providers/onboarding/documents.mjs`): the presigned PUT must
   only write the tenant's own upload key, the server's type and byte checks, and whether one
   tenant can read or replace another's finalized document.
6. **Public token routes** (no sign-in; a token in the link): `/public/signature-document`,
   `/public/signature-submit` (homeowner signing), `/public/endorsement` (check endorsement),
   `/public/invoice`, `/storage/public`, `/branding/logo`, and the homeowner upload OTP session
   (`aws/functions/api/homeowner-otp.mjs`). Token guessing and entropy, expiry, reuse after
   completion, using one token to reach another document or tenant, OTP brute force, and what a
   token holder can learn beyond the document they were sent.
7. **Partner sharing** between tenants (`aws/functions/api/partner-share-lifecycle.mjs`:
   `connect_partner_by_code`, `share_check_with_partner`, `revoke_shared_check`,
   `revoke_tenant_partnership`): a partner sees only what was shared, access ends on revoke,
   partner codes cannot be guessed, and a partner cannot share or revoke on the source tenant's
   behalf.
8. **Webhook receivers** (for example Moov, `POST /webhooks/moov`): forged, replayed and
   unsigned deliveries must be rejected. Test ChecksOps' verification only; send nothing to Moov.

## 4. Out of scope

- Attacks on AWS itself or on AWS infrastructure beyond the application: the AWS account, IAM,
  the console, Cognito's own endpoints beyond normal use by the app, the SQL runner instance, the
  database endpoint, the S3 buckets directly (other than through URLs the app issues).
- Denial of service, load or stress testing, and anything designed to exhaust rate limits or
  quotas. A short burst to confirm a rate limit exists is allowed if agreed in advance.
- Social engineering, phishing, and physical testing of anyone at ChecksOps or its customers.
- Third parties: **Moov, CheckAlt, Microsoft Azure, Resend, GitHub and AWS** are not tested. Test
  only how ChecksOps handles them (for example, what the app sends to Moov, how it treats a
  webhook or an OCR result). Each has its own SOC report (`SYSTEM_DESCRIPTION.md` §4).
- **No real money movement and no real bank accounts.** No ACH disbursement, collection or
  deposit is completed against a real account. Test tenants have no live Moov account or bank
  linked in production.
- Real customers' tenants, users and data. Any other tenant than the two test tenants.
- The source repository and CI (a code review can be quoted separately, see §9).
- Email domains and DNS (`checksops.com` mail records, SES/Resend configuration).

## 5. Environment: staging or production

Staging and production are **separate** and **not identical** (from the repo):

| | Staging | Production |
|---|---|---|
| Cognito pool | separate pool, passkey RP ID `staging.checksops.com` | own pool, passkey RP ID `checksops.com` |
| HTTP API | its own API and Lambda; CORS `*` | allow-list of the two production origins; origin-verify authorizer; 50 rps / 100 burst throttle |
| Database | separate database, test data only | customer data |
| Providers | Moov sandbox and CheckAlt UAT credentials (`aws/functions/api/sandbox-credentials.mjs`) | live Moov and CheckAlt; money paths on |
| Extra routes | temporary staging-only test harnesses (`tenant-collection-v2-uat.mjs`, sandbox routes) | not reachable |
| Edge | WAF and origin-verify on staging: **owner to confirm** | CloudFront WAF and security headers live |

**Trade-off.** Staging lets the firm test the money and onboarding flows hard, with sandbox
providers and no customer data, but its edge and API configuration differ, so findings about
those layers may not hold for production. Production is what customers use, but a tester there
works next to customer data and live payment providers, so the money flows can only be tested up
to the step-up, never to completion.

**Recommendation.** Test the application in **staging**, after the owner confirms that staging
runs the same Lambda code and the same applied migrations (RLS) as production and has
`AWS_LOGIN_MFA_REQUIRED` on. Then a short, read-mostly **production pass** on two dedicated test
tenants with no Moov account or bank linked: the edge (WAF, headers, CORS, TLS), the
origin-verify refusal of direct `execute-api` calls, sign-in and login MFA, and a sample of the
tenant-isolation tests. The report states which environment each finding came from. If the firm
quotes only one environment, choose staging and ask for the production edge checks as an
add-on.

## 6. Test accounts the owner provides

Created by the owner before the window, removed after the retest (record it in access review
A-1):

| Account | Tenant | Purpose |
|---|---|---|
| Tester A1, A2 | Test tenant A | Two members: normal use, and member-to-member actions |
| Tester B1 | Test tenant B | The other side of every isolation test |
| Tester P1 | Test tenant C, partnered with A | Partner sharing tests |
| One homeowner signing link, one endorsement link, one invoice link | Created in tenant A | Public token route tests |

- Each tester enrolls its own authenticator for login MFA and the financial step-up.
- No platform-owner account is given to the firm.
- Test data is synthetic: no real homeowner names, check images or bank details. Check images
  are samples the owner provides.
- Email addresses for the test accounts: `<tester mailbox addresses from the firm>`.

## 7. Rules of engagement

- **Window:** `<start date>` to `<end date>`, testing `<hours and time zone>`. The firm gives
  `<n>` business days' notice of the start and says when testing stops each day.
- **Source addresses:** the firm lists its egress IP addresses before the start. The owner may
  allow-list them in the WAF for the window or leave the WAF on; the report says which.
- **Contact:** security@checksops.com for notices, questions and urgent findings. Urgent phone
  contact: `<owner phone>`. The firm names its own lead and a 24-hour contact.
- **Stop and call** (testing pauses and the firm contacts the owner within one hour) when:
  - real customer data or another tenant than the test tenants becomes visible;
  - a critical finding is confirmed (for example cross-tenant read, authentication bypass, remote
    code execution);
  - a money movement, provider call or email to a real person looks like it may happen;
  - the service degrades or errors climb;
  - the owner asks.
- **Data handling:** take the minimum needed to prove a finding (one record, redacted). Store
  test data encrypted, share it only with the owner, and delete it within 30 days of the final
  report, with written confirmation. No customer data in the report.
- **No persistence:** no backdoors, no changes left behind; anything created is listed so it can
  be removed.
- **Authorization:** a signed authorization letter from ChecksOps naming the targets, window and
  source addresses, before any test.

## 8. Report and retest

- Executive summary for a non-technical reader, and a technical section.
- Every finding with: severity by **CVSS v3.1 (or 4.0) base score and vector**, the affected URL
  or route, environment, steps to reproduce, evidence (redacted), impact, and a recommended fix.
- A section on tenant isolation stating what was tried and the result, even where nothing was
  found.
- Methodology (OWASP WSTG / OWASP ASVS, OWASP API Security Top 10), tester names and
  qualifications, dates and hours of testing.
- **Retest included in the price:** within `<60>` days of the report, the firm retests every
  finding rated medium or higher and issues a retest letter or updated report showing each one
  fixed, accepted or open.
- A short **attestation letter** that ChecksOps can share with customers under NDA.

## 9. Deliverables needed as SOC 2 evidence (row V-2)

| Deliverable | Where it goes |
|---|---|
| Signed statement of work and authorization letter (scope, window, targets) | Restricted compliance folder |
| Final report with CVSS scores | Restricted compliance folder (not in this repository) |
| Retest letter or updated report | Restricted compliance folder |
| Attestation letter | Restricted compliance folder; shared with customers on request |
| One fix PR per finding, linked from a tracking list (owner, target date, PR, retest result) | GitHub; the list in the restricted folder |
| Owner's acceptance of any finding left open, with the reason | Restricted compliance folder |
| A log line in `docs/compliance/EVIDENCE_CALENDAR.md`: date, firm, environment, count of findings by severity, where the report is stored | This repository |

After the retest the matrix row CC4.1 (penetration test) can move from Gap to In place, and the
R2 and R11 treatments in the risk register can be marked done for the year.

Optional add-ons to ask the firm to price separately: a secure code review of
`aws/functions/api/`, and the semi-annual vulnerability assessment the WISP §4 also requires.

## 10. Owner checklist before the window

- [ ] Fill the placeholders in §3, §6 and §7 and confirm the target list.
- [ ] Confirm staging runs the production Lambda code and migrations, with login MFA on (§5).
- [ ] Confirm whether staging has the WAF and origin-verify authorizer.
- [ ] Create test tenants A, B and C and the five test accounts; confirm none has a live Moov
      account or bank linked in production.
- [ ] Seed synthetic claims, checks, documents, an invoice, a signing link and an endorsement link
      in tenant A; partner tenant C with A.
- [ ] Sign the statement of work and the authorization letter; get the firm's source IP
      addresses.
- [ ] Decide on WAF allow-listing for the window.
- [ ] Tell the payment providers only if a contract requires it (testing does not touch them).
- [ ] Watch security@checksops.com and the security alerts during the window; expect GuardDuty
      or WAF alerts from the test traffic.
- [ ] After the retest: delete the test accounts and tenants, store the deliverables, add the
      evidence calendar line.

## 11. Request for quote (draft email)

> Subject: Penetration test quote request — ChecksOps (web app and API, multi-tenant)
>
> ChecksOps is a multi-tenant SaaS for insurance-claim and mortgage check handling, hosted on
> AWS (CloudFront, API Gateway HTTP API, Lambda, Cognito, PostgreSQL with row-level security,
> S3). We are preparing for SOC 2 and need our annual third-party penetration test.
>
> Scope: the React web app and its HTTP API (about `<n>` routes), authentication with required
> TOTP login MFA and a TOTP step-up for money actions, cross-tenant isolation testing with two
> test tenants, file upload and download, public token links for signing, endorsement and
> invoices, partner sharing between tenants, and webhook verification. Out of scope: AWS
> infrastructure, denial of service, social engineering, and third-party providers. No real money
> movement. Our recommended setup is staging plus a short production pass on test tenants; the
> full scope document is attached.
>
> Please include: price and effort in days, the earliest dates, methodology, the testers'
> qualifications, a sample redacted report, CVSS scoring, a retest of medium and higher findings
> included in the price, and an attestation letter for customers. Optional add-on prices: secure
> code review of the API, and a semi-annual vulnerability assessment.
>
> We would like testing to finish before `<target date>`.
>
> Michael Carletta, CEO — security@checksops.com

## 12. Not covered here

- No firm is chosen and nothing is booked: the owner decides.
- No test accounts, tenants or AWS settings are created or changed by this document.
- The staging and production differences in §5 come from the repository; they were not read
  from AWS for this draft.
