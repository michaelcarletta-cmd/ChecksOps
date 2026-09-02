| Public table | Trigger | Events | Extra information_schema rows | Category |
| --- | --- | --- | ---: | --- |
| `check_intake_items` | `assign_case_on_check_intake` | INSERT, UPDATE | 1 | data-integrity |
| `homeowner_ledger_events` | `assign_case_on_ledger_events` | INSERT, UPDATE | 1 | data-integrity |
| `homeowner_ledger_tokens` | `assign_case_on_ledger_tokens` | INSERT, UPDATE | 1 | data-integrity |
| `homeowner_ledger_check_uploads` | `assign_case_on_ledger_uploads` | INSERT, UPDATE | 1 | data-integrity |
| `loss_draft_tracking` | `assign_case_on_loss_draft` | INSERT, UPDATE | 1 | data-integrity |
| `claim_check_mortgage_draws` | `assign_case_on_mortgage_draws` | INSERT, UPDATE | 1 | data-integrity |
| `mortgage_releases` | `assign_case_on_mortgage_releases` | INSERT, UPDATE | 1 | data-integrity |
| `signature_requests` | `assign_case_on_signature_requests` | INSERT, UPDATE | 1 | data-integrity |
| `check_intake_items` | `check_intake_contact_carryover` | INSERT, UPDATE | 1 | data-integrity |
| `user_roles` | `on_role_change` | INSERT, DELETE, UPDATE | 2 | RLS/security-related |
| `contractor_reviews` | `recompute_tier_on_reviews` | INSERT, DELETE, UPDATE | 2 | application/business logic |
| `disbursement_splits` | `set_split_recipient_tenant` | INSERT, UPDATE | 1 | application/business logic |
| `claim_checks` | `touch_claim_on_check` | INSERT, DELETE, UPDATE | 2 | application/business logic |
| `emails` | `touch_claim_on_email` | INSERT, DELETE, UPDATE | 2 | application/business logic |
| `claim_files` | `touch_claim_on_file` | INSERT, DELETE, UPDATE | 2 | application/business logic |
| `claim_payments` | `touch_claim_on_payment` | INSERT, DELETE, UPDATE | 2 | application/business logic |
| `claim_settlements` | `touch_claim_on_settlement` | INSERT, DELETE, UPDATE | 2 | application/business logic |
| `signature_requests` | `touch_claim_on_signature` | INSERT, DELETE, UPDATE | 2 | application/business logic |
| `sms_messages` | `touch_claim_on_sms` | INSERT, DELETE, UPDATE | 2 | application/business logic |
| `check_endorsements` | `trg_advance_on_endorsement_complete` | INSERT, UPDATE | 1 | application/business logic |
| `disbursement_batches` | `trg_advance_stage_on_batch_complete` | INSERT, UPDATE | 1 | application/business logic |
| `disbursement_splits` | `trg_advance_stage_on_disbursement` | INSERT, UPDATE | 1 | application/business logic |
| `tenants` | `trg_assign_tenant_partner_code` | INSERT, UPDATE | 1 | application/business logic |
| `check_intake_items` | `trg_auto_link_check_to_claim` | INSERT, UPDATE | 1 | application/business logic |
| `payment_wallet_ledger` | `trg_block_wallet_ledger_mutation` | DELETE, UPDATE | 1 | application/business logic |
| `stakeholder_accounts` | `trg_enforce_single_primary` | INSERT, UPDATE | 1 | data-integrity |
| `claim_checks` | `trg_log_check_usage` | INSERT, UPDATE | 1 | application/business logic |
| `loss_draft_tracking` | `trg_loss_draft_auto_link_company` | INSERT, UPDATE | 1 | application/business logic |
| `loss_draft_documents` | `trg_mirror_loss_draft_upload` | INSERT, UPDATE | 1 | application/business logic |
| `signature_requests` | `trg_mirror_signature_request_to_homeowner_ledger` | INSERT, UPDATE | 1 | application/business logic |
| `signature_signers` | `trg_mirror_signature_signer_to_homeowner_ledger` | INSERT, UPDATE | 1 | application/business logic |
| `user_roles` | `trg_prevent_mortgage_agent_role_conflict` | INSERT, UPDATE | 1 | RLS/security-related |
| `cash_job_payments` | `trg_sync_cash_job_total_paid` | INSERT, DELETE, UPDATE | 2 | application/business logic |
| `claims` | `trg_sync_claim_ops_on_status_change` | INSERT, UPDATE | 1 | application/business logic |
| `payment_provider_accounts` | `trg_sync_provider_stakeholder_acct` | INSERT, UPDATE | 1 | application/business logic |
| `payment_provider_methods` | `trg_sync_provider_stakeholder_bank` | INSERT, UPDATE | 1 | application/business logic |
| `tenant_users` | `trg_sync_tenant_user_role` | INSERT, UPDATE | 1 | application/business logic |
