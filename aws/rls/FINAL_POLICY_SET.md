# Final AWS staging SELECT policy set

Prepared from the 380-policy inventory. **Not enabled** on restored tables in this phase.

## Count

| Item | Count |
| ---: | ---: |
| Final AWS policies | **165** |
| Command | SELECT only |
| Write RLS policies | 0 (API authorization) |
| Original inventory | 380 |
| Obsolete excluded | 6 |
| Open-write/server-side excluded | 10 |
| JWT/open-select rewritten | 8 |
| Global `has_role(admin\|staff)` tables remediated | 70 (75 original policy objects) |
| Dump RLS tables with no original policies | 2 |

One `aws_select_<table>` policy per public dump table that had RLS. Overlapping ALL/INSERT/UPDATE/DELETE originals are not restored.

## How the ~75 global admin/staff policies were remediated

Those objects used `has_role(auth.uid(), 'admin'|'staff')` without tenant membership. Tenant admins hold `user_roles.admin`, so that was cross-tenant.

Replacement USING clause:

`aws_is_cross_tenant_reader() OR aws_can_access_tenant(...)` (or claim/check join)

`aws_is_cross_tenant_reader()` is `is_master_owner() OR is_platform_owner()` only.

Those helpers now read `identity_accounts.email` / `profiles.email`, not empty `auth.users`:

- master owner: `mcarletta@freedomadj.com` (UUID `7dbb3009-f059-4767-b5dc-1c5c72379330`)
- platform owner: `checksopsadmin@gmail.com` (no restored user)

## JWT / open SELECT (8)

- `zip_geocache`, templates, announcements, billing config: `TO authenticated` catalog reads, not anon
- homeowner intro/uploads: `auth.email()` from mapped application identity, not Cognito probe email

## Open writes (10)

Not created as RLS. Signature completion, lead capture, webhook inserts stay in authenticated API code.

## Obsolete (6)

`service_role` and anon-only policies are not created.

## Two RLS tables with no dump policies

- `payment_idempotency_keys`: has `tenant_id` → tenant-scoped SELECT
- `plaid_webhook_cursors`: no tenant key → platform-owner only (equivalent to original deny-all for application users)

SQL: `aws/rls/sql/12_final_select_policies.sql`. Generator: `aws/rls/scripts/generate_final_policies.py`.
