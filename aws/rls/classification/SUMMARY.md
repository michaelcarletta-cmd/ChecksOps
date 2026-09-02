# Original Supabase RLS inventory (approved backup)

Source: `checksops_260901(1).backup` public POLICY TOC. Storage (38 policies) and `auth` RLS are out of scope.

Do **not** restore all 380 policies. Tenant admins hold `user_roles.role = admin`, so original `has_role(auth.uid(), 'admin')` / `'staff'` SELECT policies are cross-tenant.

## Totals

| Class | Count | Meaning |
| --- | ---: | --- |
| `directly_portable` | 356 | Predicate uses `auth.uid()` / existing helpers / `user_roles` / `tenant_users`. Works with AWS `request.app_user_id` after the `authenticated` role shim. Rewrite `TO public` → `TO authenticated`. |
| `requires_modification` | 8 | JWT email claims, or `USING(true)` / unscoped SELECT. |
| `server_side_api` | 10 | Open writes, public token/signature completion, lead capture. Keep in the API. |
| `obsolete` | 6 | `service_role` bypass or `anon`-only. No `service_role` / anonymous JWT in AWS staging. |
| **Total policies** | **380** | 163 public tables have policies. |

Dump also has **165** public tables with `ENABLE ROW LEVEL SECURITY`. Two have RLS and **no** policies (`payment_idempotency_keys`, `plaid_webhook_cursors`) — enabling those as-is would hide every row.

Commands: SELECT 154, ALL 89, INSERT 65, UPDATE 51, DELETE 21.

Role grants: `authenticated` 281, `public` 89, `authenticated, anon` 4, `service_role` 4, `anon` 2.

## Requires modification (8)

| Table | Policy | Why |
| --- | --- | --- |
| `check_billing_config` | Anyone authenticated can read billing config | `USING(true)` |
| `platform_announcements` | Anyone can read active announcements | `TO authenticated, anon` + `is_active` only |
| `signature_document_presets` | Authenticated users can read presets | `USING(true)` |
| `document_templates` | Authenticated users can view active templates | no `auth.uid()` |
| `email_templates` | Authenticated users can view active templates | no `auth.uid()` |
| `homeowner_intro_requests` | Homeowner reads own intro request by email | `auth.jwt()->>'email'` |
| `homeowner_check_uploads` | Homeowner reads own uploads by email | `auth.jwt()->>'email'` |
| `zip_geocache` | zip cache readable by all | `USING(true)` |

JWT-email policies must compare against `identity_accounts.email` / `profiles.email` via `auth.email()` after the API sets `request.jwt.claim.email` from the **mapped application row**, never the Cognito probe address.

## Server-side / API (10) — do not restore as open RLS

Open `USING(true)` writes, public signature completion, guided-claim insert, homeowner lead insert, webhook/reminder inserts.

## Obsolete (6)

`service_role` ALL on `signature_field_values`, `signature_fields`, `checkalt_deposits`, `checkalt_webhook_events`; anon directory SELECT; anon privacy-notice INSERT.

## Too broad to restore as-is (~75 SELECT/ALL)

Original `has_role(..., 'admin'|'staff')` without `user_belongs_to_tenant` / `is_tenant_staff`. Because every tenant admin is `user_roles.admin`, restoring these would let C1C admins read Freedom rows. AWS staging SELECT model uses `is_master_owner()` / `is_platform_owner()` for cross-tenant and `aws_user_tenant_ids()` for membership.

## RLS-enabled tables in dump

165 public, 16 auth, 9 storage/other. This phase enables RLS **only** on `public._aws_rls_probe_items`.
