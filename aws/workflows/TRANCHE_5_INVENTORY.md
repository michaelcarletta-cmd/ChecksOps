# Tranche 5 inventory — remaining ChecksOps application workflows

Rescan of current `main` at `2f69698d5e0092b1fdb0289598331aaf592652fa` (validated T1–T4 union). This is ChecksOps, not Freedom CRM table migration.

Production ChecksOps remains on Lovable/Supabase. AWS staging already has T1–T4 writes, S3 storage, Cognito identity, fail-closed providers.

## What AWS staging can already do (T1–T4)

| Capability | Flag | Notes |
| --- | --- | --- |
| Reads + RLS | always | Cognito sub → `identity_accounts.application_user_id` → `auth.uid()` |
| Message read receipts, notification prefs | `AWS_WRITES_ENABLED` | T1 |
| Descriptive intake UPDATE, payees, endorsement contact, audit INSERT, message soft-delete | `AWS_CHECK_WORKFLOW_WRITES_ENABLED` | T2 |
| Notes INSERT, `check_files` + S3 upload/delete/move on check-scoped `claim-files`, existing-check image paths, descriptive `claim_checks` | `AWS_STORAGE_WRITES_ENABLED` / T2 flag | T3 |
| Provider status / dry-run webhooks | all provider flags **false** | T4; execution hard-blocked |

## Remaining dependencies required for normal ChecksOps operation

Prioritized for Tranche 5. Obsolete Freedom CRM tables are not in scope.

### 1. New check intake / creation — **T5**

Production path (`CheckCommandCenter` `CheckUploadForm.handleUpload`):

1. Upload front/back to `claim-files` at `checks/{user.id}/{claimDir}/…` (user-scoped, **not** check-scoped).
2. `INSERT check_intake_items` (`front_image_path`, `back_image_path`, optional `claim_id`, browser `uploaded_by` / `tenant_id`).
3. `functions.invoke("check-ocr-intake")` — already `provider_disabled` on AWS.

Defaults: `status='uploaded'`, `check_stage='review'`, `ocr_status='pending'`, `check_source='insurance'`, `mortgage_monitoring_type='not_set'`. `front_image_path` is NOT NULL.

**INSERT triggers**

| Trigger | Effect | T5 handling |
| --- | --- | --- |
| `assign_case_on_check_intake` | sets `case_id` | keep |
| `trg_auto_link_check_to_claim_ins` | may set `claim_id` from `detected_claim_number` | do not set `detected_claim_number` |
| `trg_enforce_check_status` | audit only (enforcement dropped) | keep |
| `trg_auto_seed_endorsements_ins` | seeds endorsements for `external_origin` | do not set `external_origin` |
| `trg_sync_homeowner_ledger_ins` / `hle_on_check_intake_insert` | ledger `check_received` **with amount** if `claim_id` AND insurance | **never set `claim_id` on create** |
| `trg_log_intake_usage` | usage metering | keep (not in financial aggregates) |
| `check_intake_contact_carryover` | copies contact from prior checks | keep |

Chicken-egg vs T3 storage: production uploads **before** insert using `userId`. T3 write prefixes are `checks/{checkId}/`. AWS create-first: insert with placeholder `checks/{id}/pending_front.jpg`, then upload, then T3 path UPDATE.

OCR / CheckAlt submission is **not** invoked. Intake stops at an internal record.

**Claim linkage is intentionally deferred.** Linking an existing claim fires ledger amount writes and would change `homeowner_ledger_amount`.

### 2. Check status / stage — **T5 explicit machine**

DB `enforce_check_status_transition` is now a no-op audit (`20260505163706`). Arbitrary status mutation must not be exposed.

Production review RPC `submit_check_review_decision` maps `p_deposit_path` → status/stage and can set **amount**. AWS intercepts that RPC and runs the T5 machine only (no amount, no deposit rows).

**T5-allowed actions** (from-states match the production RPC):

| Action | From | To status / stage | Provider? |
| --- | --- | --- | --- |
| `start_review` | `uploaded` | `needs_review` / `review` | no |
| `start_endorsing` | `uploaded`, `needs_review`, … | `endorsements_in_progress` / `endorsing` | no |
| `route_loss_draft` | `needs_review`, `endorsements_in_progress`, … | `loss_draft_required` / `loss_draft` | no (internal tracking row only) |
| `mark_ready_for_deposit` | `needs_review`, `loss_draft_required`, … | `approved_for_deposit` / `ready_for_deposit` | **STOP** |
| `return_to_review` | decision states | `needs_review` / `review` | no |

**Denied:** `deposited`, `branch_deposit_required` (deposit pipeline), `funds_released`, `disbursed_externally`, CheckAlt/Moov/ACH/RTP/wire, `reissue_requested`, `merge_only`, browser `status=` / `signed_at`.

**Partner HTTP:** `sync_partner_status_from_local` may set `partner_status` on any status/stage UPDATE. `notify_freedom_status_change` then HTTP POSTs to Freedom production **only when** `external_origin.source_app = 'freedom_crm'`. T5 refuses transitions on partner-linked or claim-linked rows.

### 3. Mortgage workflow — **T5 internal metadata**

Allow: `mortgage_monitoring_type`, `mortgage_sent_at`, `mortgage_tracking_number`, `mortgage_received_at` on intake; `mortgage_handling_requests` insert/update of company/loan/notes/`requested` status.

Deny: `mortgage_final_released_at` (`trg_return_to_review_on_release`), billing/stripe/invoice money-movement columns, `notify-mortgage-handling-request`. `bill-mortgage-handling` is fail-closed and non-collectible: Complete-time invocation must not write `platform_fee_line_items` or `check_billing_events`, and must not call Stripe or Moov. The AWS billing milestone is Accept (`check_billing_events` `mortgage_ops_initial` / `mortgage_ops_additional_check`). Collection is the monthly consolidated invoice → Collection V2.

### 4. Loss-draft workflow — **T5 internal metadata**

`trg_auto_create_loss_draft` inserts `loss_draft_tracking` + `init_loss_draft_documents` when status becomes `loss_draft_required` (DEFINER, no email).

Allow UPDATE of notes, loan, contact, servicer, monitoring, non-release `escrow_status`, tracking numbers.

Deny: `draw_amount_released` mutations, marking external send successful, `loss-draft-documents` bucket writes (not in T3 S3 prefixes).

### 5. Signature / endorsement — **boundary only**

T2 already: payee CRUD, endorsement contact metadata.

Still denied: `check_endorsements.status` / `signed_at`, packet generation, `send-signature-request`, `advance_check_on_endorsement_complete` (would set `ready_for_deposit` and can cascade partner HTTP). Signed state requires a verified external workflow that is still disabled.

### 6. Remaining tenant-scoped CRUD (not T5)

`claims` create/link, cash-job intake, shared/partner checks, `check_stakeholders`, branding, profiles, tenant admin, `mortgage_companies` directory mutations, `loss_draft_documents` file bytes, `signature_requests`, `check_intake_mortgage_draws` (amount/release).

### 7. Operational gap this tranche closes

An AWS-staging user can: create an internal check → upload images on check-scoped S3 → edit payees/descriptive fields/notes → set mortgage/loss-draft metadata → walk the internal machine to **READY FOR PROVIDER EXECUTION**.

They cannot: link a claim (ledger), complete endorsements as signed, submit CheckAlt, deposit, or move money.

## Intentionally left on Supabase / disabled

| Dependency | Why |
| --- | --- |
| `check-ocr-intake` | Provider/AI; already `provider_disabled` |
| Claim linkage on create | Ledger amount write |
| Partner-mirrored status changes | HTTP to Freedom production |
| Signature completion / emails | External provider |
| CheckAlt / Moov / Plaid / Actum / QB | T4 fail-closed |
| `loss-draft-documents` bucket | Not in validated S3 write prefixes |
| Cash-job / shared-check intake | Separate product paths |
| Freedom CRM tables | Not ChecksOps |
