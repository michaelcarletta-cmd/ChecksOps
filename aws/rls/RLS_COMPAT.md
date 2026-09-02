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

Applied as `checksops_admin` via temporary Lambda `checksops-staging-rls-remediate-c48b`, then that Lambda and IAM role were deleted. The API role still has only the `checksops` secret (`ApiFunctionRolePolicy4`).

| Change | Detail |
| --- | --- |
| Role shim | `authenticated` NOLOGIN; `GRANT authenticated TO checksops`. No `anon` grant. No `service_role` login. |
| Final SELECT set | **165** `aws_select_*` policies prepared; **not** enabled on restored tables |
| Global admin/staff | 70 tables / 75 original objects rewritten to tenant membership + platform-owner helpers |
| JWT/open SELECT | 8 rewritten (`TO authenticated` catalogs; homeowner `auth.email()` from identity map) |
| Open writes | 10 excluded; stay in API |
| Obsolete | 6 `service_role`/`anon` excluded |
| Empty-policy tables | `payment_idempotency_keys` tenant-scoped; `plaid_webhook_cursors` platform-owner only |
| Owner helpers | `is_master_owner` / `is_platform_owner` read `identity_accounts.email` / `profiles.email` |
| Access helpers | `SECURITY DEFINER` + `row_security=off` so claim/check joins cannot recurse |
| Probe table | `public._aws_rls_probe_items` — **only** public table with RLS on |
| Restored tables | RLS remains **off** (transactional ENABLE on 16 representative tables was rolled back) |
| 47 FKs | Not applied (`aws/rls/FK_RETARGET_PLAN.md`) |
| JWKS | Cognito IdP interface VPCE `vpce-01e64f35c26956533`; Lambda fetches JWKS in-VPC |

SELECT model (policies exist; RLS off on restored tables):

- Session id = `auth.uid()` = `request.app_user_id` = `identity_accounts.application_user_id`
- Tenant scope = `tenant_users` via `aws_user_tenant_ids()`
- App roles = `user_roles` via `has_role(auth.uid(), …)` **inside** that tenant set
- Cross-tenant = `is_master_owner()` / `is_platform_owner()` only
- JWT-email homeowner policies: compare to `auth.email()` after GUC is set from `identity_accounts.email` / `profiles.email`, never the Cognito probe address
- Writes stay API-side
- SQL: `aws/rls/sql/12_final_select_policies.sql`

## API

`GET`/`POST` `/authorization/probe` and `/authorization/isolation` (HTTP API JWT authorizer `5kyjfy`). `GET /authorization/jwks-check` has no authorizer so the Lambda must fetch Cognito JWKS over PrivateLink.

Looks up `identity_accounts` by Cognito `sub` only, sets `request.app_user_id` to the mapped UUID, `SELECT`s the probe table. Query params, `X-User-Id` / `X-Tenant-Id` / `X-Cognito-Sub`, and JSON body ids are ignored.

## Isolation tests (isolated Cognito probe, not a real invite)

Cognito user `staging-identity-probe-c48b@checksops.invalid` / sub `2418c458-c011-70b7-07ac-6b9da2d9415d` mapped `isolated_test` → ChecksOps Tester `abd3c2a0-6dc0-4680-92dd-a013e1141c91` (staff, Freedom operator).

| Check | Result |
| --- | --- |
| Probe: tester Freedom only; C1C admin C1C only; master all three labels | pass |
| Probe: ninth UUID / Cognito sub as `app_user_id` / unset GUC → 0 rows | pass |
| `is_master_owner` true only for `7dbb3009-…79330`; `is_platform_owner` false for all restored actors | pass |
| 16 representative tables ENABLE RLS in a transaction then ROLLBACK | pass |
| Same-tenant staff: Freedom checks 182, endorsements 321, disbursements 109, ledger 657, deposits 114, check files 11 | pass |
| Same-tenant C1C admin: provider accounts 1, tenants 1, idempotency keys 1, user_roles 3, profiles 3; 0 Freedom on tenant-keyed tables | pass |
| Cross-tenant staff/admin denial on tenant-keyed financial tables | pass |
| Master owner sees all rows including null `tenant_id`/`org_id` claims (180) and webhook events (227) | pass |
| Ninth UUID (`admin`+`staff`, no membership) sees 0 tenant data (own `user_roles` only) | pass |
| UUID oracle: knowing a Freedom `check_intake_items` / `deposit_items` id does not grant C1C or unauth access | pass |
| `checksops` is not superuser, not `BYPASSRLS`, not table owner (`checksops_admin` owns tables) | pass |
| HTTP unauthenticated probe/isolation | API Gateway 401 |
| HTTP probe ID token: `authUid` = Tester UUID, roles `["staff"]`, Freedom probe only | pass |
| Spoof query / headers / body cannot switch UUID or read C1C probe row | pass |
| JWKS fetch from private Lambda via Cognito IdP VPCE; in-process verify of probe ID token | pass |
| `/db-health` still `checksops` / `checksops` | pass |
| Public tables with RLS after tests | `_aws_rls_probe_items` only |

C1C admin saw 43 Freedom `deposit_items` rows. UUID oracle on a different Freedom deposit was 0, so this is not global `admin` leakage. Those 43 match `current_tenant_is_check_funds_recipient` (C1C as funds recipient on specific Freedom checks).

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
2. Invite/link the 8 known emails; decide how to handle the 9th UUID (email still unknown). Do not invent one.
3. Set `request.app_user_id` on **every** authenticated route, not only `/identity/me`, `/authorization/probe`, and `/authorization/isolation`.
4. Human-review fail-closed `platform_owner_only` / fallback tables (deposit automation, branding, CheckAlt config, etc.).
5. Write cutover: no INSERT/UPDATE/DELETE RLS policies; API must authorize writes.
6. Attach 47 FKs only after identity_accounts is complete (including the 9th UUID).
7. Restored `claims.org_id` is null for 180 rows; platform owner can read them, tenant staff cannot. Backfill org_id before relying on tenant claim isolation.
8. Never connect the API as `checksops_admin` (table owner bypasses RLS). `checksops` is not superuser and not `BYPASSRLS`.

**Not safe to enable global staging RLS yet.** Policies are prepared and isolation tests pass, but identity mapping, GUC coverage, write cutover, FK retarget, and the ninth UUID remain.

## STOP

Do not enable RLS globally. Do not invite real users. Do not attach the 47 FKs. Do not change production Lovable/Supabase, `main`, Storage, Moov, CheckAlt, webhooks, DNS, or the production frontend.
