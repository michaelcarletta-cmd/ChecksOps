# Feature Verification — Existing claims@ Mortgage Ops reconcile (read-only)

**Recorded:** 2026-09-23T21:16Z  
**Nature:** Read-only. No hire. No revoke. No role change. No Cognito/SES/production mutation.  
**Rehire plan:** **WITHDRAWN.** Do not revoke or create a second application user.

## Verdict

The Admin UI is showing the **correct existing** Mortgage Ops application account. Authentication is broken because `identity_accounts` points at a **dead staging Cognito sub**. There is **no** existing product path (Hire Agent, password-reset key, tenant invite, or applyLinks) that recreates that Cognito user and relinks it **without** deleting/recreating the application user or first removing `mortgage_agent`.

## Exact stale link

```
identity_accounts
  application_user_id  =  b100f05d-9e81-4a7b-b9cc-9baf173131d9
  cognito_sub          =  34c8a478-e0d1-70f3-3c49-02225e7404b6   ← NOT in staging pool
  email                =  claims@freedomadj.com
  status               =  active
  linked_at            =  2026-09-14T10:07:27.787Z
  created_at           =  2026-09-02T10:49:52.986Z
```

Staging pool `us-east-1_vPmQ7cL1F`: `AdminGetUser` on the email, this sub, historical snapshot sub `2498c4b8-f0a1-701b-da4b-a1f5c79f675a`, and the application UUID are all **UserNotFound**. `list-users` `email = "claims@freedomadj.com"` and `email ^= "claims@"` return **zero** users. Login lookup is `Cognito sub → identity_accounts` (`LOOKUP_MAPPING_SQL`). A missing user never produces a live sub, so `/identity/me` cannot resolve.

## Answers

### 1. What application account the UI displays

Admin → Mortgage Ops → **Active Mortgage Ops Personnel** loads `user_roles` where `role = mortgage_agent`, then `profiles` for those `user_id`s. It does not call Cognito.

Displayed row: **Morgan Carletta** / `claims@freedomadj.com` / `user_id` `b100f05d-9e81-4a7b-b9cc-9baf173131d9`.

### 2. Application user UUID

`b100f05d-9e81-4a7b-b9cc-9baf173131d9`  
`profiles`: email `claims@freedomadj.com`, full_name `Morgan Carletta`, created `2026-07-15T19:14:51Z`.

### 3. mortgage_agent role

Exactly one role:

| role id | user_id | role |
|---|---|---|
| `5ce3f34f-7404-455c-b2c4-f6d39845547e` | `b100f05d-…` | `mortgage_agent` |

No `admin`, `staff`, or other `app_role`. No `tenant_users` rows.

### 4. identity_accounts record

One row (columns: `application_user_id`, `cognito_sub`, `email`, `status`, `linked_at`, `created_at`). Values in **Exact stale link**. No second claims@ mapping.

### 5. Cognito sub stored in identity_accounts

`34c8a478-e0d1-70f3-3c49-02225e7404b6`

### 6. Does that exact sub exist in the staging pool?

**No.** `AdminGetUser(34c8a478-…)` → `UserNotFoundException`.

### 7. Does claims@ exist in staging Cognito under a different sub?

**No.** Email filter empty. Historical snapshot sub `2498c4b8-…` also UserNotFound. Application UUID is not a Cognito username.

### 8. Why the UI looks active while Cognito is UserNotFound

The personnel table is **role-directory**, not login-directory. Title is “Active Mortgage Ops Personnel” because a `mortgage_agent` row exists. Cognito is only consulted at `/mortgage-ops/login` EMAIL_OTP / passkey. PreventUserExistenceErrors still returns a fake `EMAIL_OTP` start for a missing user; no mail is delivered.

### 9. Supported repair/reinvite/relink without deleting the application user

| Existing workflow | Preserves app UUID? | Works on this row? |
|---|---|---|
| Hire Agent `runHireMortgageAgent` | Yes, if profile exists and role is **not** already `mortgage_agent` | **No** — 409 `User already has mortgage ops access` **before** `AdminCreateUser` |
| Hire after revoke | Same UUID after re-insert role | **Forbidden** — deletes the role the UI is showing |
| applyLinks (identity oneshot) | Yes, for **pending / null sub** rows only | **No** — this row is already `status=active` with a non-null sub |
| Cutover onboard (`COGNITO_ONBOARD.md`) | Yes, one-time pending→active | **No** — not a product control; expects pending rows |
| Tenant invite | Can reuse profile | **No** — writes `tenant_users`; Mortgage Ops must stay scoped-only |
| Production locks table | N/A for staging login | Staging API does not resolve via `identity_production_cognito_locks`. That table currently also stores the same dead sub → `b100f05d-…`. **Do not mutate it. Do not touch the production pool.** |

There is **no** existing supported AWS product API that issues `AdminCreateUser` + updates this already-active `identity_accounts` row while leaving `user_roles.mortgage_agent` in place.

### 10. Is Hire Agent appropriate? Is there a resend/reinvite/reactivate path?

**Hire Agent is not appropriate** for an existing `mortgage_agent`. It is the first-grant path. A second hire is designed to 409.

The only other Admin Mortgage Ops control is the key icon (`sendPasswordReset` → `POST /auth/forgot`). On AWS staging that is **tester-mailbox only** (`checksops-tester@freedomadj.com`). For `claims@` it returns `sent: false, suppressed: true`. It cannot create a missing Cognito user. Staging password login remains 410.

`mortgage-agent-invite` mail is sent only from a successful hire, not from a resend action.

## Intended identity model (not implemented as a recovery button)

Documented cutover rule still stands: later Cognito invites must match email and write the **new** `sub` onto the **same** `application_user_id`. Do not mint a second ChecksOps UUID for Morgan.

A future repair, if authorized separately, would have to:

1. Keep `b100f05d-…` / `mortgage_agent` / no tenants.
2. Create the missing staging Cognito user for `claims@freedomadj.com` (`MessageAction=SUPPRESS`).
3. Point **staging** `identity_accounts.cognito_sub` at that new sub (`sub ≠ application_user_id`).
4. Leave production pool and `identity_production_cognito_locks` unchanged.

That is **not** available as Hire Agent or as a resend button today. Not implemented in this run.

## Explicit non-actions

- No revoke, no hire, no role write
- No `AdminCreateUser` / `AdminSetUserPassword` / SES / pool change
- No production pool or lock mutation
- Temporary read-only inspect on `checksops-sql65-status-read-inspect-6136` restored to `{ retired: true }`
