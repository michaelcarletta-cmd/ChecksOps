# Phase 3B.14P1 — production Cognito identity link repair

Operator record of a live `checksops` data repair. No MFA change. No CheckAlt. No money movement.

## Why

Live `checksops.com` `/prep` authenticates against production pool `us-east-1_h00WorYMT`. The Freedom admin application user was still linked to the staging Cognito sub, so `GET /prep/identity/me` returned `identity_not_linked` after production token refresh.

## Schema model (inspected live)

`public.identity_accounts` is **one row per application user, one Cognito sub**:

- `PRIMARY KEY (application_user_id)`
- `UNIQUE (cognito_sub)`
- `UNIQUE (lower(email))` where email is not null

Login resolver (`LOOKUP_MAPPING_SQL` in `aws/functions/api/identity.mjs`) looks up **by `cognito_sub`**, not email.

Option A (second row for the production sub) is **not supported**. A second row would violate the primary key and the email unique index.

Option B (replace `cognito_sub` on the existing row) is the intended repair.

## Applied

Database: `checksops` as `checksops_admin` via `checksops-staging-rehearsal-oneshot` (restored to golden SHA after).

```sql
UPDATE public.identity_accounts
   SET cognito_sub = 'a45884b8-d051-70b3-b19d-ca704964c6e8',
       linked_at = now()
 WHERE application_user_id = '7dbb3009-f059-4767-b5dc-1c5c72379330'
   AND cognito_sub = 'c4386408-60e1-70e2-abb6-e6194e8e635f'
   AND status = 'active';
```

Rows changed: **1**. Table row count unchanged (11). `tenant_users`, `user_roles`, `profiles`, MFA, and provider flags were not modified.

| Field | Before | After |
|---|---|---|
| `cognito_sub` | staging `c4386408-60e1-70e2-abb6-e6194e8e635f` | production `a45884b8-d051-70b3-b19d-ca704964c6e8` |
| `status` | `active` | `active` |
| `linked_at` | `2026-09-10T19:03:55.851Z` | `2026-09-10T19:53:46.520Z` |
| Freedom membership | 1 × admin | 1 × admin |
| `user_roles` | `admin` | `admin` |

Staging sub no longer resolves. That is required by the schema. Staging pool MFA remains OFF.

## Human next step

Do **not** reuse stale `checksops.com` localStorage tokens.

1. Sign out of ChecksOps
2. Close the ChecksOps tab
3. Reopen `https://checksops.com`
4. Sign in again with production login
5. Retry Deposit Verification on a fresh authenticator window

Provider flags stay false. Successful TOTP must still stop before CheckAlt HTTP.
