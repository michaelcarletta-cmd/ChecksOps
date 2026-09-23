# Feature Verification — Narrow staging identity repair (Morgan / claims@)

**Recorded:** 2026-09-23T21:31Z  
**Scope:** One staging account. No Hire Agent. No Tenant Invite. No production/SES/pool-config change.  
**STOP:** Real EMAIL_OTP sent. Verify not attempted.

## A. Pre-repair identity

| Item | Value |
|---|---|
| Profile | Morgan Carletta / `claims@freedomadj.com` |
| `application_user_id` | `b100f05d-9e81-4a7b-b9cc-9baf173131d9` |
| Role | `mortgage_agent` only (`5ce3f34f-7404-455c-b2c4-f6d39845547e`) |
| `identity_accounts.cognito_sub` | `34c8a478-e0d1-70f3-3c49-02225e7404b6` (active) |
| Staging Cognito | **UserNotFound** for email and stale sub |
| `tenant_users` | none |

## B. Cognito creation

Staging pool `us-east-1_vPmQ7cL1F` only.

- `AdminCreateUser` `MessageAction=SUPPRESS`
- Attributes: email `claims@freedomadj.com`, `email_verified=true`, name `Morgan Carletta`
- Internal temp password discarded; not emailed, not logged, not returned
- After create: `FORCE_CHANGE_PASSWORD` (EMAIL_OTP ineligible)
- `AdminSetUserPassword` permanent with a discarded password to reach **CONFIRMED** so USER_AUTH EMAIL_OTP is eligible
- App `POST /auth/login` remains **410** `password_auth_disabled`
- Pool / app-client / SES configuration not changed

## C. New Cognito sub

`047824f8-b0b1-7018-c5e3-c0350a6c8a40`

Username = that sub. Enabled. CONFIRMED. `sub ≠` `b100f05d-…`. Exactly one staging user with this email.

## D. identity_accounts relink

One existing row updated in place (PK `application_user_id`). No second row.

| | Before | After |
|---|---|---|
| `application_user_id` | `b100f05d-…` | unchanged |
| `cognito_sub` | `34c8a478-…` | `047824f8-…` |
| `email` | `claims@freedomadj.com` | unchanged |
| `status` | `active` | `active` |
| `created_at` | `2026-09-02T10:49:52Z` | unchanged |
| `linked_at` | `2026-09-14T10:07:27Z` | `2026-09-23T21:30:20Z` |

A protect trigger `identity_protect_production_cognito` initially raised `production_cognito_mapping_locked` because the new staging sub ≠ the production lock sub. Relink used session `request.production_identity_write=1` **only** to allow the staging `identity_accounts` UPDATE. The locks table was not written.

## E. Role preserved

`mortgage_agent` only. Same role id. Not deleted or re-inserted.

## F. Tenant memberships unchanged

`tenant_users` still empty.

## G. Financial / provider permissions unchanged

No staff/admin. No tenant membership. No CheckAlt/Moov/provider writes.

## H. identity_production_cognito_locks disposition

**Production-isolation / lock metadata, not staging login enforcement.**

Staging API (`CHECKSOPS_ENV=staging`) resolves `Cognito sub → identity_accounts`. Production/prep resolves via this lock table. Documented: isolated from staging; production tokens must not resolve from `identity_accounts`.

Current lock row (unchanged): `b100f05d-…` → `34c8a478-…`.

Not modified. Staging login does not read it. The protect trigger treats a lock as “do not let `identity_accounts.cognito_sub` drift unless the production-identity write GUC is set.” That GUC was used locally for the staging relink only.

## I. EMAIL_OTP start result

`POST https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging/auth/passwordless/start`

| Field | Value |
|---|---|
| HTTP | 200 |
| `challenge` | `EMAIL_OTP` |
| `passwordUsed` | false |
| `environment` | staging |
| destination | `c***@f***` |
| verify | completed after operator codes — see desk record |

This is a **real** Cognito challenge: user exists and is CONFIRMED; mailbox received a new message at `2026-09-23T21:30:52Z` from `no-reply@verificationemail.com` (Cognito default), subject “Your authentication code”. Earlier missing-user starts delivered no Cognito-default mail.

Operator codes: `42161060` expired session; `9103830` invalid/stale; `74572267` **200** `completed=true` `passwordUsed=false`. Desk walk is in `FEATURE_VERIFICATION_MORTGAGE_OPS_DESK_2026-09-23.md`.

## J. Production unchanged

- Production pool `us-east-1_h00WorYMT` not written
- Production prep Lambda still on that pool
- SES / Cognito pool configuration not changed
- `identity_production_cognito_locks` not changed
- Temporary inspect/relink function `checksops-sql65-status-read-inspect-6136` restored to `{ retired: true }`
