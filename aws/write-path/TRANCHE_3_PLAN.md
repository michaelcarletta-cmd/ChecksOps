# AWS write path — Tranche 3 plan

## Goal

Close remaining **day-to-day operational gaps** on Cognito AWS staging so normal ChecksOps check/claim work can proceed **without money movement or provider execution**.

Production ChecksOps (Lovable/Supabase) is unchanged. No DNS cutover.

Base: current write-path code (Tranche 1 + Tranche 2). GitHub `main` at plan time still showed only Tranche 1 merged; this tranche is stacked on the Tranche 2 head so the PR targeting `main` includes T2+T3.

## Highest-value remaining blocked workflows (re-scan)

| User action | Blocker on AWS after T2 | Tranche 3 |
| --- | --- | --- |
| Post a check note / message | `check_messages` INSERT denied (ledger trigger) | **Yes — INSERT enabled**, trigger **not** bypassed |
| Soft-delete a note | T2 UPDATE `is_deleted` | already live |
| Upload supporting files on a check | `uploads_disabled` + no `check_files` DML | **Yes** — S3 + metadata |
| Delete/move those files | `uploads_disabled` | **Yes** — server-authorized |
| Reupload / add front or back image on an **existing** check | storage + `front_image_path` / `back_image_path` denied | **Yes** — path columns + prefix-scoped upload |
| New check intake (insert `check_intake_items`) | ledger `check_received` + OCR edge function | **No** |
| Mirror descriptive OCR fields onto `claim_checks` | T2 skipped whole table | **Yes** — descriptive columns only |
| Force-complete / mark endorsement signed | `advance_check_on_endorsement_complete` → `check_stage` + `status` + possible partner HTTP | **No — stays disabled** |
| Send endorsement email / packet / signature | provider + email | **No** |
| Deposits, CheckAlt, Moov, Plaid, Actum, QuickBooks, ACH/RTP/wire | provider | **No** |

## `check_messages` decision: **enable INSERT (product path A)**

`trg_mirror_check_message_to_homeowner_ledger` is `AFTER INSERT` and inserts `homeowner_ledger_events` (`event_type='ops_note'`) when the parent check has `claim_id` + `tenant_id`. It does **not** set `amount`.

| Option | Product | Ledger semantics | T3 |
| --- | --- | --- | --- |
| A. Enable INSERT, leave trigger in place | Messages UI + homeowner timeline work as in production | Extra `ops_note` rows; `sum(amount)` unchanged | **Chosen** |
| B. Keep INSERT disabled (T2) | Notes stay blocked | No new ledger rows | Rejected for T3 — notes are required for daily use |
| C. Parallel notes table | Thread/timeline would not match production unless dual-written | Avoids ledger rows by changing product | **Not implemented** |

Rules:

- Do **not** `DROP` / disable / bypass the trigger.
- Do **not** `GRANT` browser/API DML on `homeowner_ledger_events`.
- `sender_id` is the mapped ChecksOps UUID (`request.app_user_id`), never Cognito `sub` or a spoofed `user_id`.
- Test cleanup hard-deletes T3 test messages **and** the `ops_note` rows they created so restore financial aggregates stay identical.

`shared_check_messages` stays disabled (partner-tenant identity is a later tranche).

## Endorsement boundary (unchanged denial of signed/complete)

Allowed (T2, still): contact/name/notes UPDATE; DELETE pending rows.

Denied (cannot be separated from side effects):

- `status` / `signed_at` / `signature_method` — `trg_advance_on_endorsement_complete` sets `check_intake_items.check_stage='ready_for_deposit'` and `status='approved_for_deposit'`, and mirrors `claim_checks.check_stage`. That is deposit-adjacent and can notify partners.
- Packet generation, `request_sent_at`, reminders, tokens, signature image.
- `functions.invoke` endorsement/email/signature providers.
- Public endorsement **submit**.

Force-complete in `EndorsementChecklist` continues to 403 on AWS.

## Storage writes

Extend the existing private S3 map `files/{bucket}/{path}`. Browser never receives AWS credentials. Uploads use a **short-lived presigned PUT** issued only after authenticated API authorization.

Flag: `AWS_STORAGE_WRITES_ENABLED` (unset inherits `AWS_WRITES_ENABLED`; explicit `false` disables storage writes only). Reads/sign/list continue.

Allowlisted **write** prefixes on `claim-files` only, and only when `lookupCheck` (RLS) says the UUID is a writable check:

- `check-intake/{checkId}/files/` — `CheckFilesSection`
- `checks/reupload/{checkId}/` — `ReuploadCheckImageButton`
- `checks/{checkId}/` — existing-check back/front image on the detail panel

Denied buckets for write: `deposit-attachments`, `endorsement-packets`, `homeowner-uploads`, `tenant-logos`, `company-branding`, `loss-draft-documents`.

Overwrite: `upsert: false` (default) → `409 object_exists` when `HeadObject` succeeds. `upsert: true` still requires the same prefix + RLS check.

Deletes/moves: server-side only (`POST /storage/delete`, `POST /storage/move`). Knowing the key is not enough; C1C cannot delete/read a Freedom object.

`check_files` INSERT keeps `trg_mirror_check_file_to_homeowner_ledger` (zero-amount `document_uploaded`). DELETE of metadata does not fire that trigger. Test file rows and their ledger mirrors are cleaned up.

New check **intake** (`INSERT check_intake_items`) stays denied (`check_received` is amount-bearing).

## `claim_checks` descriptive mirrors

UPDATE only, parent must be an RLS-visible `check_intake_item_id` / `id`.

Allowed: `carrier_name`, `check_number`, `payee_line`, `notes`, `check_date`, `received_date`, `ocr_needs_verification`, `updated_at`.

Denied: `amount`, routing/account, `deposit_*`, `mortgage_*`, `check_stage`, `endorsement_status`, `payment_direction_status`, `checkalt_deposit_id`, `eligibility_status`, `cleared_status`, `claim_id`. (`trg_lock_stage_on_deposit` is `UPDATE OF deposit_status` — denied.)

INSERT/DELETE of `claim_checks` stay denied.

## Flags (all remain)

- `AWS_WRITES_ENABLED` — global write kill switch
- `AWS_CHECK_WORKFLOW_WRITES_ENABLED` — T2+T3 table DML (unset inherits global)
- `AWS_STORAGE_WRITES_ENABLED` — storage upload/delete/move (unset inherits global)
- Read pool keeps `-c default_transaction_read_only=on`
- Provider invokes stay `provider_disabled`
- Financial tables fail-closed (`reason: financial_or_provider`)

Identity: Cognito sub → `identity_accounts.application_user_id` → ChecksOps UUID → `request.app_user_id` → `auth.uid()`. Never trust `user_id` / `tenant_id` / `x-user-id` / `x-tenant-id`.

## Grants

`aws/write-path/sql/35_tranche3_write_grants.sql` (additive). Column-level UPDATE on `claim_checks` and extra intake image-path columns. INSERT on `check_messages` and `check_files`. No GRANT DML on `homeowner_ledger_events`.

## Tests

Freedom same-tenant success; C1C same-tenant where data exists (restore still has **0** C1C intake rows — C1C isolation is “cannot write Freedom”); cross-tenant 403; unauth 401; spoof ignored; invalid UUID 400; unapproved table/column 403; financial/provider 403; failed write rolls back; kill switches; storage upload/read/delete/move; C1C cannot access Freedom object; key-only access fails; 409 on overwrite; financial aggregates identical after cleanup.

Production is not touched.
