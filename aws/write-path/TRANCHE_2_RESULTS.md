# Tranche 2 results

Branch `cursor/aws-write-tranche-2-c48b`. PR #95 targets `main`. Production ChecksOps, production DNS, production Supabase, Moov, CheckAlt, Plaid, Actum, and QuickBooks were not touched.

Live staging API: `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging`  
Lambda `checksops-staging-api` updated in place (`UpdateFunctionCode` / env). Do not SAM-deploy the thin `aws/template.yaml`.

Temporary GRANT oneshot `checksops-staging-tranche2-grants-c48b` was invoked, then **deleted** (function and IAM role gone).

## Exact frontend operations migrated (AWS mode only)

| User action | Frontend | API `POST /data/write` | Table | Allowed columns |
| --- | --- | --- | --- | --- |
| Open a check | Check Command Center queue/detail | reads already on `/data/query` | `check_intake_items` SELECT | n/a |
| Edit safe check information | `EditableField` / `FundsTypeField` / `persistMeta` / admin dialog safe fields | `op=update` | `check_intake_items` | `carrier_name`, `check_number`, `issue_date`, `payee_line`, `property_address`, `funds_type`, `review_notes`, `payee_address`, `expiration_days`, `is_multi_payee`, `updated_at` |
| Manage payee records | PayeeManager / PayeeReconciliation / EndorsementChecklist add/edit/remove | `insert` / `update` / `delete` | `check_payees` | `check_id`, `payee_name`, `payee_type`, `contact_email`, `contact_phone`, `updated_at` |
| Payee-remove cleanup | same | `delete` | `check_endorsements`, `check_endorsement_events` | filters `id` / `payee_id` / `check_id` |
| Endorsement contact metadata | EndorsementChecklist | `update` | `check_endorsements` | `payee_name`, `payee_type`, `contact_email`, `contact_phone`, `notes`, `updated_at` |
| Operational audit notes | review save / admin / payee corrections | `insert` | `check_audit_log` | `check_id`, `event_type`, `event_description`, `event_data` (`actor_id`/`tenant_id` server-set) |
| Soft-delete a check message | `CheckMessageThread` | `update` | `check_messages` | `is_deleted`, `updated_at` |
| Tranche 1 (unchanged) | message read receipts / notification prefs | upsert / get_or_create | `check_message_reads`, `notification_preferences` | as T1 |

Identity: Cognito sub → `identity_accounts.application_user_id` → ChecksOps UUID → `request.app_user_id` → `auth.uid()`. Spoofed `user_id` / `tenant_id` / `x-user-id` / `x-tenant-id` ignored. Parent `tenant_id` for payees/audit copied from the RLS-visible check.

Kill switches: `AWS_WRITES_ENABLED=true` and `AWS_CHECK_WORKFLOW_WRITES_ENABLED=true` on the live Lambda. T2 flag `false` disables only check-workflow tables.

## Intentionally prohibited columns / ops

**`check_intake_items`:** `amount`, `pa_fee_*`, `routing_number`, `account_number`, `status`, `check_stage`, `claim_id`, `detected_claim_number`, deposit fields, mortgage timestamps, image paths, `endorsement_override` / packet path, partner_status, cash-job fields. INSERT and DELETE denied.

**`check_endorsements`:** `status`, `signed_at`, `signature_method`, tokens, `request_sent_at`, signature images. INSERT not an allowlisted op (pending rows are created by the existing payee-mirror trigger).

**`check_payees`:** `endorsement_status` / `endorsed_at` / notification-sent columns ignored, never applied. Live insert with client `endorsement_status=signed` stored **`pending`**.

**`check_messages`:** INSERT denied.

## Operations left on Supabase / disabled in AWS

- Check status / stage / deposit CTAs (`deposit_action`, CheckAlt, move to deposited)
- Amount / routing / account edits
- Force-complete endorsements
- `check-endorsement` send-request (email)
- Storage uploads (back image, endorsement render) — Storage Write tranche
- `claim_checks` mirrors
- Mortgage monitoring timestamps
- `check_messages` INSERT and `shared_check_messages`
- Homeowner ledger cards, disbursements, payments, providers
- Production Lovable path (unchanged)

## `check_messages` / ledger investigation

`trg_mirror_check_message_to_homeowner_ledger` is AFTER INSERT and writes `homeowner_ledger_events` (`ops_note`) when the check has `claim_id` + `tenant_id`. **Option B:** INSERT stays disabled. Soft-delete is enabled (INSERT trigger does not fire). Trigger was not dropped or bypassed. `homeowner_ledger_amount` stayed **2977337.23**.

## Payee / provider separation

Payee name/type/contact CRUD is on AWS. Send-endorsement invoke, Moov/KYC, and signed-status completion are not. Payee INSERT still runs `tg_mirror_payee_to_endorsement`, which creates a **pending** endorsement row (metadata only). That required GRANT INSERT on `check_endorsements` for the trigger; the HTTP allowlist has no endorsement insert op and still 403s `status`.

## Endorsement boundary

Contact/name/notes update and DELETE only. Force-complete (`status=signed`) is 403, so `advance_check_on_endorsement_complete` / partner `net.http_post` are not invoked from AWS writes. No packets, emails, or signature-provider calls.

## Authentication / isolation (live API)

Staging restore: **182 Freedom** intake rows, **0 C1C** intake rows. C1C isolation for checks is C1C → Freedom **403 `rls_denied`**.

| Case | Result |
| --- | --- |
| Freedom UPDATE own `carrier_name` + readback | 200; amount unchanged |
| Freedom restore original carrier | 200 |
| C1C UPDATE Freedom check | **403 `rls_denied`** |
| Freedom INSERT own payee + update contact + delete | 200; tenant_id = Freedom; client signed status not applied |
| C1C INSERT payee on Freedom check | **403 `rls_denied`** |
| Freedom INSERT `check_audit_log` | 200; `actor_id` = Freedom app UUID |
| Unauthenticated write | **401** |
| Spoofed C1C tenant/user on intake update | ignored; Freedom tenant kept |
| Cognito sub as `actor_id` | ignored; mapped UUID stored |
| Ninth UUID in payee body | ignored; Freedom tenant on row |
| Ninth UUID as `request.app_user_id` (admin oneshot) | UPDATE Freedom intake returned **0 rows** |
| Unapproved table `tenants` | **403 `table_not_allowlisted`** |
| Unapproved column `amount` / `status` | **403 `column_not_allowlisted`** |
| Financial table `claim_payments` | **403 `financial_or_provider`** |
| `check_messages` INSERT | **403 `operation_not_allowlisted`** |
| Endorsement `status=signed` | **403 `column_not_allowlisted`** |
| Malformed check id | **400 `invalid_uuid`** |
| Reads after writes | 200 |

`scripts/aws-write-tranche2-validate.mjs`: **30/30 PASS**.

## Kill switch

| Flag | Intake write | T1 `check_message_reads` | Reads |
| --- | --- | --- | --- |
| `AWS_CHECK_WORKFLOW_WRITES_ENABLED=false` | 403 `check_workflow_writes_disabled` | 200 | 200 |
| `AWS_WRITES_ENABLED=false` | 403 `writes_disabled` | 403 `writes_disabled` | 200 |
| both restored `true` | 200 | n/a | 200 |

## Financial reconciliation

Owner-level `aws/rls/sql/28_financial_aggregates.sql` **before GRANT = after validation**. Identical to Tranche 1 baseline.

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

Test payees deleted. Four `aws_tranche2_test` audit rows deleted via oneshot cleanup.

## Provider guards

Authenticated `POST /functions/v1/{moov-transfer,checkalt-submit,plaid-link,actum-charge,quickbooks-payment,send-transactional-email}` → **403 `provider_disabled`**.

## Frontend staging validation

`npm run build:aws` + `npm run preview:aws` on 4173 with `VITE_AUTH_PROVIDER=cognito`. Production client unchanged.

Freedom tester opened check **#237413** (State Farm). Carrier saved (`Carrier updated`) then reverted (`Carrier updated`). AWS staging banner visible. No deposit/provider clicks.

## Unit tests

`node --test aws/tests/*.test.mjs` — **82 passed** (76 Tranche 1 + 6 Tranche 2).

## Remaining Supabase DML count after Tranche 2

Source still has **~298** DML sites across **73** tables (production path). AWS mode allowlists **8** tables. **65** unique DML tables remain unmigrated / fail-closed on AWS. Many sites on the 8 allowlisted tables are still denied (status, amount, message INSERT, endorsement signed, intake INSERT/DELETE).

## Production

Untouched. No DNS change. No production Supabase disable.

## Recommended Tranche 3 (do not start here)

Candidate scope, still non-money-moving if possible:

1. A ledger-safe check-notes path **or** a product decision on `check_messages` INSERT
2. Local endorsement `status` without partner HTTP / `check_stage` advance — only if those side effects can be separated
3. Storage **uploads** for check-back / endorsement render (Storage Write tranche)
4. `claim_checks` descriptive mirrors without amount/mortgage

Do **not** put deposits, Moov, CheckAlt, ACH/RTP/wire, disbursements, or production cutover in Tranche 3.
