# Incident response tabletop, 2026–27 (evidence row I-1)

**Facilitator:** Michael Carletta, CEO (Qualified Individual). **Participants:** everyone who would
be called in a real incident. At minimum the owner and the backup person, Austin Sukanick.
**Length:** 1 hour. **When:** by 2027-01-31 (calendar row I-1), and once a year after that.
**Matrix rows:** CC7.3, CC7.4 (`docs/compliance/SOC2_CONTROL_MATRIX.md`).
**Plans under test:** `docs/INCIDENT_RESPONSE.md` (roles, notification clocks) and
`aws/cutover/INCIDENT_RESPONSE_AWS.md` (§1 severity, §2 evidence, §3 credentials, §6 account
takeover, §8 payments).

A tabletop is a discussion, not a drill: nobody touches production. The facilitator reads each
inject in order, the group says what it would do and who would do it, and the scribe writes down
the decisions and every gap ("we didn't know how to…", "the runbook says X but…").

## Scenario: a tenant's email is taken over, then a payee bank change

ChecksOps tenants move real money. Every member of a tenant has full access, money included
(`docs/WISP.md` §3.1), so the most likely serious incident is an attacker who gets into one
member's email account.

### Inject 1 — Monday 09:10

The office manager at a tenant (a public adjuster firm) emails security@checksops.com: "I got a
ChecksOps sign-in code I didn't ask for, then a 'set up your authenticator' email. Is this you?"

- What severity is this (`INCIDENT_RESPONSE_AWS.md` §1)? Who is incident commander?
- What do you check first, and where? (Cognito user status, the API's sign-in and step-up logs,
  `financial_stepup_log` for the user's `login.mfa` rows.)
- Login MFA has been on since 2026-11-06: what can the attacker do with the email code alone?
  (Answer: nothing past the authenticator screen. Can they enroll their **own** authenticator? An
  emailed setup code goes to the same inbox, so yes, if the user had none.)
- What do you tell the tenant right now, and what do you ask them?

### Inject 2 — 09:40

The logs show the user **had no authenticator**. At 08:52 someone completed first-time setup from
an unfamiliar IP, then opened Payees and changed the bank account on a homeowner payee.

- Now what severity? What do you contain first, in what order? (§6: global sign-out, disable the
  Cognito user, reset the TOTP through `admin-reset-totp`; then the payee change.)
- How do you preserve evidence before changing anything (§2)?
- Was any money sent? Where do you look (`payment_event_log`, Moov dashboard)?
- Who has to approve putting the payee back, and how is the right bank account confirmed (not by
  replying to the same email)?

### Inject 3 — 10:30

A $14,200 disbursement to the changed bank account was approved at 09:05 and is now pending at
Moov.

- How do you stop it? Who calls Moov, and is there a number on file? (§8: providers stay as they
  are; do not turn on anything new in an incident.)
- If it has already settled: what are the recall and return options and their deadlines?
- Does this trigger any notification (`docs/INCIDENT_RESPONSE.md` §4): to the tenant within
  72 hours, to the homeowner, to the FTC (500+ consumers' unencrypted NPI, so likely not), to
  state AGs? Who decides, and by when?

### Inject 4 — the next day

The tenant asks for a written explanation for their carrier and their customer.

- Who writes it, who approves it (the CEO, `docs/INCIDENT_RESPONSE.md` §2)?
- What goes in the post-mortem (`docs/incidents/YYYY-MM-DD.md`, within 14 days)?
- What would have prevented it? (For example: notifying the tenant's other members when someone
  enrolls an authenticator, or requiring an existing member to approve payee bank changes.)

### Wrap-up (10 minutes)

For each gap found: what changes (runbook, code, training, contract), who owns it, and by when.
Each fix becomes a PR or a task with a date.

## Questions to answer during the exercise (scribe ticks each)

- [ ] Everyone knew how a report reaches us (security@checksops.com) and who reads it.
- [ ] The incident commander was clear within 5 minutes.
- [ ] We could find the logs for one user's sign-ins and step-ups without help.
- [ ] We knew how to sign a user out everywhere and lock them out.
- [ ] We knew how to stop or recall a Moov payment, and had the contact.
- [ ] We knew the notification clocks: 24 hours internal, 72 hours tenant, 30 days FTC.
- [ ] The backup person could have done the containment steps alone.

## Record (copy to `docs/compliance/evidence/<date>-I-1-tabletop.md`)

```markdown
# Incident tabletop, <date> (row I-1)

**Scenario:** tenant email takeover → authenticator enrolled → payee bank change → disbursement
(docs/compliance/INCIDENT_TABLETOP_2026.md)
**Facilitator:** <name>. **Attendees:** <names and roles>. **Length:** <minutes>.

**Checklist:** <n of 7 ticked; which were not>

**Gaps found**
| # | Gap | Fix | Owner | Due | PR / task |
|---|---|---|---|---|---|
| 1 | | | | | |

**Decisions made:** <e.g. who calls Moov, where the Moov contact is kept>

Signed: ______________________ (Qualified Individual)  Date: __________
```
