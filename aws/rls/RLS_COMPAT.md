# AWS staging RLS / authorization compatibility

Cognito authenticates. Database authorization uses the preserved ChecksOps UUID:

```
Cognito ID token sub
  -> public.identity_accounts.application_user_id
  -> SET LOCAL request.app_user_id
  -> auth.uid()
  -> tenant_users / user_roles / aws_user_tenant_ids()
```

Do not use the Cognito `sub` as an application UUID. Do not restore all 380 original policies. Do not enable RLS on restored tables in this phase. Do not invite the 9 production users.

## Classification (approved backup, public schema)

| Class | Count |
| --- | ---: |
| directly_portable | 356 |
| requires_modification | 8 |
| server_side_api | 10 |
| obsolete | 6 |
| **policies** | **380** |

163 tables have policies. 165 public tables had RLS enabled in the dump. Two dump tables (`payment_idempotency_keys`, `plaid_webhook_cursors`) have RLS and no policies. Details: `aws/rls/classification/SUMMARY.md`.

Cannot restore blindly:

- 6 obsolete (`service_role` / `anon`)
- 10 server-side open writes / public signature / lead capture
- 8 JWT-email or unscoped `USING(true)` SELECTs
- ~75 portable predicates that use global `has_role(admin|staff)` — tenant admins hold `user_roles.admin`, so those leak across tenants

## What this phase applied (staging `checksops` only)

Applied as `checksops_admin` via temporary Lambda `checksops-staging-rls-oneshot-c48b`, then that Lambda and IAM role were deleted. The API role still has only the `checksops` secret.

| Change | Detail |
| --- | --- |
| Role shim | `authenticated` NOLOGIN; `GRANT authenticated TO checksops`. No `anon` grant. No `service_role` login. |
| Helpers | `aws_user_tenant_ids()`, `aws_is_cross_tenant_reader()` (`is_master_owner` OR `is_platform_owner`, not `user_roles.admin`) |
| EXECUTE | `has_role`, `user_belongs_to_tenant`, `is_tenant_staff`, `is_master_owner`, `is_platform_owner`, mortgage-agent helpers, … |
| Probe table | `public._aws_rls_probe_items` — **only** public table with RLS on |
| Restored tables | RLS remains **off** (transactional ENABLE on `check_intake_items` was rolled back) |
| 47 FKs | Not applied (`aws/rls/FK_RETARGET_PLAN.md`) |

## Proposed SELECT model (not enabled on real tables)

- Session id = `auth.uid()` = `request.app_user_id` = `identity_accounts.application_user_id`
- Tenant scope = `tenant_users` via `aws_user_tenant_ids()`
- App roles = `user_roles` via `has_role(auth.uid(), …)` **inside** that tenant set
- Cross-tenant = `is_master_owner()` / `is_platform_owner()` only
- JWT-email homeowner policies: compare to `auth.email()` after GUC is set from `identity_accounts.email` / `profiles.email`, never the Cognito probe address
- Writes stay API-side
- SQL sketch: `aws/rls/sql/05_proposed_select_policies.sql`

## API

`GET`/`POST` `/authorization/probe` (HTTP API JWT authorizer `5kyjfy`, same pool/client as `/identity/me`). Lambda in VPC cannot fetch Cognito JWKS, so in-process `aws-jwt-verify` is not used when the authorizer is present.

Looks up `identity_accounts` by Cognito `sub` only, sets `request.app_user_id` to the mapped UUID, `SELECT`s the probe table. Query params, `X-User-Id` / `X-Tenant-Id` / `X-Cognito-Sub`, and JSON body ids are ignored.

## Isolation tests (isolated Cognito probe, not a real invite)

Cognito user `staging-identity-probe-c48b@checksops.invalid` / sub `2418c458-c011-70b7-07ac-6b9da2d9415d` mapped `isolated_test` → ChecksOps Tester `abd3c2a0-6dc0-4680-92dd-a013e1141c91` (staff, Freedom operator).

| Check | Result |
| --- | --- |
| Probe table: tester sees `freedom-probe-visible` only | pass |
| Probe table: tester cannot see C1C / Barzzini rows | pass |
| Probe table: C1C admin UUID sees C1C only | pass |
| Probe table: ninth UUID / Cognito sub as `app_user_id` / unset GUC → 0 rows | pass |
| `check_intake_items` transactional RLS then ROLLBACK: tester 182 Freedom, 0 C1C | pass |
| Same: C1C admin 0 Freedom (C1C has 0 intake rows in restore) | pass |
| HTTP GET unauthenticated / invalid bearer | 401 |
| HTTP GET with probe ID token: `authUid` = Tester UUID, not Cognito sub | pass |
| Roles `["staff"]` from `user_roles`; `cognitoGroupsUsed: false` | pass |
| Spoof query / headers / body cannot switch UUID or read C1C probe row | pass |
| `/db-health` still `checksops` / `checksops` | pass |
| Public tables with RLS after tests | `_aws_rls_probe_items` only |

## Ninth UUID `dd24eea5-5d12-47d1-999e-d5930c278b7d`

No email guessed. Do not delete, merge, or create Cognito for it.

- `user_roles`: `admin` and `staff`
- `role_version_tracker`: version 2 at 2026-08-26 16:37:57 UTC
- `tenant_vetting_documents.uploaded_by`: Condition One Commercial W9 (`Condition One W9.pdf`, pending) at 16:55 same day
- No `profiles` row, no `tenant_users` row, no contractor profile
- Full public+auth uuid-column scan: only `identity_accounts`, `user_roles`, `role_version_tracker`, `tenant_vetting_documents`
- `auth.users` schema exists but **0 rows restored**, so no email is available from Auth

This is an incomplete application identity: platform `admin`+`staff` were assigned and it uploaded C1C vetting, but it never received a profile or tenant membership. Keep the UUID. Optionally add a `profiles` row with this **same** id after an operator supplies the email.

## 47 skipped `auth.users` FKs

Proposed parent: `identity_accounts(application_user_id)`, same UUID values, dump ON DELETE. **Not applied.** See `aws/rls/FK_RETARGET_PLAN.md`.

## Blockers before enabling staging RLS globally

1. Clear the `isolated_test` mapping before inviting `checksops-tester@freedomadj.com`.
2. Invite/link the 8 known emails; decide how to handle the 9th UUID (email still unknown).
3. Set `request.app_user_id` on **every** authenticated route, not only `/identity/me` and `/authorization/probe`.
4. Do not restore global `has_role(admin|staff)` SELECT policies.
5. Keep open-write / `service_role` / anon / JWT-email policies out until rewritten.
6. Attach 47 FKs only after identity_accounts is complete (including the 9th UUID).
7. JWT authorizer (or NAT/VPC endpoint to Cognito JWKS) on every protected route — Lambda in this VPC cannot fetch JWKS.
8. `FORCE ROW LEVEL SECURITY` is not required for `checksops`, but table owner `postgres` bypasses RLS; do not connect the API as a bypass role.

## STOP

Do not enable RLS globally. Do not invite real users. Do not attach the 47 FKs. Do not change production Lovable/Supabase, `main`, Storage, Moov, CheckAlt, webhooks, DNS, or the production frontend.
