### Supabase/Auth-specific (0 public)
None in restored public schema.

### realtime-specific (0 public)
None in restored public schema.

### cron/net/vault/pgmq-specific (0 public)
None in restored public schema.

### RLS/security-related (2 public)
| Table | Trigger | Function | Events |
| --- | --- | --- | --- |
| `user_roles` | `on_role_change` | `public.increment_role_version` | INSERT, DELETE, UPDATE |
| `user_roles` | `trg_prevent_mortgage_agent_role_conflict` | `public.prevent_mortgage_agent_role_conflict` | INSERT, UPDATE |

### application/business logic (64 public)
| Table | Trigger | Function | Events |
| --- | --- | --- | --- |
| `cash_job_payments` | `trg_sync_cash_job_total_paid` | `public.sync_cash_job_total_paid` | INSERT, DELETE, UPDATE |
| `cash_jobs` | `trg_sync_cash_job_status` | `public.sync_cash_job_status` | UPDATE |
| `check_endorsements` | `trg_advance_on_endorsement_complete` | `public.advance_check_on_endorsement_complete` | INSERT, UPDATE |
| `check_endorsements` | `trg_hle_endorsement_insert` | `public.hle_on_endorsement_change` | INSERT |
| `check_endorsements` | `trg_hle_endorsement_update` | `public.hle_on_endorsement_change` | UPDATE |
| `check_files` | `trg_mirror_check_file_to_homeowner_ledger` | `public.mirror_check_file_to_homeowner_ledger` | INSERT |
| `check_intake_items` | `tr_record_mortgage_handling_billing` | `public.tg_record_mortgage_handling_billing` | UPDATE |
| `check_intake_items` | `trg_auto_create_loss_draft` | `public.trg_auto_create_loss_draft` | UPDATE |
| `check_intake_items` | `trg_auto_link_check_to_claim` | `public.auto_link_check_to_claim` | INSERT, UPDATE |
| `check_intake_items` | `trg_auto_link_check_to_claim_ins` | `public.tg_auto_link_check_to_claim` | INSERT |
| `check_intake_items` | `trg_auto_link_check_to_claim_upd` | `public.tg_auto_link_check_to_claim` | UPDATE |
| `check_intake_items` | `trg_auto_seed_endorsements_ins` | `public.tg_auto_seed_endorsements` | INSERT |
| `check_intake_items` | `trg_auto_seed_endorsements_upd` | `public.tg_auto_seed_endorsements` | UPDATE |
| `check_intake_items` | `trg_hle_check_intake_deposited` | `public.hle_on_check_intake_deposited` | UPDATE |
| `check_intake_items` | `trg_hle_check_intake_insert` | `public.hle_on_check_intake_insert` | INSERT |
| `check_intake_items` | `trg_log_intake_usage` | `public.log_usage_event` | INSERT |
| `check_intake_items` | `trg_notify_freedom_status_change` | `public.notify_freedom_status_change` | UPDATE |
| `check_intake_items` | `trg_record_check_billing_event` | `public.record_check_billing_event` | UPDATE |
| `check_intake_items` | `trg_return_to_review_on_release` | `public.return_check_to_review_on_mortgage_release` | UPDATE |
| `check_intake_items` | `trg_set_deposited_metadata` | `public.tg_set_deposited_metadata` | UPDATE |
| `check_intake_items` | `trg_sync_accounting_deposit_status` | `public.sync_accounting_deposit_status` | UPDATE |
| `check_intake_items` | `trg_sync_cash_job_check_payment` | `public.sync_cash_job_check_payment` | UPDATE |
| `check_intake_items` | `trg_sync_homeowner_ledger_ins` | `public.sync_homeowner_ledger_from_check` | INSERT |
| `check_intake_items` | `trg_sync_homeowner_ledger_upd` | `public.sync_homeowner_ledger_from_check` | UPDATE |
| `check_intake_items` | `trg_sync_partner_status_from_local` | `public.sync_partner_status_from_local` | UPDATE |
| `check_messages` | `trg_mirror_check_message_to_homeowner_ledger` | `public.mirror_check_message_to_homeowner_ledger` | INSERT |
| `check_payees` | `trg_hydrate_payee_contact_from_claim` | `public.tg_hydrate_payee_contact_from_claim` | INSERT |
| `check_payees` | `trg_mirror_payee_to_endorsement_del` | `public.tg_mirror_payee_to_endorsement` | DELETE |
| `check_payees` | `trg_mirror_payee_to_endorsement_ins` | `public.tg_mirror_payee_to_endorsement` | INSERT |
| `check_payees` | `trg_mirror_payee_to_endorsement_upd` | `public.tg_mirror_payee_to_endorsement` | UPDATE |
| `checkalt_deposits` | `checkalt_deposits_fund_on_clear` | `public.enqueue_wallet_funding_on_clear` | UPDATE |
| `claim_check_payments` | `trg_auto_add_partner_stakeholder` | `public.auto_add_partner_stakeholder` | INSERT |
| `claim_checks` | `touch_claim_on_check` | `public.touch_claim_updated_at` | INSERT, DELETE, UPDATE |
| `claim_checks` | `trg_lock_stage_on_deposit` | `public.lock_stage_on_deposit` | UPDATE |
| `claim_checks` | `trg_log_check_usage` | `public.log_usage_event` | INSERT, UPDATE |
| `claim_disbursements` | `trg_hle_disbursement_ins` | `public.hle_on_disbursement_sent` | INSERT |
| `claim_disbursements` | `trg_hle_disbursement_upd` | `public.hle_on_disbursement_sent` | UPDATE |
| `claim_files` | `touch_claim_on_file` | `public.touch_claim_updated_at` | INSERT, DELETE, UPDATE |
| `claim_payments` | `touch_claim_on_payment` | `public.touch_claim_updated_at` | INSERT, DELETE, UPDATE |
| `claim_settlements` | `touch_claim_on_settlement` | `public.touch_claim_updated_at` | INSERT, DELETE, UPDATE |
| `claims` | `trg_claims_status_change_activity` | `public.bump_claim_activity_on_status_change` | UPDATE |
| `claims` | `trg_sync_claim_ops_on_status_change` | `public.sync_claim_operational_state` | INSERT, UPDATE |
| `contractor_profiles` | `recompute_tier_on_profile` | `public._trg_recompute_contractor_tier_from_profile` | UPDATE |
| `contractor_reviews` | `recompute_tier_on_reviews` | `public._trg_recompute_contractor_tier_from_reviews` | INSERT, DELETE, UPDATE |
| `disbursement_batches` | `trg_advance_stage_on_batch_complete` | `public.advance_check_stage_on_batch_complete` | INSERT, UPDATE |
| `disbursement_splits` | `set_split_recipient_tenant` | `public.trg_set_split_recipient_tenant` | INSERT, UPDATE |
| `disbursement_splits` | `trg_advance_stage_on_disbursement` | `public.advance_check_stage_on_disbursement` | INSERT, UPDATE |
| `emails` | `touch_claim_on_email` | `public.touch_claim_updated_at` | INSERT, DELETE, UPDATE |
| `loss_draft_documents` | `trg_mirror_loss_draft_upload` | `public.mirror_loss_draft_upload_to_ledger` | INSERT, UPDATE |
| `loss_draft_mortgage_intake` | `trg_loss_draft_mortgage_intake_updated` | `public.update_updated_at_column` | UPDATE |
| `loss_draft_tracking` | `trg_loss_draft_auto_link_company` | `public.auto_link_loss_draft_mortgage_company` | INSERT, UPDATE |
| `mortgage_handling_requests` | `trg_mirror_mortgage_dates` | `public.mirror_mortgage_dates_to_ledger` | UPDATE |
| `mortgage_handling_requests` | `trg_share_library_docs_to_mortgage_request` | `public.share_library_docs_to_mortgage_request` | INSERT |
| `payment_provider_accounts` | `trg_sync_provider_stakeholder_acct` | `public.trg_sync_provider_stakeholder_account` | INSERT, UPDATE |
| `payment_provider_methods` | `trg_sync_provider_stakeholder_bank` | `public.trg_sync_provider_stakeholder_account` | INSERT, UPDATE |
| `payment_wallet_ledger` | `trg_apply_wallet_ledger_entry` | `public.apply_wallet_ledger_entry` | INSERT |
| `payment_wallet_ledger` | `trg_block_wallet_ledger_mutation` | `public.block_wallet_ledger_mutation` | DELETE, UPDATE |
| `shared_checks` | `trg_autoadd_partner_stakeholder` | `public.autoadd_partner_stakeholder_on_share` | INSERT |
| `signature_requests` | `touch_claim_on_signature` | `public.touch_claim_updated_at` | INSERT, DELETE, UPDATE |
| `signature_requests` | `trg_mirror_signature_request_to_homeowner_ledger` | `public.mirror_signature_request_to_homeowner_ledger` | INSERT, UPDATE |
| `signature_signers` | `trg_mirror_signature_signer_to_homeowner_ledger` | `public.mirror_signature_signer_to_homeowner_ledger` | INSERT, UPDATE |
| `sms_messages` | `touch_claim_on_sms` | `public.touch_claim_updated_at` | INSERT, DELETE, UPDATE |
| `tenant_users` | `trg_sync_tenant_user_role` | `public.sync_tenant_user_role` | INSERT, UPDATE |
| `tenants` | `trg_assign_tenant_partner_code` | `public.assign_tenant_partner_code` | INSERT, UPDATE |

### data-integrity (98 public)
| Table | Trigger | Function | Events |
| --- | --- | --- | --- |
| `cash_job_payments` | `trg_cash_job_payments_updated_at` | `public.set_updated_at` | UPDATE |
| `cash_jobs` | `trg_cash_jobs_updated_at` | `public.set_updated_at` | UPDATE |
| `check_billing_config` | `trg_check_billing_config_updated_at` | `public.update_updated_at_column` | UPDATE |
| `check_billing_events` | `trg_check_billing_events_updated_at` | `public.update_updated_at_column` | UPDATE |
| `check_cases` | `set_check_cases_updated_at` | `public.set_updated_at` | UPDATE |
| `check_intake_items` | `assign_case_on_check_intake` | `public.tg_check_intake_assign_case` | INSERT, UPDATE |
| `check_intake_items` | `check_intake_contact_carryover` | `public.trg_check_contact_carryover` | INSERT, UPDATE |
| `check_messages` | `set_check_messages_updated_at` | `public.update_updated_at_column` | UPDATE |
| `check_payees` | `check_payee_contact_carryover` | `public.trg_payee_contact_carryover` | INSERT |
| `check_payment_directions` | `trg_check_payment_directions_updated_at` | `public.set_updated_at` | UPDATE |
| `check_stakeholders` | `trg_check_stakeholders_updated_at` | `public.update_updated_at_column` | UPDATE |
| `checkalt_config` | `update_checkalt_config_updated_at` | `public.update_updated_at_column` | UPDATE |
| `checkalt_deposits` | `update_checkalt_deposits_updated_at` | `public.update_updated_at_column` | UPDATE |
| `claim_check_mortgage_draws` | `assign_case_on_mortgage_draws` | `public.tg_claim_id_assign_case` | INSERT, UPDATE |
| `claim_check_mortgage_draws` | `update_claim_check_mortgage_draws_updated_at` | `public.update_updated_at_column` | UPDATE |
| `claim_check_payments` | `trg_claim_check_payments_updated_at` | `public.set_updated_at` | UPDATE |
| `claim_checks` | `update_claim_checks_updated_at` | `public.update_updated_at_column` | UPDATE |
| `claim_disbursements` | `trg_claim_disbursements_updated_at` | `public.set_updated_at` | UPDATE |
| `claim_operational_state` | `update_claim_ops_updated_at` | `public.update_updated_at_column` | UPDATE |
| `claim_payments` | `update_claim_payments_updated_at` | `public.update_updated_at_column` | UPDATE |
| `claim_project_plans` | `set_claim_project_plans_updated_at` | `public.update_updated_at_column` | UPDATE |
| `claim_settlements` | `update_claim_settlements_updated_at` | `public.update_updated_at_column` | UPDATE |
| `claims` | `trg_set_claim_retention` | `public.set_claim_retention_purge_after` | UPDATE |
| `claims` | `trigger_create_predefined_folders` | `public.create_predefined_folders` | INSERT |
| `claims` | `update_claims_updated_at` | `public.update_updated_at_column` | UPDATE |
| `contractor_profiles` | `contractor_profiles_updated_at` | `public.set_updated_at` | UPDATE |
| `contractor_reviews` | `contractor_reviews_updated_at` | `public.set_updated_at` | UPDATE |
| `disbursement_batches` | `trg_disbursement_batches_updated_at` | `public.set_updated_at` | UPDATE |
| `disbursement_splits` | `trg_disbursement_splits_updated_at` | `public.set_updated_at` | UPDATE |
| `document_templates` | `update_document_templates_updated_at` | `public.update_updated_at_column` | UPDATE |
| `email_templates` | `update_email_templates_updated_at` | `public.update_updated_at_column` | UPDATE |
| `external_payment_recipients` | `set_external_payment_recipients_updated_at` | `public.update_updated_at_column` | UPDATE |
| `homeowner_bank_link_tokens` | `trg_homeowner_bank_link_tokens_updated_at` | `public.set_updated_at` | UPDATE |
| `homeowner_check_uploads` | `trg_hcu_updated_at` | `public.update_updated_at_column` | UPDATE |
| `homeowner_deductible_payments` | `set_homeowner_deductible_payments_updated_at` | `public.update_updated_at_column` | UPDATE |
| `homeowner_intro_requests` | `trg_hir_set_accepted_at` | `public.homeowner_lead_set_accepted_at` | UPDATE |
| `homeowner_intro_requests` | `trg_hir_updated_at` | `public.update_updated_at_column` | UPDATE |
| `homeowner_ledger_check_uploads` | `assign_case_on_ledger_uploads` | `public.tg_claim_id_assign_case` | INSERT, UPDATE |
| `homeowner_ledger_check_uploads` | `trg_hlcu_updated_at` | `public.set_updated_at` | UPDATE |
| `homeowner_ledger_events` | `assign_case_on_ledger_events` | `public.tg_claim_id_assign_case` | INSERT, UPDATE |
| `homeowner_ledger_tokens` | `assign_case_on_ledger_tokens` | `public.tg_claim_id_assign_case` | INSERT, UPDATE |
| `homeowner_ledger_tokens` | `trg_hlt_updated_at` | `public.set_updated_at` | UPDATE |
| `loss_draft_tracking` | `assign_case_on_loss_draft` | `public.tg_loss_draft_assign_case` | INSERT, UPDATE |
| `micro_deposit_verifications` | `trg_micro_deposit_verifications_updated_at` | `public.set_updated_at` | UPDATE |
| `moov_invoice_customers` | `moov_invoice_customers_set_updated_at` | `public.update_updated_at_column` | UPDATE |
| `moov_invoices` | `moov_invoices_set_updated_at` | `public.update_updated_at_column` | UPDATE |
| `moov_invoices` | `trg_log_invoice_usage` | `public.log_usage_event` | UPDATE |
| `mortgage_companies` | `update_mortgage_companies_updated_at` | `public.update_updated_at_column` | UPDATE |
| `mortgage_desk_config` | `mortgage_desk_config_set_updated_at` | `public.update_updated_at_column` | UPDATE |
| `mortgage_handling_requests` | `mortgage_handling_requests_set_updated_at` | `public.update_updated_at_column` | UPDATE |
| `mortgage_releases` | `assign_case_on_mortgage_releases` | `public.tg_claim_id_assign_case` | INSERT, UPDATE |
| `mortgage_request_library_documents` | `set_mortgage_request_library_documents_updated_at` | `public.update_updated_at_column` | UPDATE |
| `notification_preferences` | `update_notification_preferences_updated_at` | `public.update_updated_at_column` | UPDATE |
| `payment_idempotency_keys` | `set_payment_idempotency_keys_updated_at` | `public.update_updated_at_column` | UPDATE |
| `payment_method_verifications` | `trg_pmv_updated` | `public.set_updated_at` | UPDATE |
| `payment_methods` | `update_payment_methods_updated_at` | `public.update_updated_at_column` | UPDATE |
| `payment_provider_accounts` | `set_payment_provider_accounts_updated_at` | `public.update_updated_at_column` | UPDATE |
| `payment_provider_files` | `payment_provider_files_set_updated_at` | `public.update_updated_at_column` | UPDATE |
| `payment_provider_methods` | `set_payment_provider_methods_updated_at` | `public.update_updated_at_column` | UPDATE |
| `payment_sweep_configs` | `set_payment_sweep_configs_updated_at` | `public.update_updated_at_column` | UPDATE |
| `payment_transfer_groups` | `trg_ptg_updated` | `public.set_updated_at` | UPDATE |
| `payment_transfers` | `set_payment_transfers_updated_at` | `public.update_updated_at_column` | UPDATE |
| `payment_wallet_sub_ledgers` | `trg_pwsl_updated` | `public.set_updated_at` | UPDATE |
| `payment_wallets` | `trg_pw_updated` | `public.set_updated_at` | UPDATE |
| `payroll_runs` | `payroll_runs_set_updated_at` | `public.update_updated_at_column` | UPDATE |
| `plaid_transfer_events` | `set_plaid_transfer_events_updated_at` | `public.update_updated_at_column` | UPDATE |
| `plaid_webhook_cursors` | `set_plaid_webhook_cursors_updated_at` | `public.update_updated_at_column` | UPDATE |
| `platform_announcements` | `update_platform_announcements_updated_at` | `public.update_updated_at_column` | UPDATE |
| `platform_fee_line_items` | `trg_platform_fee_line_items_updated_at` | `public.update_updated_at_column` | UPDATE |
| `platform_fee_occurrences` | `trg_platform_fee_occurrences_updated_at` | `public.update_updated_at_column` | UPDATE |
| `platform_fee_schedules` | `trg_platform_fee_schedules_updated_at` | `public.update_updated_at_column` | UPDATE |
| `profiles` | `update_profiles_updated_at` | `public.update_updated_at_column` | UPDATE |
| `recipient_tax_profiles` | `recipient_tax_profiles_set_updated_at` | `public.set_updated_at` | UPDATE |
| `referral_alerts` | `update_referral_alerts_updated_at` | `public.update_updated_at_column` | UPDATE |
| `referral_events` | `trg_referral_events_updated_at` | `public.set_updated_at` | UPDATE |
| `referrers` | `update_referrers_updated_at` | `public.update_updated_at_column` | UPDATE |
| `signature_field_templates` | `update_signature_field_templates_updated_at` | `public.update_updated_at_column` | UPDATE |
| `signature_requests` | `assign_case_on_signature_requests` | `public.tg_claim_id_assign_case` | INSERT, UPDATE |
| `signature_requests` | `update_signature_requests_updated_at` | `public.update_updated_at_column` | UPDATE |
| `sms_messages` | `update_sms_messages_updated_at` | `public.update_updated_at_column` | UPDATE |
| `stakeholder_accounts` | `trg_autoattach_homeowner_bank` | `public.autoattach_homeowner_bank_on_verify` | UPDATE |
| `stakeholder_accounts` | `trg_enforce_single_primary` | `public.enforce_single_primary_account` | INSERT, UPDATE |
| `stakeholder_accounts` | `trg_enforce_stakeholder_caps` | `public.enforce_stakeholder_caps` | INSERT |
| `stakeholder_accounts` | `trg_stakeholder_accounts_updated_at` | `public.set_updated_at` | UPDATE |
| `stakeholder_limit_requests` | `trg_stakeholder_limit_requests_updated_at` | `public.set_updated_at` | UPDATE |
| `tenant_billing_accounts` | `update_tenant_billing_accounts_updated_at` | `public.update_updated_at_column` | UPDATE |
| `tenant_documents` | `trg_tenant_documents_updated_at` | `public.update_updated_at_column` | UPDATE |
| `tenant_email_settings` | `tenant_email_settings_updated_at` | `public.tenant_email_settings_touch_updated_at` | UPDATE |
| `tenant_maintenance_payments` | `tenant_maintenance_payments_set_updated_at` | `public.set_updated_at` | UPDATE |
| `tenant_openai_credentials` | `trg_tenant_openai_creds_updated_at` | `public.update_updated_at_column` | UPDATE |
| `tenant_users` | `update_tenant_users_updated_at` | `public.update_updated_at_column` | UPDATE |
| `tenant_vetting_documents` | `tenant_vetting_documents_updated_at` | `public.update_updated_at_column` | UPDATE |
| `tenant_wallet_funding_settings` | `trg_twfs_updated_at` | `public.update_updated_at_column` | UPDATE |
| `tenants` | `trg_auto_referral_code` | `public.auto_generate_referral_code` | INSERT |
| `tenants` | `trg_init_tenant_credits` | `public.init_tenant_credit_balance` | INSERT |
| `tenants` | `update_tenants_updated_at` | `public.update_updated_at_column` | UPDATE |
| `wallet_funding_queue` | `wallet_funding_queue_touch` | `public.update_updated_at_column` | UPDATE |
| `wallet_funding_requests` | `trg_wfr_updated_at` | `public.update_updated_at_column` | UPDATE |

### other (0 public)
None in restored public schema.

