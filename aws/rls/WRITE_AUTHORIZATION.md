# AWS staging write authorization (proposed)

SELECT set stays at **165** `aws_select_*` policies. This phase adds write helpers and representative write policies. **Global RLS stays off** on restored tables.

Identity path unchanged:

`Cognito sub → identity_accounts.application_user_id → request.app_user_id → auth.uid()`

## Rules

1. Writes require `auth.uid()` (mapped application UUID). Knowing a record UUID is not enough.
2. Tenant admin/staff write only tenants in `tenant_users`. Global `user_roles.admin|staff` without membership is denied (ninth UUID).
3. Cross-tenant writes: `is_master_owner()` / `is_platform_owner()` only.
4. No `service_role`, `anon`, `USING(true)`, `WITH CHECK(true)`, or browser-authorized open writes.
5. Payment/provider/webhook/idempotency/CheckAlt/Plaid ingest: **server-side AWS API** after verifying webhook signatures. No authenticated write policies.
6. API role is `checksops`, never `checksops_admin`. `checksops` is not superuser, not `BYPASSRLS`, not table owner.

## Helper

`aws_can_write_tenant(tid)` = authenticated AND `aws_can_access_tenant(tid)` AND (platform owner OR `has_role(admin|staff)`).

Membership is required first, so C1C admin cannot write Freedom rows.

## Representative write policies (prepared, RLS off except probe)

`check_intake_items`, `check_endorsements`, `deposit_items`, `disbursement_batches`, `claims`, `claim_files`, `claim_folders`, `payment_provider_accounts`, `homeowner_ledger_events`, `tenant_email_settings`, `user_roles`, `tenants` (UPDATE), plus isolated `_aws_rls_write_probe`.

`payment_webhook_events` and `payment_idempotency_keys`: **no write policy** (default deny once RLS is on).

`claims` WITH CHECK requires non-null `org_id` for tenant writers. The 97 unassigned claims stay unwritable by tenant staff until a reviewed backfill.

## Application write-path inventory (runtime)

Distinct tables: 81 frontend, 96 edge functions. Distinct RPCs: 61 frontend, 21 edge.

Classification of original dump write policies:

- **46** ALL policies with global admin/staff — replace with tenant-scoped `aws_can_write_*` (same pattern as SELECT remediation)
- **10** server_side_api open writes — keep in API (leads, signature completion, recon alerts, guided claim insert, presets, privacy notice, referral insert)
- **6** obsolete service_role/anon — never restore

Browser-direct writes in `src/` that hit CheckAlt, Moov, webhooks, or USING(true) tables must move to the staging API before global RLS. Highest priority: `checkalt_config`, `company_branding`, deposit automation settings, payment provider/transfer tables, webhook event inserts.

SQL: `aws/rls/sql/20_write_helpers.sql`, `21_proposed_write_policies.sql`, `22_write_probe_table.sql`.
JSON: `aws/rls/classification/write_paths.json`.
