# AWS staging write authorization (proposed)

SELECT set stays at **165** `aws_select_*` policies. This phase adds write helpers and representative write policies. **Global RLS stays off** on restored tables. Claims `org_id` is **not** backfilled. The 47 planned FKs are **not** attached. Production users are **not** invited.

Identity path unchanged:

`Cognito sub → identity_accounts.application_user_id → request.app_user_id → auth.uid()`

## Rules

1. Writes require `auth.uid()` (mapped application UUID). Knowing a record UUID is not enough.
2. Tenant admin/staff write only tenants in `tenant_users`. Global `user_roles.admin|staff` without membership is denied (ninth UUID).
3. Cross-tenant writes: `is_master_owner()` / `is_platform_owner()` only.
4. No `service_role`, `anon`, `USING(true)`, `WITH CHECK(true)`, or browser-authorized open writes.
5. Payment/provider/webhook/idempotency/CheckAlt/Plaid ingest: **server-side AWS API** after verifying webhook signatures. No authenticated write policies.
6. API role is `checksops`, never `checksops_admin`. `checksops` is not superuser, not `BYPASSRLS`, not table owner. Table DML grants stay SELECT-only on restored tables (write tests GRANT inside a rolled-back transaction only).

## Helper

`aws_can_write_tenant(tid)` = authenticated AND `aws_can_access_tenant(tid)` AND (platform owner OR `has_role(admin|staff)`).

Membership is required first, so C1C admin cannot write Freedom rows, and the ninth UUID cannot write any tenant.

## Representative write policies (prepared, RLS off except probe)

FOR ALL TO authenticated, `USING`/`WITH CHECK` via `aws_can_write_tenant` / `aws_can_write_check` / `aws_can_write_claim`:

`check_intake_items`, `check_endorsements`, `deposit_items`, `disbursement_batches`, `claims`, `claim_files`, `claim_folders`, `payment_provider_accounts`, `homeowner_ledger_events`, `tenant_email_settings`, `user_roles`, `tenants` (UPDATE only).

Isolated `_aws_rls_write_probe` has RLS **on** (not restored data).

`payment_webhook_events` and `payment_idempotency_keys`: **no write policy** (default deny once RLS is on).

`claims` WITH CHECK requires non-null `org_id` for tenant writers. The 97 unassigned claims stay unwritable by tenant staff until a reviewed backfill.

## Complete write-path inventory

Dump POLICY TOC: **142** tables have INSERT/UPDATE/DELETE/ALL policies (ALL 89, INSERT 65, UPDATE 51, DELETE 21).

| Proposed class | Tables | Meaning |
| --- | ---: | --- |
| `representative_aws_write_rls` | **12** | Policies prepared this phase |
| `tenant_scoped_write_rls_needed` | **108** | Same helper pattern, not prepared yet |
| `server_side_api` | **13** | No authenticated write policy |
| `platform_owner_or_api` | **7** | Singleton/config; not tenant-keyed |
| `do_not_restore` | **2** | leftover obsolete-only write policies |

Application client DML (`.insert` / `.update` / `.delete` / `.upsert`): **68** frontend tables, **83** edge-function tables. RPCs: **61** frontend, **21** edge.

Dump open-write / obsolete (do not restore):

- **10** `server_side_api` open writes — leads, signature completion, recon alerts, guided claim insert, presets, privacy notice, referral insert, mortgage releases
- **6** obsolete `service_role` / `anon`

Server-side RPCs (do not GRANT to `checksops` for anonymous/browser use): `deposit_action`, CheckAlt/Moov closeout/sync, `ocr_commit_results`, email enqueue/DLQ, vault encrypt/decrypt, `admin_delete_check`, webhook-driven returns.

Browser-direct writes in `src/` that hit CheckAlt, Moov, webhooks, or USING(true) tables must move to the staging API before global RLS. Highest priority: `checkalt_config`, `company_branding`, deposit automation settings, payment provider/transfer tables, webhook event inserts.

SQL: `aws/rls/sql/20_write_helpers.sql`, `21_proposed_write_policies.sql`, `22_write_probe_table.sql`.
JSON: `aws/rls/classification/write_paths.json`.

## Transactional tests (rollback only)

Inside `BEGIN`: ENABLE RLS on representative tables, GRANT DML to `checksops`, run DML as `SET LOCAL ROLE checksops` + `request.app_user_id`, then `ROLLBACK`. No Moov/CheckAlt calls. No persisted financial rows.

Cases: same-tenant staff/admin allowed; cross-tenant denied; ninth UUID denied; unauthenticated denied; Cognito sub as app UUID denied; master owner allowed; UUID-guess deposit update denied; tenant rekey denied; webhook/idempotency INSERT denied; synthetic check INSERT rolled back.
