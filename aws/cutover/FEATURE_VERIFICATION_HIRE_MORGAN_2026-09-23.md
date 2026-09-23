# Feature Verification — Hire Morgan Carletta (STOP after hire/OTP)

**Recorded:** 2026-09-23T20:50Z  
**Environment:** AWS staging only  
**Production:** not modified  
**Cognito pool / SES / password login:** not changed  

Tester requested: **Morgan Carletta** / `claims@freedomadj.com` / temporary password blank / `mortgage_agent` via existing **Admin → Mortgage Ops → Hire Agent**. Then start staging EMAIL_OTP and **STOP**.

## Verdict

**REHIRE PLAN WITHDRAWN.** See `FEATURE_VERIFICATION_CLAIMS_RECONCILE_2026-09-23.md`.

The UI is already showing the existing Morgan Carletta / `claims@` application account. Do not revoke. Do not hire a second account. Hire Agent is the first-grant path and would 409; it is not a relink/reinvite for this row.

Earlier stop: Hire + claims EMAIL_OTP were not completed. A claims@ passwordless start without a live Cognito user is an enumeration-suppressed fake challenge.

Do not treat the earlier `POST /staging/auth/passwordless/start` for `claims@freedomadj.com` as a real OTP. Inbox and junk had no new Cognito authentication mail after that call.

## A. Staging targets — still PASS (unchanged)

| Setting | Live value |
|---|---|
| API | `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging` |
| Frontend | `https://staging.checksops.com` |
| `CHECKSOPS_ENV` | `staging` |
| `COGNITO_USER_POOL_ID` | `us-east-1_vPmQ7cL1F` |
| Production pool (not used) | `us-east-1_h00WorYMT` |
| DB | `checksops` (role `checksops` on `/db-health`) |
| Hire unauthenticated | 401 `missing_cognito_token`, `environment=staging` |

No production Lambda, pool, or SES change.

## B. Form that will be submitted (not submitted)

Admin → Mortgage Ops → **Hire Mortgage Ops Agent**:

| Field | Value |
|---|---|
| Full name | `Morgan Carletta` |
| Email | `claims@freedomadj.com` |
| Temporary password | **blank** (passwordless invite) |

API body: `{ full_name, email }` only. Password omitted.

## C. Live staging identity for claims@ — Cognito missing

Read-only inspect of staging RDS `checksops` (transaction read-only). Production not opened.

| Item | Result |
|---|---|
| `profiles` | **present** `b100f05d-9e81-4a7b-b9cc-9baf173131d9` / Morgan Carletta / `claims@freedomadj.com` |
| `user_roles` | **`mortgage_agent` only** (role id `5ce3f34f-7404-455c-b2c4-f6d39845547e`) |
| `identity_accounts` | **stale** row: sub `34c8a478-e0d1-70f3-3c49-02225e7404b6` → app `b100f05d-…`, status `active` |
| Historical snapshot sub | `2498c4b8-f0a1-701b-da4b-a1f5c79f675a` — also **UserNotFound** |
| Staging Cognito `AdminGetUser(claims@)` | **UserNotFoundException** |
| Staging Cognito `AdminGetUser(stale sub)` | **UserNotFoundException** |
| `tenant_users` | **none** |
| Staff / admin / platform roles | **none** |
| Freedom provider credential tables checked | `tenant_openai_keys`, `tenant_provider_credentials`, `checkalt_credentials`, `moov_credentials`, `tenant_secrets` — **relations do not exist**; no inherited provider rows |

Application user is the correct historical Mortgage Ops user. Cognito login identity is gone. Mapping is leftover.

## D. Why Hire Agent was not invoked

`POST /functions/v1/hire-mortgage-agent` requires a Cognito JWT whose mapped user is `user_roles.admin` **or** `is_master_owner()`. On staging, `is_master_owner()` is `is_platform_owner()` — the `checksopsadmin@gmail.com` application user `233c588f-dc33-4307-8c3f-3da49c9fd2b3` (Cognito sub `84e85408-b091-7058-a111-1d9a84e78da0`, CONFIRMED, enabled).

The SPA Hire Agent page is also gated to that mailbox.

This agent:

* opened `https://staging.checksops.com/login` (passwordless only; staging banner)
* started platform-owner `POST /staging/auth/passwordless/start` → 200 `EMAIL_OTP`, destination `c***@g***`, `passwordUsed=false`
* cannot read `checksopsadmin@gmail.com` (Outlook session is `claims@freedomadj.com`; Gmail is not signed in on this VM)
* did **not** verify that admin OTP
* did **not** call hire
* did **not** `AdminCreateUser` outside hire
* did **not** `AdminSetUserPassword`
* did **not** reopen password login

`checksops-tester@freedomadj.com` remains **staff** and cannot hire.

## E. Hire 409 risk (existing workflow still required)

`runHireMortgageAgent` returns **409** `User already has mortgage ops access.` when `user_roles.mortgage_agent` already exists — **before** Cognito create.

So even after platform-owner login, a single Hire submit will **not** recreate the missing Cognito user.

The existing Admin Mortgage Ops UI already has **revoke access** (`user_roles` delete) and **Hire Agent**. Required existing sequence after admin OTP:

1. Sign in at `https://staging.checksops.com/login` as `checksopsadmin@gmail.com` (EMAIL_OTP).
2. Admin → Mortgage Ops.
3. Revoke the existing `claims@` `mortgage_agent` row (no tenant/provider rows to keep).
4. Hire Agent: Morgan Carletta / `claims@freedomadj.com` / password blank.
5. Confirm new staging Cognito user + `identity_accounts` (new sub ≠ `b100f05d-…`) + `mortgage_agent` only.
6. Then `POST /staging/auth/passwordless/start` for `claims@freedomadj.com` and **STOP**.

No parallel `AdminCreateUser`. No Cognito/SES config change.

## F. EMAIL_OTP for claims@ — not sent (real)

| Call | Result |
|---|---|
| `POST /staging/auth/passwordless/start` `{email: claims@freedomadj.com}` | HTTP 200 `EMAIL_OTP` destination `c***@f***` |
| Cognito user | **absent** |
| `claims@` inbox / junk after the call | **no** new “Your authentication code” |
| Classification | PreventUserExistenceErrors **fake** challenge |

Verify was **not** called. No claims@ OTP is waiting for the operator.

A later real OTP will use Cognito `COGNITO_DEFAULT` to `claims@freedomadj.com` (not the app `AWS_EMAIL_MODE=sink`). Outlook is that mailbox; the operator retrieves the code. This agent will not verify it until the operator supplies it.

## G. Isolation snapshot (pre-hire)

| Check | Result |
|---|---|
| Tenant membership | none |
| Platform / staff / admin roles | none |
| Financial / deposit permissions | no staff/admin; no CheckAlt/Moov rows |
| Freedom provider credentials | none on this user |
| Application UUID | `b100f05d-9e81-4a7b-b9cc-9baf173131d9` (keep; do not replace with Cognito sub) |

## H. Explicit non-actions

- No production deploy, flag, pool, or SES change
- No Cognito user-pool / app-client / CustomEmailSender / password-auth change
- No hire API success
- No claims@ EMAIL_OTP verify
- No CheckAlt deposit / Moov transaction
- Temporary read-only inspect on retired function `checksops-sql65-status-read-inspect-6136` was restored to `{ retired: true }`

## I. STOP

Stopped before Hire Agent create and before a real `claims@freedomadj.com` EMAIL_OTP.

To continue on the existing path, complete platform-owner EMAIL_OTP for `checksopsadmin@gmail.com` (or paste that staging code into this run). Then this run will revoke+hire in Admin Mortgage Ops, verify mapping, start claims@ EMAIL_OTP, and **STOP** again for the operator-supplied claims@ code.
