# Backup person: access setup, walkthrough and offboarding

**Owner:** the owner (CEO, Qualified Individual), security@checksops.com. The owner makes every
grant below; nothing in this document has been applied.
**For:** the backup person named in `docs/compliance/BCP_DR.md` §4 item 3 ("the backup person"
below; the name is not repeated here).
**Risk and controls:** risk register R9, key-person dependency, residual 4×3 = 12 (**high**),
treatment due 2026-12-31 (`docs/compliance/RISK_REGISTER.md`). Matrix CC9.1 (continuity), CC6.2
and CC6.3 (access granted and removed through a controlled process, least privilege)
(`docs/compliance/SOC2_CONTROL_MATRIX.md`). Evidence rows A-1 and A-2
(`docs/compliance/EVIDENCE_CALENDAR.md`).

R9 can be lowered to its target once the setup in part 1 and the walkthrough in part 2 are done
and recorded with the template in part 4. Until then the backup person is named but cannot act.

## What the role is

From `docs/compliance/BCP_DR.md` §4 and `docs/compliance/CHANGE_MANAGEMENT.md` §4.1: the backup
person acts for the owner on an incident, an outage or a restore **when the owner cannot be
reached**, and may then make an emergency change, limited to containment and recorded within
2 business days. Day to day, the backup person watches and learns; they do not change production.

The access below follows that split: read-only by default, a separate elevated path only if the
owner decides one is needed, and every production run still behind the same gates as the owner's.

## Before anything is granted

`docs/compliance/PERSONNEL_SECURITY.md` §1 and §2.1 apply first. Keep each in the restricted
compliance folder (never in this repository):

- [ ] background check, to the extent the law allows;
- [ ] confidentiality agreement signed;
- [ ] WISP (`docs/WISP.md`) and the personnel policy acknowledged;
- [ ] the owner's written approval of the access in part 1 (which items, which permission sets);
- [ ] endpoint requirements met on the device the backup person will use (personnel policy §4:
      disk encryption, screen lock of 10 minutes or less, automatic updates, built-in malware
      protection).

---

## Part 1 — Access setup checklist (owner)

One named identity per system, MFA everywhere, the least access that lets the backup person follow
an incident. **No IAM users, no access keys, no root.** The AWS root account stays break-glass for
the owner only (`docs/compliance/PERSONNEL_SECURITY.md` §2.2, `docs/WISP.md` §3.1).

### 1.1 AWS, through IAM Identity Center

The account (`806168576068`) already signs people in through IAM Identity Center: the 2026-11-06
access review found 2 Identity Center users, both on the `AdministratorAccess` permission set, and
one IAM user, `claude-code` (`docs/compliance/evidence/2026-11-06-A-1-access-review.md`). The
backup person becomes a third, separate Identity Center user.

| # | Step | How to verify | Evidence to keep |
|---|---|---|---|
| 1 | Create an Identity Center user for the backup person, with their own work email. Do not reuse or share an existing user. | Identity Center → Users lists the new user, status enabled. | User id (not the email), date created, created by. |
| 2 | Confirm MFA is enforced for Identity Center sign-in: Settings → Authentication → Multi-factor authentication: prompt **every time they sign in**, and users without a device **must register one at sign-in**. | Screenshot of the MFA settings page. The backup person's first sign-in forces device registration. | Screenshot; date. |
| 3 | The backup person signs in and registers an authenticator app or security key. | Identity Center → Users → the user → MFA devices shows one device. | Screenshot showing a registered device (no secret, no QR code). |
| 4 | **Day-to-day permission set:** create a permission set for the backup person and assign it on account `806168576068`. Recommended: AWS managed `ViewOnlyAccess` plus `SecurityAudit` (configuration and security-finding metadata: CloudWatch alarms, CloudTrail event history, GuardDuty and Security Hub findings, Config; no object or secret contents). Alternative: AWS managed `ReadOnlyAccess`, which also reads S3 objects (check images) and log contents; the owner decides whether the backup person needs that. Session duration 1 hour. | The backup person signs in, opens the account with this set, and can see: CloudWatch → Alarms, CloudTrail → Event history, GuardDuty → Findings, Security Hub → Findings, RDS → `checksops-production`. A write (for example creating a CloudWatch dashboard, then cancelling) is refused. | Permission set name and its attached policy ARNs; screenshot of the assignment; the refused write's error text. |
| 5 | **Break-glass permission set: only if the owner decides.** BCP §4 asks that the backup person can run the §3 procedures (point-in-time restore to a new instance, restore a previous S3 object version, credential containment), which a read-only set cannot do. Options: (a) no elevated set; the backup person contains by calling the owner and by the GitHub steps in 1.2; (b) assign the existing `AdministratorAccess` set to the backup person, session duration 1 hour, used only under `docs/compliance/CHANGE_MANAGEMENT.md` §4; (c) a narrower custom set written later as its own reviewed PR. The owner records which. | If (b) or (c): the assignment is visible on the user; the backup person signs in with it once during the walkthrough, runs one read (`aws sts get-caller-identity` in CloudShell shows `AWSReservedSSO_<set name>`), and signs out. | The owner's decision in writing (a, b or c); assignment screenshot; the test sign-in's date and the CloudTrail event id of that sign-in. |
| 6 | Confirm nothing else was created: no IAM user, no access key, no console password, no root credential for the backup person. | IAM → Users still lists only `claude-code` (as in the A-1 review); no new access keys. | Screenshot or the IAM user count, date. |
| 7 | Add the new Identity Center user to the next quarterly access review (row A-1). | It appears on the A-1 named list. | Line on the A-1 named list (kept outside the repository). |

Every use of the elevated set appears in CloudTrail under the backup person's own Identity Center
identity, and IAM changes raise `checksops-prod-iam-security-changes` (part 2, step 2). That is the
compensating control for giving a second person elevated access in a two-person company.

### 1.2 GitHub

The repository is `michaelcarletta-cmd/ChecksOps`; the A-1 review found one collaborator, the owner,
as admin. Production deploys run only through the guarded workflows; each production job uses the
GitHub `production` environment, whose settings the owner read on 2026-10-30: **required reviewers:
only the owner**, deployment branches `main` only, administrator bypass **unchecked**
(`ops/deployment-guard/github-oidc-trust/README.md`). The `main` branch requires a pull request and
the checks in `docs/compliance/CHANGE_MANAGEMENT.md` §2; direct pushes are refused (§6).

| # | Step | How to verify | Evidence to keep |
|---|---|---|---|
| 1 | The backup person uses their own GitHub account with two-factor authentication on. | They show Settings → Password and authentication with 2FA enabled. | Screenshot (no recovery codes); date. |
| 2 | Invite the account as a collaborator. Under a personal-account repository a collaborator gets write access; there is no read-only collaborator role there. If the repository moves to an organization, use the least role that can still run workflows manually (write); read or triage cannot start a `workflow_dispatch` run. | Settings → Collaborators lists the account. | Screenshot; date; invited by. |
| 3 | Confirm what write access does **not** allow: no push to `main`, no merge without the owner's approval and green checks, and every production job still waits for the `production` environment reviewer. | During the walkthrough, the backup person opens Actions → a guarded production workflow and sees the "Review deployments" gate; Settings → Branches/Rules shows the `main` rules (the C-2 export). | Screenshot of the environment protection rules and of the branch rules, dated (same export as row C-2). |
| 4 | **Owner decision: add the backup person as a required reviewer on `production`?** Today only the owner can approve a production job, so if the owner cannot be reached, nothing reaches production: not a rollback (`ops/production-lambda-rebuild.md`, `ops/production-spa-deploy.md`) and not a production status notice (`ops/status-notice.md`, which uses the same environment). Adding the backup person lets either of them approve a run. If added, turn on **Prevent self-review** so nobody approves a run they started, and keep branches at `main` and bypass off. Not adding them keeps today's single gate and accepts that the backup person can only contain in AWS (1.1 #5) and communicate. Either way, write the decision down; it changes who can deploy, so it is reviewed as a deploy-permission change (`ops/deployment-guard/github-oidc-trust/README.md`, "Keep it closed"). | Settings → Environments → `production` → Required reviewers lists the reviewers; "Prevent self-review" state. Repeat for `staging` and `production-readonly` if the owner wants the same there. | The owner's decision; screenshot of each environment's protection rules after the change. |
| 5 | Add the account to the next A-1 review (GitHub collaborators). | It appears on the A-1 named list. | Line on the named list (outside the repository). |

Per-run approval still applies to the backup person exactly as to anyone else: an approval for one
PR, run or environment never covers the next (`CLAUDE.md`).

### 1.3 The security mailbox and the alert emails

Reports reach ChecksOps at **security@checksops.com** (`docs/WISP.md` §3.10,
`docs/INCIDENT_RESPONSE.md`). The 14 CloudWatch security alarms notify SNS
`checksops-production-security-alerts`, which delivers to support@checksops.com
(`docs/WISP.md` §3.7). When the alarms were set up on 2026-09-08 the security@ subscription on that
topic was still `PendingConfirmation` (`aws/cutover/OPERATOR_SECURITY_HANDOFF_2TO6.md`); its state
today has not been re-read for this document.

| # | Step | How to verify | Evidence to keep |
|---|---|---|---|
| 1 | Give the backup person their own access to security@checksops.com and support@checksops.com: a delegate or group membership on their own mailbox account, never a shared password. | The backup person reads one existing message in each. | The mail admin's membership screenshot; date. |
| 2 | Alerts reach the backup person: either through step 1 (they read support@), or, if the owner prefers, a separate SNS email subscription to the backup person's work address on `checksops-production-security-alerts`. A new subscription is an AWS change the owner makes in CloudShell, not part of this document. | The subscription shows `Confirmed`; or, at the annual alert path test (row I-3), the backup person confirms they saw the test alarm. | Subscription ARN (not the email) and its confirmed date; or the I-3 record noting the backup person received it. |
| 3 | Decide whether to confirm or remove the stale security@ pending subscription; that is the owner's call and a separate change. | — | Note in the record. |

### 1.4 Password manager and break-glass material

No password manager is named in the repository. **OWNER TO CONFIRM** which one ChecksOps uses.

| # | Step | How to verify | Evidence to keep |
|---|---|---|---|
| 1 | Create a shared vault (or folder) the owner and the backup person can open, each with their own password-manager account and MFA. It holds **contact and account details, not shared logins**: the vendor support routes in part 2, step 5, AWS account id `806168576068`, the Identity Center sign-in URL, the vendor account ids, and where the restricted compliance folder is. | Both can open it; the item list matches. | Vault name, members (kept outside the repository), date. |
| 2 | Shared logins are not allowed (`docs/compliance/PERSONNEL_SECURITY.md` §2.2). Where the backup person needs a vendor console (Moov, CheckAlt, the mail admin), they get a named user there, MFA on, least role; list each on the record. | Each vendor console lists the named user. | One line per vendor: role, MFA yes/no, date. |
| 3 | Root: the root password and root MFA stay with the owner. If the owner wants a path for the backup person to recover the account if the owner is permanently unavailable, use the password manager's delayed emergency-access feature, if it has one (the owner is notified and can refuse during a waiting period), or a sealed envelope kept by counsel. Owner decision; record which. | The configured waiting period, or the counsel's receipt. | Decision and date; never the credential. |

### 1.5 Status notices

Tenants learn of an outage from `/status.json`, written only by `.github/workflows/spa-status-notice.yml`
(`ops/status-notice.md`). A production post needs the confirmation `POST STATUS NOTICE TO PRODUCTION`
and passes the `production` environment gate.

| # | Step | How to verify | Evidence to keep |
|---|---|---|---|
| 1 | The backup person reads `ops/status-notice.md` and, in the walkthrough, posts and then clears a notice on **staging**. | The staging site shows, then stops showing, the notice. | Two run ids (post, clear). |
| 2 | Whether they can post on production without the owner depends on the decision in 1.2 #4. If not, the fallback is to email affected tenants from security@ or support@. Write down which. | — | The decision on the record. |

---

## Part 2 — Walkthrough checklist (about an hour, owner and backup person together)

Read-only throughout: nobody changes production. Afterwards the backup person signs the record.

| # | Min | Topic | Read or do | Done when the backup person can… |
|---|---|---|---|---|
| 1 | 10 | Incident runbook | `aws/cutover/INCIDENT_RESPONSE_AWS.md` (authoritative for AWS: §1 severity, §2 evidence first, §3 credentials, §6 account takeover, §8 providers stay off, §9 restore); `docs/INCIDENT_RESPONSE.md` (roles, notification clocks: 24 hours internal, 72 hours tenant, 30 days FTC) | say the severity levels and the first action for each, and why evidence is exported before anything is changed |
| 2 | 10 | Alarms | Sign in with the day-to-day set (1.1 #4). CloudWatch → Alarms: the 14 security alarms, among them `checksops-prod-iam-security-changes` (CloudTrail → CloudWatch Logs filter `IamSecurityChanges`), Lambda errors and throttles, API 4xx/5xx, Cognito sign-in throttles, WAF blocked and counted, RDS. Each notifies `checksops-production-security-alerts` (`aws/cutover/OPERATOR_SECURITY_HANDOFF_2TO6.md`). GuardDuty → Findings (detector `298dc17133dd46b1b2cf755bc1380e1f`) and Security Hub → Findings. **GuardDuty and Security Hub findings are not sent to SNS** by any rule in this repository; they are read in the console and reviewed monthly (row V-1, `docs/compliance/evidence/2026-11-08-V-1-monthly-security-review.md`). CloudTrail → Event history: find one sign-in. | find an alarm's history and what it watches; open a GuardDuty finding and say what the known recurring `Policy:IAMUser/RootCredentialUsage` finding is (`ops/security/AWS_ACCOUNT_HARDENING_2026_11.md`); find who did something in CloudTrail |
| 3 | 10 | Guarded workflows | `docs/compliance/CHANGE_MANAGEMENT.md` §2 and §4; `ops/deployment-guard/README.md` ("Core rule"); `AGENTS.md` "Deployment safeguard". In GitHub: Actions → a `guarded-production-*` workflow; the environment gate; a recent merged PR as an example of one step per PR. | explain why a direct deploy is refused (`DEPLOYMENT_GUARD_REQUIRED`, forged receipts rejected, stop on `DEPLOYMENT_COLLISION`), why the fix for a bad change is the previous accepted build through the guarded workflow and not a hand upload, and what an emergency change may and may not do |
| 4 | 15 | Tabletop | `docs/compliance/INCIDENT_TABLETOP_2026.md`: walk inject 1 and inject 2 now (the full exercise is row I-1, due 2027-01-31). | answer the last checklist item there: could the backup person do the containment steps alone (sign out everywhere, disable the Cognito user, reset TOTP through `admin-reset-totp`)? Note each "no" as a gap. |
| 5 | 5 | Who to call | Vendor support routes, stored in the vault (1.4 #1): **AWS** Support Center in the console (check the account's support plan: Basic covers account and billing cases only); **GitHub** support.github.com; **Moov** and **CheckAlt** through the support contact on the ChecksOps account (the tabletop's inject 3 asks whether a Moov contact is on file; fill it in); **Microsoft Azure** portal → Help + support; **Resend** dashboard support; counsel for notification decisions. No phone numbers are recorded in this repository. | find each route in the vault without help |
| 6 | 10 | Restore | `docs/compliance/BCP_DR.md` §1–§3 (targets, scenarios); `ops/security/RESTORE_TEST_RUNBOOK.md` (restore to a **new** instance, never over the live one; check read-only; delete the copy); `ops/security/FILES_BUCKET_REPLICATION_2026_11.md` (files copy in `us-east-2`). Ideally the backup person attends the first restore test (row B-1). | say the RPO and RTO, the first restore step, and why the live instance is never overwritten |

At the end: the backup person reads `docs/compliance/BCP_DR.md` and
`docs/compliance/PERSONNEL_SECURITY.md` §1 if not done already (BCP §4 lists them), and both sign the
record in part 4. Gaps found go on the record with an owner and a date, as in the tabletop.

---

## Part 3 — Offboarding the backup person's access (row A-2, within 24 hours)

When the backup role ends, for any reason, remove every access within 24 hours of the last day, or
immediately on an involuntary end (`docs/compliance/PERSONNEL_SECURITY.md` §5). Name a new backup
person in `docs/compliance/BCP_DR.md` §4 in a PR; until then R9 goes back to its inherent score.

| # | Remove | Verify | Record (time, UTC) |
|---|---|---|---|
| 1 | AWS: remove the permission-set assignments, then disable and delete the Identity Center user. | The user is gone from Identity Center → Users; CloudTrail shows the delete event. | Time; CloudTrail event id |
| 2 | GitHub: remove the collaborator; remove them from each environment's required reviewers if added (1.2 #4); cancel any pending invitation. | Collaborators and environment reviewers no longer list them. | Time; screenshots |
| 3 | Mailboxes: remove the security@ and support@ delegation; remove their SNS subscription if one was added. | Membership gone; subscription gone from the topic. | Time; subscription ARN removed |
| 4 | Password manager: remove them from the shared vault; cancel any emergency-access grant. | Vault members no longer list them. | Time |
| 5 | Vendor consoles (Moov, CheckAlt, any other from 1.4 #2): remove their named users. | Each console no longer lists them. | Time per vendor |
| 6 | Rotate anything they could see that is a secret (personnel policy §5.3). The vault holds contacts, not shared logins, so normally nothing; if an elevated AWS session was used, review its CloudTrail activity. | — | What was rotated, or "nothing to rotate" with the reason |
| 7 | Update `docs/compliance/BCP_DR.md` §4 and the risk register R9 in a PR. | PR merged. | PR link |

Record the A-2 entry (departure date and the time each access was removed) in the restricted
compliance folder and add a dated line to the evidence calendar log with where it is kept.

---

## Part 4 — Evidence record template

This record contains a person's name and email, so it is **stored outside the repository**, in
the restricted compliance folder (`docs/compliance/EVIDENCE_CALENDAR.md`, "Where records go"). The
template below holds only placeholders. After filling it in, add one line to the evidence calendar
log: date, rows (CC9.1, CC6.2, CC6.3, R9), "Backup person access and walkthrough", and where the
record is kept, never its content.

```markdown
# Backup person access and walkthrough, <date> (R9; CC9.1, CC6.2, CC6.3)

**Backup person:** <name> (as in docs/compliance/BCP_DR.md §4). Contact details: <in the restricted folder only>
**Granted by:** <owner's name>, Qualified Individual

## Before access
| Item | Date | Where kept |
|---|---|---|
| Background check | | |
| Confidentiality agreement | | |
| WISP and personnel policy acknowledgment | | |
| Owner's written approval of this access | | |
| Endpoint requirements confirmed | | |

## Access granted
| System | Identity | Role / permission set | Granted (UTC) | Granted by | MFA verified (how, when) |
|---|---|---|---|---|---|
| AWS Identity Center | user id <id> | <day-to-day set and its policies> | | | |
| AWS Identity Center, elevated | <same user> | <none / AdministratorAccess / custom>, decision <a/b/c> | | | |
| GitHub | <account> | collaborator (write); production reviewer: <yes/no>, prevent self-review <on/off> | | | 2FA screenshot |
| security@ and support@ mailboxes | <own mailbox> | <delegate / group member> | | | |
| SNS alerts | <via support@ / subscription ARN> | — | | | |
| Password manager vault | <own account> | member | | | |
| Vendor consoles | <one row per vendor> | <role> | | | |

Not granted: IAM user, access keys, root credentials (checked <date>).

## Walkthrough
Date: <date>. Length: <minutes>. Steps done: <1–6 from ops/security/BACKUP_PERSON_ACCESS.md part 2>.

| # | Gap found | Fix | Owner | Due | PR / task |
|---|---|---|---|---|---|
| 1 | | | | | |

## Owner decisions
- Elevated AWS access: <a / b / c>, reason:
- Production environment reviewer: <yes / no>, reason:
- Root emergency path: <none / delayed emergency access / sealed with counsel>
- Password manager used: <product>

Signed: ______________________ (Qualified Individual)  Date: __________
Signed: ______________________ (Backup person)         Date: __________
```

## What this document does not do

- It grants no access and changes no AWS, IAM Identity Center, GitHub, mailbox, SNS or password
  manager setting. Each step above is the owner's action, made on the owner's decision.
- It does not change the `production` environment's reviewers or the branch rules; 1.2 #4 is a
  decision for the owner.
- It does not re-read live AWS state. The facts cited (Identity Center users, alarms, the security@
  subscription state, GuardDuty) are from the dated records it links; re-read them before relying
  on them.
- It does not change the risk register's R9 score; that follows once the record in part 4 exists.
