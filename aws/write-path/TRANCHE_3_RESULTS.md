# AWS write path — Tranche 3 results

Branch `cursor/aws-write-tranche-3-c48b`. PR #96 targets `main`. **Do not merge until reviewed.**

Production ChecksOps, production DNS, production Supabase, Moov, CheckAlt, Plaid, Actum, and QuickBooks were **not** touched.

Live staging API: `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging`  
Lambda `checksops-staging-api` updated in place (`UpdateFunctionCode` / env). Do not SAM-deploy the thin `aws/template.yaml`.

Temporary GRANT oneshot `checksops-staging-tranche3-grants-c48b` was invoked, then **deleted** (function and IAM role gone).

Live Lambda env:

- `AWS_WRITES_ENABLED=true`
- `AWS_CHECK_WORKFLOW_WRITES_ENABLED=true`
- `AWS_STORAGE_WRITES_ENABLED=true`

An inline IAM policy `ApiFunctionRolePolicyS3Delete` was added on `checksops-staging-ApiFunctionRole-7E7XRyLe3nyi` so authorized deletes/moves can call `s3:DeleteObject`. The role already had `s3:GetObject` / `s3:PutObject` (presigned PUT + CopyObject).

## Workflows migrated

| User action | Frontend | API | Table / storage |
| --- | --- | --- | --- |
| Post an internal check note | `CheckMessageThread` send | `POST /data/write` insert | `check_messages` (`check_id`, `body`; `sender_id` server-set) |
| Soft-delete a note | same | update `is_deleted` | `check_messages` (T2, still) |
| Upload supporting file on an existing check | `CheckFilesSection` | `POST /storage/upload-url` + presigned PUT + insert | S3 `claim-files` + `check_files` |
| Delete / move that file | `CheckFilesSection` / adapter | `POST /storage/delete` / `/storage/move` | S3 + optional `check_files` DELETE |
| Reupload / add front or back image on an **existing** check | `ReuploadCheckImageButton`, CCC back-upload | upload-url + intake UPDATE | `front_image_path` / `back_image_path` / `back_image_original_path` |
| Mirror descriptive OCR fields | `CheckAdminEditDialog` (AWS-safe subset) | update | `claim_checks` notes/carrier/check #/payee/dates/OCR flag |

Identity: Cognito sub → `identity_accounts.application_user_id` → ChecksOps UUID → `request.app_user_id` → `auth.uid()`. Spoofed `user_id` / `tenant_id` / `x-user-id` / `x-tenant-id` ignored.

## Check-note decision

**Enable `check_messages` INSERT. Do not bypass or disable `trg_mirror_check_message_to_homeowner_ledger`.**

A parallel notes table was **not** added (it would change the Messages UI and homeowner timeline).

Live proof on Freedom check `918895f8-…` (`claim_id` present): INSERT created message `77f8dccb-…` and the trigger wrote one `ops_note` ledger row. `homeowner_ledger_amount` stayed **2977337.23**. Admin cleanup deleted the test message and that `ops_note`.

On Freedom check `dc647a1f-…` (`claim_id` null): INSERT succeeded and the trigger no-op’d (no ledger row), which is existing function semantics.

Direct browser/API DML on `homeowner_ledger_events` remains **403 `table_not_allowlisted`**.

## Endorsement boundary

Unchanged denial of signed/complete:

- UPDATE `status` / `signed_at` → **403 `column_not_allowlisted`**
- No packet, email, reminder, token, or signature-image writes
- Public endorsement submit stays writes-disabled
- `advance_check_on_endorsement_complete` was not invoked from AWS writes

Contact/name/notes UPDATE and pending-row DELETE remain T2.

## Storage upload / delete / move

Allowlisted write prefixes on `claim-files` only, after RLS `lookupCheck`:

- `check-intake/{checkId}/files/`
- `checks/reupload/{checkId}/`
- `checks/{checkId}/`

Denied: `deposit-attachments`, `endorsement-packets`, branding, homeowner-uploads.

Presigned PUT does **not** embed `ServerSideEncryption` in the signed headers (bucket default AES256 still applies). Browser never receives AWS credentials.

Live storage results (Freedom check `dc647a1f-…`):

| Case | Result |
| --- | --- |
| Authorized upload-url | 200 |
| Presigned PUT | 200 |
| Overwrite without `upsert` | **409 `object_exists`** |
| Authorized sign/read | 200 |
| C1C sign Freedom object | **403** |
| C1C upload to Freedom prefix | **403 `rls_denied`** |
| Unauthenticated sign | **401** |
| Knowing the S3 key is insufficient | C1C 403 with the same path |
| Authorized move | 200 |
| Authorized delete | 200 |
| C1C delete Freedom object | **403** |
| `deposit-attachments` write | **403 `bucket_not_allowed`** |
| Storage kill switch `AWS_STORAGE_WRITES_ENABLED=false` | **403 `uploads_disabled`**; reads still 200 |
| Flag restored | `true` |

## Tenant isolation

Staging restore still has Freedom intake rows and **0 C1C** intake rows. C1C same-tenant check writes have no local parent; isolation is C1C ↛ Freedom.

| Case | Result |
| --- | --- |
| Freedom insert own note | 200; `sender_id` = Freedom app UUID `abd3c2a0-…` |
| C1C insert Freedom note | **403 `rls_denied`** |
| Freedom descriptive `claim_checks` update (row `77edf710-…`) | 200; notes restored |
| C1C update that Freedom `claim_checks` row | **403 `rls_denied`** |
| Unauthenticated write | **401** |
| Spoofed ninth UUID / C1C tenant on note insert | ignored |
| Invalid check UUID | **400** |
| Unapproved table `homeowner_ledger_events` | **403** |
| Intake `amount` / endorsement `status` / `claim_checks.amount` | **403** |

## Financial reconciliation

Owner-SQL aggregates (`aws/rls/sql/28_financial_aggregates.sql`) **identical** before grants, after live writes, and after cleanup:

| Metric | Value |
| --- | --- |
| `check_intake_amount` | 1317000.53 |
| `check_intake_pa_fee_amount` | 5393.27 |
| `deposit_items_amount` | 963972.98 |
| `deposit_batches_total_amount` | 964752.98 |
| `checkalt_deposits_amount` | 380333.17 |
| `claim_payments_amount` | 66003.92 |
| `homeowner_ledger_amount` | **2977337.23** |
| `disbursement_splits_amount` | 822212.97 |
| `disbursement_batches_check_amount` | 829768.914 |
| `endorsed_check_intake_amount` | 3924356.85 |
| payment transfer / wallet ledger cents | 0 |

Ninth UUID still cannot UPDATE Freedom intake (0 rows).

## Provider guards

All **403 `provider_disabled`**: `moov-transfer`, `checkalt-submit`, `plaid-link`, `actum-charge`, `quickbooks-payment`, `send-transactional-email`.

## Unit tests

`node --test aws/tests/*.test.mjs` — **92 passed**.

Live script `scripts/aws-write-tranche3-validate.mjs` — **27/27**.

## Remaining Supabase DML

Frontend inventory is still ~**298** DML sites / **73** unique tables. AWS allowlist is now **10** tables (T1 2 + T2 6 including `check_messages` + T3 `check_files` + `claim_checks`). About **63** unique DML tables remain unmigrated.

## What remains before provider / payment migration

- New check intake `INSERT` (`check_received` ledger)
- Check `status` / `check_stage` (ledger, billing, partner HTTP)
- Endorsement signed/complete, packets, email, signature provider
- Deposits / CheckAlt submit
- Moov transfers, Plaid, Actum, QuickBooks
- Disbursement execution, ACH/RTP/wire
- Provider-side account creation and payment webhooks
- Direct financial ledger mutations
- `shared_check_messages`, mortgage-ops writes, loss-draft writes, signature request writes
- Production DNS / frontend cutover

## Production

**Not touched.** No DNS change. No production Supabase DML. No provider HTTP.
