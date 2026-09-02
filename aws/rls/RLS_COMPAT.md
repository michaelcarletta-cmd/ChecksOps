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

163 tables have policies. 165 public tables had RLS enabled in the dump. Details: `aws/rls/classification/SUMMARY.md`.

## What this phase applies (staging `checksops` only)

Applied as `checksops_admin` via a temporary in-VPC Lambda, then that Lambda and IAM role are deleted. The API role never receives the admin secret.

| Change | Detail |
| --- | --- |
| Role shim | `CREATE ROLE authenticated NOLOGIN` (if missing); `GRANT authenticated TO checksops`. No `anon` grant. No `service_role` login. |
| Helpers | `aws_user_tenant_ids()`, `aws_is_cross_tenant_reader()` (`is_master_owner` OR `is_platform_owner`, not `user_roles.admin`) |
| EXECUTE | Existing read helpers used by policies (`has_role`, `user_belongs_to_tenant`, …) plus the two new functions |
| Probe table | `public._aws_rls_probe_items` with RLS **on**; SELECT policy `tenant_id IN (SELECT aws_user_tenant_ids())`; SELECT grant only |
| Restored tables | RLS remains **off** |
| 47 FKs | Not applied (`aws/rls/FK_RETARGET_PLAN.md`) |

## Proposed SELECT model (not enabled on real tables)

- Session id = `auth.uid()` = `request.app_user_id` = `identity_accounts.application_user_id`
- Tenant scope = `tenant_users` via `aws_user_tenant_ids()`
- App roles = `user_roles` via `has_role(auth.uid(), …)` **inside** that tenant set
- Cross-tenant = `is_master_owner()` / `is_platform_owner()` only
- Original `has_role(admin|staff)` global SELECT (~75 policies) must not be restored: tenant admins are `user_roles.admin`
- Writes stay API-side until a later phase
- SQL sketch: `aws/rls/sql/05_proposed_select_policies.sql`

## API

`GET`/`POST` `/authorization/probe` verifies the Cognito ID token, looks up `identity_accounts` by `sub` only, sets `request.app_user_id` to the mapped UUID, and `SELECT`s the probe table. Query params, `X-User-Id` / `X-Tenant-Id` headers, and JSON body ids are ignored.

## Isolation tests

Recorded after live staging runs in the PR / later sections of this file.

## STOP

Do not enable RLS globally. Do not invite real users. Do not attach the 47 FKs. Do not change production Lovable/Supabase, `main`, Storage, Moov, CheckAlt, webhooks, DNS, or the production frontend.
