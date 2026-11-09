# Security awareness training

**Owner:** Qualified Individual — security@checksops.com
**Course version:** 2026.1 (2026-11-09)
**Evidence calendar rows:** T-1 (training at hire and annually), T-2 (phishing simulation twice a year)
**Matrix rows:** CC1.4, CC1.5, CC2.2 in `docs/compliance/SOC2_CONTROL_MATRIX.md`
**Risk register:** R12 (staff unaware of security duties), and it supports R1, R5 and R3
**Status:** draft. It becomes the course of record once the owner approves this PR; the first
completions (T-1) are due by 2026-12-31 and the first phishing test (T-2) by 2027-03-31.

This file is the course, its knowledge check, the phishing-test procedure and the record templates.
It adds no new rules: every point below comes from `docs/WISP.md` and the policies it references.
Where a point and a policy disagree, the policy wins and this file is corrected.

Who takes it: everyone covered by `docs/compliance/PERSONNEL_SECURITY.md` ("personnel"), before
access is granted (or within the first week, if the Qualified Individual records why it had to be
later) and once a year after that. People who handle ACH or deposits also take the training in
`docs/ACH_RISK_FRAUD_MONITORING.md` and `docs/AML_PROGRAM.md` (`PERSONNEL_SECURITY.md` §3.3); this
course does not replace it.

---

## 1. Course outline (about 50 minutes)

Delivered as a reading of this section plus a short walk-through with the Qualified Individual
(live or recorded), then the knowledge check in §2. Each module lists what the learner should be able
to do afterwards and the points that matter for ChecksOps.

| # | Module | Minutes | Source |
|---|---|---|---|
| 1 | What we protect and why | 7 | WISP intro, §3.2, §3.6 |
| 2 | Data handling, classification and retention | 8 | WISP §3.2, §3.3, §3.8; `docs/DATA_RETENTION.md` |
| 3 | Accounts, MFA and the financial step-up | 8 | WISP §3.1; `PERSONNEL_SECURITY.md` §2 |
| 4 | Phishing and social engineering | 8 | WISP §2; risk register R1, R5 |
| 5 | Secrets, source code and change management | 7 | WISP §3.3, §3.5; `docs/compliance/CHANGE_MANAGEMENT.md`; `AGENTS.md` |
| 6 | Devices and acceptable use | 5 | `PERSONNEL_SECURITY.md` §4, §6 |
| 7 | Spotting and reporting incidents | 5 | WISP §3.10; `docs/INCIDENT_RESPONSE.md` |
| 8 | Joining, leaving and the yearly cycle | 2 | `PERSONNEL_SECURITY.md` §1, §5 |

### Module 1 — What we protect and why

Learning goals: name the most sensitive data ChecksOps holds, and say why a leak of it is a
reportable breach and not just an embarrassment.

- ChecksOps holds consumer financial information covered by the Gramm-Leach-Bliley Act and the FTC
  Safeguards Rule. The WISP is the security policy; the risk register explains what can go wrong.
- The most sensitive data: **bank details** (Moov keeps the full numbers; ChecksOps keeps the bank
  name and last four), **Moov onboarding identity data** (EIN and representative date of birth,
  stored KMS-encrypted; SSN last four), **check images** and endorsement packets in the private files
  bucket, homeowner and payee contact details, and the ability to **move money**.
- **Tenant data** belongs to the tenant. Every member of a tenant has full access to that tenant's
  data and money actions, so a single stolen login is serious (risk R1). The boundary between tenants
  is row-level security; never work around it, and report anything that looks like one tenant seeing
  another's data.
- Vendors (AWS, Moov, CheckAlt, Azure OCR, Resend) hold parts of this data under contract. Do not
  send customer data to any other service, including personal AI tools or file-sharing sites.

### Module 2 — Data handling, classification and retention

Learning goals: handle masked fields, files and exports correctly; know how long data is kept and
that deleting it is a controlled change.

- Personal fields are masked by default in the app; every reveal is logged (`pii_reveal_logs`).
  Reveal only what the task needs.
- Check images and documents are reached through short-lived signed links. Do not download them to a
  laptop except while actively working on them, and delete the local copy afterwards
  (`PERSONNEL_SECURITY.md` §4.5). Never forward them by personal email or chat.
- Do not copy customer data into tickets, GitHub issues, pull requests, chat or AI prompts. Use
  tenant or claim ids, not names, account numbers or images.
- Retention: claim files, check images and payment records are kept 7 years (`DATA_RETENTION.md` §2).
  Nobody deletes customer data by hand; a purge is approved in writing by the Qualified Individual
  and runs through the guarded SQL path (`DATA_RETENTION.md` §4).
- Records with people's names (training completions included) live in the restricted compliance
  folder, not in the repository.

### Module 3 — Accounts, MFA and the financial step-up

Learning goals: keep your own accounts safe; explain the two separate codes in ChecksOps and why
neither is ever shared.

- One named account per person. Shared logins are not allowed (`PERSONNEL_SECURITY.md` §2.2).
- Every ChecksOps sign-in needs an authenticator-app (TOTP) code after the email code or passkey.
  Money actions — wallet funding, disbursements, bank changes, CheckAlt deposit submit and approve —
  need the **financial TOTP step-up** as well, and are recorded in `financial_stepup_log`.
- **No one from ChecksOps, Moov or AWS will ever ask for your sign-in code or authenticator code.**
  A request for one, by email, phone or chat, is an attack: refuse and report it.
- If you lose your phone or authenticator, tell an administrator; they can reset your two-factor,
  which signs you out everywhere. Do not set up a second authenticator for someone else.
- AWS and GitHub need MFA too. The AWS root account is for break-glass use only.

### Module 4 — Phishing and social engineering

Learning goals: recognise the phishing that targets a payments business, and know the one thing to do
with a suspicious message.

- Signs: urgency or secrecy ("pay today", "don't tell anyone"); a sender name that does not match the
  address; look-alike domains (for example a misspelling of checksops.com, moov.io or aws.amazon.com);
  links whose real address differs from the text; unexpected attachments, QR codes or "shared
  document" invitations; requests for codes, passwords or remote access.
- The two attacks that cost the most here: **a request to change a payee's or tenant's bank details**,
  and **a request to approve an urgent disbursement**. Verify every such request by calling a known
  number or checking in the app — never by replying to the message or using contact details in it
  (risk R5, `docs/ACH_RISK_FRAUD_MONITORING.md`).
- Fake vendor notices (Moov, CheckAlt, AWS billing, GitHub security alerts) that ask you to sign in:
  open the vendor's site from your own bookmark instead of the link.
- Unexpected MFA prompts or sign-in codes you did not request mean someone has your password or
  email; report at once.
- If you clicked or entered something: report it straight away to security@checksops.com. Early
  reports are welcome and never punished; hiding one is a policy violation.

### Module 5 — Secrets, source code and change management

Learning goals: keep secrets out of places they leak from; explain how a change reaches production.

- API keys, provider credentials and database passwords live in AWS Secrets Manager. **Never** put a
  secret in source code, a commit, a pull request, an issue, a chat message, an AI prompt, a ticket or
  a document. If one is exposed, report it; it will be rotated.
- Every change goes through a reviewed pull request. Production database, Lambda, SPA and CloudFront
  changes go only through the guarded workflows; direct deploys are refused by the deployment guard
  (`CHANGE_MANAGEMENT.md`, `ops/deployment-guard/README.md`).
- Each production step needs the owner's explicit approval of that run. Migrations and recorded
  evidence are append-only (`AGENTS.md`). Do not apply SQL by hand in psql or the console.
- AI coding agents follow the same rules and are limited by hooks and IAM; a person still reviews
  and approves (risk R10).

### Module 6 — Devices and acceptable use

Learning goals: confirm your device meets the endpoint rules; know what the systems may be used for.

- Every laptop or desktop used for ChecksOps: full-disk encryption on; screen lock of 10 minutes or
  less; automatic OS and browser updates; built-in malware protection on; no customer data stored
  locally except while working on it (`PERSONNEL_SECURITY.md` §4).
- Lock the screen when you step away. Do not let others use your logged-in device.
- Avoid public Wi-Fi for admin work without a trusted connection; never install unknown browser
  extensions on the browser used for ChecksOps.
- ChecksOps systems and customer data are for ChecksOps business only. Violations can lead to loss
  of access and disciplinary action up to termination (`PERSONNEL_SECURITY.md` §6).
- Report a lost or stolen device to security@checksops.com the same day.

### Module 7 — Spotting and reporting incidents

Learning goals: tell an event from an incident; report quickly to the right place.

- Report anything suspicious to **security@checksops.com**: a phishing message, a code you did not
  request, data you should not be able to see, a lost device, an exposed secret, odd payment activity.
- Do not investigate on your own, delete evidence, or contact the attacker. Write down what you saw
  and when.
- The Qualified Individual leads the response under `docs/INCIDENT_RESPONSE.md` and
  `aws/cutover/INCIDENT_RESPONSE_AWS.md`. Internal notice within 24 hours; tenants within 72 hours of
  confirmation; the FTC within 30 days if 500 or more consumers are affected.
- Do not discuss a suspected incident with customers or outside the company unless the Qualified
  Individual asks you to.

### Module 8 — Joining, leaving and the yearly cycle

- Before access: background check (where lawful), confidentiality agreement, acknowledgment of the
  WISP and the personnel policy, and this course.
- On leaving: all access removed within 24 hours, devices returned or wiped, shared secrets rotated.
- Every year: this course again (T-1), plus two phishing tests (T-2), plus the quarterly access review
  (A-1).

---

## 2. Knowledge check (10 questions)

Pass mark: 8 of 10. Anyone below that reviews the modules they missed and retakes the check; the
record shows both attempts. Answers are in §3.

1. Which of these does ChecksOps itself keep for a tenant's bank account connected through Moov?
   (a) the full routing and account numbers, (b) the bank name and the last four digits, (c) nothing.
2. You get an email from "Moov Support" saying your account will be suspended unless you sign in
   through the link today. What do you do?
3. A payee emails asking to change the bank account their disbursement goes to. They say it is
   urgent. What is the correct step before anything changes?
4. Someone calling from "ChecksOps IT" asks you to read out the code from your authenticator app so
   they can fix your account. What do you do?
5. Name the money actions that need the financial TOTP step-up.
6. You need to show a colleague a problem with a claim. What may you paste into a GitHub issue or a
   chat message: (a) the claim id, (b) a screenshot of the check image, (c) the homeowner's name and
   address?
7. You notice a database password in a pull request. What do you do?
8. Name three of the five settings every laptop used for ChecksOps must have.
9. A customer asks you to delete all their claim records now. Can you do it yourself? What happens
   instead?
10. You clicked a link in a suspicious email and typed your password before noticing. What is the
    first thing to do, and where?

---

## 3. Answers

1. (b). Full bank numbers go to Moov and are not kept by ChecksOps (WISP §3.2).
2. Do not use the link. Open Moov from your own bookmark to check, and forward the email to
   security@checksops.com.
3. Verify the request through a known contact (a phone number on file, not one in the email) and
   follow the ACH fraud policy. The change itself needs the financial step-up. Report the request if
   it does not check out.
4. Refuse and end the call; nobody legitimately asks for that code. Report it to
   security@checksops.com.
5. Wallet funding, disbursements, bank changes, and CheckAlt deposit submit and approve.
6. (a) only. Never paste images, names, addresses or account numbers into issues, PRs or chat.
7. Do not copy or reuse it. Report it to security@checksops.com so it is rotated, and flag the PR
   for the secret to be removed. Secrets live only in AWS Secrets Manager.
8. Any three of: full-disk encryption; screen lock of 10 minutes or less; automatic OS and browser
   updates; built-in malware protection on; no customer data stored locally except while working.
9. No. Retention is 7 years by default and a purge is approved in writing by the Qualified Individual
   and run through the guarded SQL path. Pass the request to the Qualified Individual.
10. Report it at once to security@checksops.com (and tell the Qualified Individual directly); the
    password is changed and sessions are ended. Reporting early is expected and never punished.

---

## 4. Internal course or a training tool

| | This internal course | A compliance or training tool |
|---|---|---|
| Content | Specific to ChecksOps: bank data, Moov, check images, the step-up, the guarded path | Generic security awareness videos; some let you add your own policies |
| Upkeep | Edited here by PR, versioned in git; must be kept current by the owner | Vendor maintains the generic content; your own parts still need upkeep |
| Phishing tests | Run by hand (§5) | Usually built in, with templates and click tracking |
| Records | Template in §6, filled in and stored in the restricted folder | Completions, scores and dates recorded automatically, exportable for the auditor |
| Fit with other SOC 2 work | Stands alone | Often part of a wider compliance platform that also tracks policies, access reviews and vendors |
| Effort to start | None beyond this PR | Selection, contract, user setup; adds a vendor to review (S-1) |

**Recommendation for a team of a few people:** use **this internal course** now, and run phishing
tests by hand. It covers what matters most here (the money and identity data, and the codes) in a
way a generic video cannot, and it adds no vendor. An auditor accepts a dated, versioned course with
per-person completion records and scores. Revisit if the team grows beyond about ten people, or when
a compliance tool is chosen for the wider SOC 2 program (the evidence calendar already allows for
one); at that point the tool's generic course and phishing module can sit alongside modules 1, 3, 4
and 5 of this course, which stay ChecksOps-specific.

---

## 5. Phishing simulation (T-2)

Twice a year, about six months apart (first by 2027-03-31). Simple, manual, and recorded.

1. **Plan.** The Qualified Individual picks one realistic scenario from module 4: a fake vendor
   "sign in to keep your account", a bank-detail change request, an urgent disbursement request, or a
   "shared document" link. Rotate scenarios between runs. Note the date and scenario in the record.
2. **Build.** Send from an outside address or a look-alike domain the company controls, to every
   person in scope. The link goes to a harmless page the company controls that records the click and
   shows "This was a phishing test — see module 4 of the security training". Never collect real
   passwords or codes; the page has no sign-in form. If an email provider's own simulation feature
   is available, it can be used instead.
3. **Warn the right people only.** The Qualified Individual and whoever runs the mail system know in
   advance, so reports are not treated as a real incident. Nobody else is told the date.
4. **Watch for 5 working days.** Count per person: delivered, opened link, reported to
   security@checksops.com, and time to first report.
5. **Follow up.** Anyone who clicked gets a short private review of module 4 within a week; nobody is
   named outside the restricted record. A real report that arrives during the window is handled as a
   real report.
6. **Record** (§6.2). The summary line in the evidence calendar log shows only the date, the counts
   and the click rate.

A click is a training event, not a disciplinary one. Repeated clicks across tests are discussed with
the person and noted in their record.

---

## 6. Evidence record templates

Completed records name people, so they are stored **outside the repository**, in the restricted
compliance folder (or the compliance tool, once one is chosen), as `docs/compliance/EVIDENCE_CALENDAR.md`
("Where records go") and `PERSONNEL_SECURITY.md` require. The evidence calendar log gets one line per
record with the date, the row, and where the record is stored — never names or scores. Keep the
records for 7 years, like other audit evidence.

### 6.1 T-1 training completion (one row per person per completion)

| Field | Example / notes |
|---|---|
| Person | Full name (restricted folder only) |
| Role | e.g. engineer, operations, contractor |
| Reason | At hire / Annual / Retake |
| Course version | `2026.1` (the version at the top of this file, and the commit of this file on main) |
| Modules completed | 1–8 |
| Delivered by | Qualified Individual, live or recorded walk-through |
| Date completed | YYYY-MM-DD |
| Knowledge check score | e.g. 9/10 (pass mark 8) |
| Retake score and date | if the first attempt was below 8 |
| ACH / AML training also required | Yes / No; date if yes |
| Acknowledgment | Person's signature or emailed confirmation: "I completed the course and will follow the WISP and personnel policy" |
| Recorded by, date | Qualified Individual |

### 6.2 T-2 phishing simulation (one record per run)

| Field | Example / notes |
|---|---|
| Run date and window | YYYY-MM-DD to YYYY-MM-DD |
| Scenario | e.g. fake vendor sign-in notice |
| Sent from / landing page | Sending domain used; landing page shows the test notice, no form |
| People in scope | Count, with the named list in this restricted record |
| Per person | Delivered / clicked / reported / time to first report |
| Totals | Delivered N, clicked N, reported N; click rate %; report rate % |
| Follow-up | Who received the module 4 review, and the date |
| Lessons for the course | Any change to module 4 (made by PR, with a new course version) |
| Run by, date signed | Qualified Individual |

### 6.3 Evidence calendar log line (in the repository)

```
| YYYY-MM-DD | T-1 | Qualified Individual | Training completed: N people, course 2026.1, all passed; record in the restricted compliance folder |
| YYYY-MM-DD | T-2 | Qualified Individual | Phishing test (scenario type): N sent, click rate X%, report rate Y%, follow-up done; record in the restricted compliance folder |
```

---

## 7. Keeping this course current

- Reviewed with the WISP each year (row R-2) and whenever a policy it draws on changes. Each change
  is a PR that bumps the course version at the top.
- After an incident or a phishing run shows a gap, add it to the relevant module.
