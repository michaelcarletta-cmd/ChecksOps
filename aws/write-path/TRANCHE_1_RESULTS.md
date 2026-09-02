# Tranche 1 results

Branch `cursor/aws-write-tranche-1-c48b`. PR targets `main`. Production ChecksOps, production DNS, production Supabase, Moov, CheckAlt, Plaid, Actum, and QuickBooks were not touched.

## Operations migrated

| Frontend | API | Table | Allowed columns | Server-forced identity |
| --- | --- | --- | --- | --- |
| `CheckMessageThread` upsert when a thread with messages loads | `POST /data/write` `op=upsert` (also insert/update/delete) | `check_message_reads` | `check_id`, `last_read_at` | `user_id` = mapped ChecksOps UUID |
| `NotificationPreferencesSettings` load/save (Settings → Profile) | `POST /data/write` `op=get_or_create` / `update` (also insert/delete) | `notification_preferences` | `in_app_enabled`, `email_enabled`, `sms_enabled` | `user_id` = mapped ChecksOps UUID |

`get_or_create_notification_preferences` is **not** the SECURITY DEFINER RPC. AWS mode intercepts it and calls `/data/write` so client `p_user_id` cannot select another user.

Generic `POST/PUT/PATCH/DELETE /data/*` remains `writes_disabled`.

## Authentication

- Cognito ID token required. Missing token → **401**.
- Mapping: Cognito sub → `identity_accounts.application_user_id` → `request.app_user_id` → `auth.uid()`.
- Cognito sub is never used as the application UUID.
- Spoofed `user_id` / `tenant_id` / `x-user-id` / `x-tenant-id` / query identity are ignored.
- Kill switch: Lambda env `AWS_WRITES_ENABLED`. Only the string `true` enables writes.
- Read pool still uses `-c default_transaction_read_only=on`. Write transactions use a separate config plus `SET TRANSACTION READ WRITE`.
- API role remains `checksops`. `checksops_admin` is not on API Policy4.

## Tenant isolation (live staging API)

Staging restore has **182 Freedom** `check_intake_items` and **0 C1C** intake rows. C1C equivalent CRUD therefore uses `notification_preferences`. Cross-tenant check writes use Freedom checks + RLS.

| Case | Result |
| --- | --- |
| Freedom upsert/update own `check_message_reads` | 200; stored `user_id` = Freedom app UUID `abd3c2a0-…` |
| C1C get_or_create own `notification_preferences` | 200; `user_id` = C1C app UUID `fd857564-…` |
| Freedom get_or_create/update own prefs | 200 |
| C1C upsert Freedom `check_id` | **403 `rls_denied`** |
| Freedom upsert non-owned check_id (C1C tenant UUID stand-in) | **403 `rls_denied`** |
| Unauthenticated | **401** |
| Spoofed C1C app/tenant UUIDs in headers/body | ignored; row owned by Freedom |
| Cognito sub as `user_id` | ignored; row owned by mapped UUID |
| Ninth UUID in body | ignored; cannot become row owner |
| Unmapped Cognito sub (unit) | **401 `identity_not_linked`** |
| Unapproved table `tenants` | **403 `table_not_allowlisted`** |
| Unapproved column `webhook_url` | **403 `column_not_allowlisted`** |
| Financial table `claim_payments` | **403 `reason=financial_or_provider`** |
| Invalid UUID | **400**; no row applied |
| Write error path | ROLLBACK, no COMMIT (unit) |

Test `check_message_reads` rows were deleted after validation. Notification preference rows for the two testers were created/left as their real settings (flags restored). No production records changed.

## Kill switch

`AWS_WRITES_ENABLED=false` → authenticated `POST /data/write` **403 `writes_disabled`**. `POST /data/query` still **200**. Then set back to `true`.

Temporary GRANT oneshot Lambda/role `checksops-staging-tranche1-grants-c48b` was invoked, then **deleted** (`ResourceNotFoundException` / `NoSuchEntity`).

## Financial reconciliation

Owner-level `aws/rls/sql/28_financial_aggregates.sql` before GRANT and after validation: **identical**.

| Metric | Before = after |
| --- | --- |
| check_intake_amount | 1317000.53 |
| check_intake_pa_fee_amount | 5393.27 |
| deposit_items_amount | 963972.98 |
| deposit_batches_total_amount | 964752.98 |
| checkalt_deposits_amount | 380333.17 |
| disbursement_splits_amount | 822212.97 |
| disbursement_batches_check_amount | 829768.914 |
| disbursement_batches_amount_reserved_cents | 0 |
| claim_check_payments_* | 0 |
| claim_payments_amount | 66003.92 |
| endorsed_check_intake_amount | 3924356.85 |
| payment_transfers_amount_cents | 0 |
| payment_wallet_ledger_amount_cents | 0 |
| homeowner_ledger_amount | 2977337.23 |

`homeowner_ledger_amount` unchanged confirms `check_messages` INSERT was not enabled.

## Frontend validation

AWS mode (`VITE_AUTH_PROVIDER=cognito`) only. Production client unchanged.

- Settings → Profile → Notification Preferences: Freedom tester saved flags (email off then restored). Success toast **Notification preferences saved**. AWS staging banner visible.
- Messages inbox in this UI session listed no conversations (panel query), so the mark-as-read effect was proven on the **same** `/data/write` contract via the authenticated API (Freedom upsert 200, C1C cross-tenant 403). Opening an empty Partners thread does not write (`messages.length === 0` guard).

## Still on Supabase / intentionally disabled

- All other frontend DML tables (298 sites / 73 tables on current `main`)
- `check_messages` INSERT/UPDATE (ledger trigger / workflow)
- Storage uploads
- Provider `functions.invoke` (Moov, CheckAlt, Plaid, Actum, QuickBooks, email/SMS)
- Write RPCs except the intercepted notification get-or-create
- Generic SQL / unrestricted `/data` mutations
- Production Lovable/Supabase path

## Unit tests

`node --test aws/tests/*.test.mjs` — **76 passed**.

## Rollback

`aws/write-path/TRANCHE_1_ROLLBACK.md`. Immediate: set `AWS_WRITES_ENABLED=false`.
