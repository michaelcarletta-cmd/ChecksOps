# Staging master/admin UAT identity mapping (proposal only)

**Status:** proposal — do **not** apply until explicitly approved.  
**Scope:** AWS staging Cognito + `identity_accounts` only. Production identity unchanged.

## Goal

Allow UAT of platform-owner surfaces (`AdminTenants`, manager Deposit Ops hub, master-only Settings tabs) that gate on application UUID:

`7dbb3009-…` via existing `is_master_owner()` / email gates.

## Non-negotiables

| Constraint | Required behavior |
| --- | --- |
| Tester UUID | Keep `abd3c2a0-…` as Freedom staff/operator for ordinary tenant UAT |
| Do not promote tester | Never grant `user_roles.admin` / master to `abd3c2a0-…` |
| `is_master_owner()` | No SQL change; keep production UUID semantics |
| Production | No Cognito/Supabase/auth changes on prod |
| Email OTP | Prefer a deliverable staging inbox; do not steal production mailboxes |

## Current staging facts

| Principal | Application UUID | Cognito | Notes |
| --- | --- | --- | --- |
| Freedom tester | `abd3c2a0-6dc0-4680-92dd-a013e1141c91` | sub `c4386408-…`, email remapped to `mcarletta@freedomadj.com` for OTP | Ordinary staff UAT |
| Master owner | `7dbb3009-…` | Cognito user exists (`54a8b4c8-…`), email displaced to `mcarletta-displaced-staging@checksops.invalid`, typically `FORCE_CHANGE_PASSWORD` | Mapping already present; login not activated for interactive UAT |

## Recommended option (safest)

**Activate the existing Cognito user already mapped to `7dbb3009-…`.**

1. Leave `mcarletta@freedomadj.com` → `abd3c2a0-…` mapping untouched.
2. Set a **staging-only** verified email on the master Cognito user, e.g. `staging-master@checksops.invalid` **or** a dedicated deliverable alias (not production traffic).
3. `AdminSetUserPassword` (temporary) → complete `NEW_PASSWORD_REQUIRED` once → permanent password for UAT.
4. Confirm `/identity/me` returns `application_user_id = 7dbb3009-…` and `is_master_owner()` true under RLS.
5. Confirm tester login still returns `abd3c2a0-…` and `is_master_owner()` false.

### Why this is safest

- No remapping of the active tester email.
- No SQL change to `is_master_owner()`.
- No promotion of `abd3c2a0-…`.
- Uses the identity account that already points at the real master UUID.

## Rejected / deferred alternatives

| Alternative | Why not now |
| --- | --- |
| Remap `mcarletta@` → `7dbb3009-…` | Breaks Freedom staff UAT; conflicts with “do not promote abd3c2a0” workflow that relies on that login |
| Grant master role to tester UUID | Weakens isolation; forbidden |
| Change `is_master_owner()` to include Cognito sub / email | Production identity risk; forbidden |
| Dual-map one Cognito user to two app UUIDs | Breaks `auth.uid()` uniqueness assumptions |

## Optional follow-ups (after approval)

- Document passwords in the staging secrets manager (not git).
- Add a tiny staging-only UI hint when `is_master_owner()` is true (no production change).
- If AdminTenants email gate still checks a hard-coded inbox, align staging Cognito email **or** document the gate; do not weaken production checks.

## Approval checklist before apply

- [ ] Explicit human approval for Cognito email/password activation on master mapping
- [ ] Confirm tester mapping unchanged after change
- [ ] Confirm no production Cognito/Supabase edits
- [ ] Confirm Moov/CheckAlt/Plaid still disabled
