# Feature Verification — Mortgage Ops authenticated acceptance

**Recorded:** 2026-09-23T19:05Z  
**Environment:** AWS staging only  
**Production:** not modified  
**Cognito / `/prep` / money paths:** not changed  

Previous unauthenticated baseline remains accepted. This run attempted the remaining authenticated desk gap and **stopped** when completing EMAIL_OTP required Cognito email-routing changes.

## Verdict

**MORTGAGE OPS — BLOCKED** for authenticated desk acceptance.

The existing identity model still represents Mortgage Ops. EMAIL_OTP **start** works for the only confirmed existing staging agent. EMAIL_OTP **verify** could not be completed in this environment because Cognito sends the code with `COGNITO_DEFAULT` to the agent’s `@checksops.invalid` address. That path is **not** the application `AWS_EMAIL_MODE=sink` / `email_send_log` sink.

Routing Cognito OTP through the app sink would require a Cognito CustomEmailSender or SES `DEVELOPER` email config. That is a frozen auth/SES change. **STOP. Not implemented.**

## A. Identity used

| Candidate | Cognito | Status | EMAIL_OTP | Used for desk |
|---|---|---|---|---|
| `staging-mops-4b61bc@checksops.invalid` (“Staging Mortgage Agent”) | `us-east-1_vPmQ7cL1F` sub `b4d8d428-2081-706b-04b0-e4694e568059` | **CONFIRMED**, enabled | **Start 200** `challenge=EMAIL_OTP`, destination `s***@c***` | Verify not completed — no readable mailbox |
| `staging-mops-uat-*@checksops.invalid` (3 users) | same pool | `FORCE_CHANGE_PASSWORD` | **409** `email_otp_unavailable` (PASSWORD / PASSWORD_SRP only) | Not usable; app password login is 410 |
| `claims@freedomadj.com` | **UserNotFoundException** | Historical app snapshot `mortgage_agent` (`b100f05d-…`) | Start 200 is **enumeration-suppressed fake** (user absent) | Not a live Cognito identity |
| `checksops-tester@freedomadj.com` | CONFIRMED | Freedom **staff**, not desk agent | Start 200 to `c***@f***` | Not used — wrong role (desk kicks `staff`) |
| `checksopsadmin@gmail.com` | CONFIRMED | Platform-owner mailbox | Start 200 to `c***@g***` | Not used — not the requested existing `mortgage_agent`; mailbox not in this agent |

Primary intended identity: **`staging-mops-4b61bc@checksops.invalid`**.

## B. Role / membership mapping

Intended chain (unchanged, not redesigned):

Cognito sub → `identity_accounts.application_user_id` → `user_roles` / `tenant_users` → Mortgage Desk (`mortgage_agent` or `admin`).

Hire still refuses staff/admin combinations. Desk portal session key remains `checksops.aws.staging.auth.mortgage-ops`.

Historical snapshot (`aws/identity/expected-mappings.mjs`) still lists `claims@freedomadj.com` as `mortgage_agent` with tenant slug `null`. That Cognito user is **gone**. Application role without a live Cognito user is not a login identity.

## C. EMAIL_OTP result

| Step | Result |
|---|---|
| `POST /staging/auth/passwordless/start` for confirmed mops agent | **200** `EMAIL_OTP`, `passwordUsed=false` |
| Delivery | Cognito `EmailSendingAccount=COGNITO_DEFAULT` to `s***@c***` |
| App sink (`AWS_EMAIL_MODE=sink`, `email_send_log`) | **Not used** for Cognito OTP |
| Lambda triggers / CustomEmailSender | **none** on staging pool |
| `POST /staging/auth/passwordless/verify` | **Not called** — code not retrievable |
| Outlook (`claims@freedomadj.com`) | No new Cognito OTP for the existing agent (expected) |

## D–K. Desk steps (not reached)

Login, role recognition, `/mortgage-ops/queue`, assigned items, images, documents, notes/status, write persistence, tenant isolation, and tenant-side visibility were **not** exercised with an authenticated session. No financial activity was manufactured.

Unauthenticated queue still redirects to login (previous accepted result).

## L. Current real-user provisioning workflow

**Do not redesign.** The intended production/staging path today is:

1. Platform owner opens **Admin → Mortgage Ops** (`/admin/mortgage-ops`).
2. **Hire Agent** calls existing `POST /functions/v1/hire-mortgage-agent` (`runHireMortgageAgent`).
3. That function creates/links Cognito user + `identity_accounts` + `profiles` + `user_roles.mortgage_agent` only. Temp password is suppressed / not emailed. Invite is **passwordless**.
4. Agent signs in at `/mortgage-ops/login` with EMAIL_OTP or passkey.

**Tenant Management is not the Mortgage Ops hire path.** It manages `tenant_users` membership. Desk agents are scoped-only and must not also hold `staff`/`admin`.

Leftover hire-UAT users still in `FORCE_CHANGE_PASSWORD` cannot use EMAIL_OTP until they are Cognito-confirmed. Re-enabling password login or `AdminSetUserPassword` to force confirmation is a Cognito/auth change and was **not** done.

## M. Actual defects found

| Observation | Class | Repair? |
|---|---|---|
| Cognito OTP is not written to the application email sink | Cognito email architecture vs app `AWS_EMAIL_MODE=sink` | **STOP** — would touch Cognito/SES |
| Confirmed existing agent mailbox is `@checksops.invalid` | isolated test identity; no readable sink | missing tester mailbox / config, not a desk code defect |
| Three hire-UAT agents stuck in `FORCE_CHANGE_PASSWORD` with password API 410 | leftover hire confirmation state | do not reopen password login |
| `claims@` historical `mortgage_agent` has no Cognito user | missing identity mapping / deleted Cognito user | do not recreate Cognito outside hire; do not alter Freedom |
| No authenticated queue/image/document failure | **not demonstrated** | no code repair |

No actual software defect was shown that blocks the desk **after** a valid Cognito session. The blocker is completing EMAIL_OTP for the existing isolated agent without changing Cognito.

## N. MORTGAGE OPS — BLOCKED

Blocked on authenticated acceptance only.

To unblock **without** reopening architecture, an operator must complete EMAIL_OTP (or an existing passkey) for `staging-mops-4b61bc@checksops.invalid` using a mailbox they can read, **or** confirm that an existing mapped agent already has a real allowlisted mailbox and use that identity. Do not install CustomEmailSender, do not switch the staging pool to SES from this workstream, do not promote staging, and do not modify production.

## Explicit non-actions

- No production deploy or flag change
- No Cognito pool/email/trigger change
- No hire of a new agent
- No `AdminSetUserPassword`
- No CheckAlt / Moov / OCR / SES architecture change
- No Freedom production record change
