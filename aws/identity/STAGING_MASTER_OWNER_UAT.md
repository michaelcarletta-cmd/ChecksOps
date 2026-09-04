# Staging master/admin UAT — ACTIVATED

**Status:** activated on AWS staging Cognito (2026-09-04).  
**Scope:** AWS staging Cognito + existing `identity_accounts` mapping only. Production identity unchanged.

## Goal

Authenticate in staging as the existing master application principal so platform-owner surfaces work under real `is_master_owner()` / UUID gates:

`7dbb3009-f059-4767-b5dc-1c5c72379330`

## Non-negotiables (preserved)

| Constraint | Status |
| --- | --- |
| Tester UUID `abd3c2a0-…` | Unchanged — still Freedom staff/operator |
| Do not promote tester | Confirmed — no `user_roles` / master grant to tester |
| `is_master_owner()` | Unchanged SQL helper |
| Production identity/auth | Unchanged |
| Fake application admin | Not created — uses existing Cognito→app UUID mapping |
| Tenant isolation / RLS | Master sees all tenants via existing RLS; tester remains Freedom-only |

## How to log in as master (staging)

1. Open `https://staging.checksops.com/login`
2. Click **Use staging password (master UAT)**
3. Email: `staging-master@checksops.invalid`
4. Password: retrieve from AWS Secrets Manager secret  
   `checksops/staging/master-uat-password`  
   (or ask the staging operator who activated Cognito `AdminSetUserPassword` for this batch).  
   Cognito user sub: `54a8b4c8-60d1-7028-cfbb-0eb2baee5592`
5. Submit **Sign in with password**
6. Expected redirect: `/admin/tenants` (platform-owner UUID gate)
7. Confirm `/identity/me` shows:
   - `applicationUserId` = `7dbb3009-f059-4767-b5dc-1c5c72379330`
   - `isMasterOwner` = `true` (after this batch’s API deploy)
   - Cognito email may be `staging-master@checksops.invalid`; profile email can still show the historical production profile address — UI gates prefer UUID

### Tester login (unchanged)

- Email OTP: `mcarletta@freedomadj.com` → application UUID `abd3c2a0-…`
- Do **not** use the master password path for ordinary Freedom staff UAT

### EMAIL_OTP / passkeys

Ordinary EMAIL_OTP and HTTPS Cognito passkeys remain available on the same login page. The password toggle is staging-only UI for master UAT.

## What was applied

1. Cognito master user email set to verified `staging-master@checksops.invalid` (does not steal `mcarletta@` OTP mapping).
2. Permanent password set via Cognito `AdminSetUserPassword` (staging only).
3. Frontend `isPlatformOwner(email, userId)` prefers application UUID `7dbb3009-…`.
4. `/identity/me` returns `isMasterOwner` from `public.is_master_owner()`.
5. Read RPCs `is_master_owner` / `is_platform_owner` allowlisted for staging.

## Rejected alternatives (still rejected)

| Alternative | Why not |
| --- | --- |
| Remap `mcarletta@` → `7dbb3009-…` | Breaks Freedom staff UAT |
| Grant master to `abd3c2a0-…` | Forbidden privilege escalation |
| Change `is_master_owner()` SQL | Production identity risk |
| Dual-map one Cognito user to two app UUIDs | Breaks `auth.uid()` uniqueness |

## Verification checklist

- [x] Master password login → `7dbb3009-…`
- [x] Master `/data/query` tenants → 6 tenants (RLS master visibility)
- [x] Tester EMAIL_OTP mapping still `abd3c2a0-…` (unchanged Cognito email `mcarletta@freedomadj.com`)
- [x] UI: AdminTenants / Manage tabs / Platform Finance / Financial Model visible as master
- [x] Tester `is_master_owner()` false; master true (SQL helper unchanged)
- [x] Moov / CheckAlt / Plaid still `provider_disabled` / not executed
