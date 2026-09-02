-- AWS staging SELECT-only RLS policy set.
-- DO NOT ENABLE ROW LEVEL SECURITY on restored tables in this phase.
-- No INSERT/UPDATE/DELETE policies: writes stay in the API.
-- Excludes original service_role/anon policies and USING(true) open writes.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;
GRANT authenticated TO checksops;

DROP POLICY IF EXISTS aws_select_ach_authorizations ON public.ach_authorizations;
CREATE POLICY aws_select_ach_authorizations ON public.ach_authorizations
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_actum_transactions ON public.actum_transactions;
CREATE POLICY aws_select_actum_transactions ON public.actum_transactions
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_ai_response_cache ON public.ai_response_cache;
CREATE POLICY aws_select_ai_response_cache ON public.ai_response_cache
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_audit_logs ON public.audit_logs;
CREATE POLICY aws_select_audit_logs ON public.audit_logs
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_cash_job_attachments ON public.cash_job_attachments;
CREATE POLICY aws_select_cash_job_attachments ON public.cash_job_attachments
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_cash_job_line_items ON public.cash_job_line_items;
CREATE POLICY aws_select_cash_job_line_items ON public.cash_job_line_items
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_cash_job_payments ON public.cash_job_payments;
CREATE POLICY aws_select_cash_job_payments ON public.cash_job_payments
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_cash_jobs ON public.cash_jobs;
CREATE POLICY aws_select_cash_jobs ON public.cash_jobs
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_check_audit_log ON public.check_audit_log;
CREATE POLICY aws_select_check_audit_log ON public.check_audit_log
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_check_billing_config ON public.check_billing_config;
CREATE POLICY aws_select_check_billing_config ON public.check_billing_config
  FOR SELECT TO authenticated
  USING ((active = true) OR public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_check_billing_events ON public.check_billing_events;
CREATE POLICY aws_select_check_billing_events ON public.check_billing_events
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_check_cases ON public.check_cases;
CREATE POLICY aws_select_check_cases ON public.check_cases
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_check_deletion_log ON public.check_deletion_log;
CREATE POLICY aws_select_check_deletion_log ON public.check_deletion_log
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_id));

DROP POLICY IF EXISTS aws_select_check_deposit_image_backfill_queue ON public.check_deposit_image_backfill_queue;
CREATE POLICY aws_select_check_deposit_image_backfill_queue ON public.check_deposit_image_backfill_queue
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_id));

DROP POLICY IF EXISTS aws_select_check_eligibility_results ON public.check_eligibility_results;
CREATE POLICY aws_select_check_eligibility_results ON public.check_eligibility_results
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_id));

DROP POLICY IF EXISTS aws_select_check_endorsement_events ON public.check_endorsement_events;
CREATE POLICY aws_select_check_endorsement_events ON public.check_endorsement_events
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_id));

DROP POLICY IF EXISTS aws_select_check_endorsements ON public.check_endorsements;
CREATE POLICY aws_select_check_endorsements ON public.check_endorsements
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_check_files ON public.check_files;
CREATE POLICY aws_select_check_files ON public.check_files
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_intake_item_id));

DROP POLICY IF EXISTS aws_select_check_intake_items ON public.check_intake_items;
CREATE POLICY aws_select_check_intake_items ON public.check_intake_items
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_check_intake_mortgage_draws ON public.check_intake_mortgage_draws;
CREATE POLICY aws_select_check_intake_mortgage_draws ON public.check_intake_mortgage_draws
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_id));

DROP POLICY IF EXISTS aws_select_check_message_reads ON public.check_message_reads;
CREATE POLICY aws_select_check_message_reads ON public.check_message_reads
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_id));

DROP POLICY IF EXISTS aws_select_check_messages ON public.check_messages;
CREATE POLICY aws_select_check_messages ON public.check_messages
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_id));

DROP POLICY IF EXISTS aws_select_check_payees ON public.check_payees;
CREATE POLICY aws_select_check_payees ON public.check_payees
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_check_payment_directions ON public.check_payment_directions;
CREATE POLICY aws_select_check_payment_directions ON public.check_payment_directions
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_id));

DROP POLICY IF EXISTS aws_select_check_reconciliation_alerts ON public.check_reconciliation_alerts;
CREATE POLICY aws_select_check_reconciliation_alerts ON public.check_reconciliation_alerts
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_intake_item_id));

DROP POLICY IF EXISTS aws_select_check_reissue_requests ON public.check_reissue_requests;
CREATE POLICY aws_select_check_reissue_requests ON public.check_reissue_requests
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_check_review_decisions ON public.check_review_decisions;
CREATE POLICY aws_select_check_review_decisions ON public.check_review_decisions
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_check_stakeholders ON public.check_stakeholders;
CREATE POLICY aws_select_check_stakeholders ON public.check_stakeholders
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_check_status_audit ON public.check_status_audit;
CREATE POLICY aws_select_check_status_audit ON public.check_status_audit
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_intake_item_id));

DROP POLICY IF EXISTS aws_select_checkalt_config ON public.checkalt_config;
CREATE POLICY aws_select_checkalt_config ON public.checkalt_config
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_checkalt_deposits ON public.checkalt_deposits;
CREATE POLICY aws_select_checkalt_deposits ON public.checkalt_deposits
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_checkalt_tenant_accounts ON public.checkalt_tenant_accounts;
CREATE POLICY aws_select_checkalt_tenant_accounts ON public.checkalt_tenant_accounts
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_checkalt_webhook_events ON public.checkalt_webhook_events;
CREATE POLICY aws_select_checkalt_webhook_events ON public.checkalt_webhook_events
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_claim_check_mortgage_draws ON public.claim_check_mortgage_draws;
CREATE POLICY aws_select_claim_check_mortgage_draws ON public.claim_check_mortgage_draws
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_id));

DROP POLICY IF EXISTS aws_select_claim_check_payments ON public.claim_check_payments;
CREATE POLICY aws_select_claim_check_payments ON public.claim_check_payments
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_claim_checks ON public.claim_checks;
CREATE POLICY aws_select_claim_checks ON public.claim_checks
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_intake_item_id));

DROP POLICY IF EXISTS aws_select_claim_disbursements ON public.claim_disbursements;
CREATE POLICY aws_select_claim_disbursements ON public.claim_disbursements
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_id));

DROP POLICY IF EXISTS aws_select_claim_files ON public.claim_files;
CREATE POLICY aws_select_claim_files ON public.claim_files
  FOR SELECT TO authenticated
  USING (public.aws_can_access_claim(claim_id));

DROP POLICY IF EXISTS aws_select_claim_folders ON public.claim_folders;
CREATE POLICY aws_select_claim_folders ON public.claim_folders
  FOR SELECT TO authenticated
  USING (public.aws_can_access_claim(claim_id));

DROP POLICY IF EXISTS aws_select_claim_operational_state ON public.claim_operational_state;
CREATE POLICY aws_select_claim_operational_state ON public.claim_operational_state
  FOR SELECT TO authenticated
  USING (public.aws_can_access_claim(claim_id));

DROP POLICY IF EXISTS aws_select_claim_payments ON public.claim_payments;
CREATE POLICY aws_select_claim_payments ON public.claim_payments
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_intake_item_id));

DROP POLICY IF EXISTS aws_select_claim_project_plans ON public.claim_project_plans;
CREATE POLICY aws_select_claim_project_plans ON public.claim_project_plans
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_claim_settlements ON public.claim_settlements;
CREATE POLICY aws_select_claim_settlements ON public.claim_settlements
  FOR SELECT TO authenticated
  USING (public.aws_can_access_claim(claim_id));

DROP POLICY IF EXISTS aws_select_claims ON public.claims;
CREATE POLICY aws_select_claims ON public.claims
  FOR SELECT TO authenticated
  USING (public.aws_can_access_claim(id));

DROP POLICY IF EXISTS aws_select_company_branding ON public.company_branding;
CREATE POLICY aws_select_company_branding ON public.company_branding
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_contractor_profiles ON public.contractor_profiles;
CREATE POLICY aws_select_contractor_profiles ON public.contractor_profiles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.aws_is_cross_tenant_reader() OR (is_directory_listed = true AND directory_opt_in = true));

DROP POLICY IF EXISTS aws_select_contractor_reviews ON public.contractor_reviews;
CREATE POLICY aws_select_contractor_reviews ON public.contractor_reviews
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(org_id) OR public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_deposit_attachments ON public.deposit_attachments;
CREATE POLICY aws_select_deposit_attachments ON public.deposit_attachments
  FOR SELECT TO authenticated
  USING (public.aws_can_access_deposit_item(deposit_item_id));

DROP POLICY IF EXISTS aws_select_deposit_audit_log ON public.deposit_audit_log;
CREATE POLICY aws_select_deposit_audit_log ON public.deposit_audit_log
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader() OR EXISTS ( SELECT 1 FROM public.deposit_items di JOIN public.check_intake_items ci ON ci.id = di.check_id WHERE di.batch_id = deposit_audit_log.batch_id   AND public.aws_can_access_tenant(ci.tenant_id)));

DROP POLICY IF EXISTS aws_select_deposit_automation_runs ON public.deposit_automation_runs;
CREATE POLICY aws_select_deposit_automation_runs ON public.deposit_automation_runs
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_deposit_automation_settings ON public.deposit_automation_settings;
CREATE POLICY aws_select_deposit_automation_settings ON public.deposit_automation_settings
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_deposit_batches ON public.deposit_batches;
CREATE POLICY aws_select_deposit_batches ON public.deposit_batches
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader() OR EXISTS ( SELECT 1 FROM public.deposit_items di JOIN public.check_intake_items ci ON ci.id = di.check_id WHERE di.batch_id = deposit_batches.id   AND public.aws_can_access_tenant(ci.tenant_id)));

DROP POLICY IF EXISTS aws_select_deposit_daily_digest ON public.deposit_daily_digest;
CREATE POLICY aws_select_deposit_daily_digest ON public.deposit_daily_digest
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_deposit_digest_delivery_log ON public.deposit_digest_delivery_log;
CREATE POLICY aws_select_deposit_digest_delivery_log ON public.deposit_digest_delivery_log
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_deposit_escalation_events ON public.deposit_escalation_events;
CREATE POLICY aws_select_deposit_escalation_events ON public.deposit_escalation_events
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_deposit_escalation_rules ON public.deposit_escalation_rules;
CREATE POLICY aws_select_deposit_escalation_rules ON public.deposit_escalation_rules
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_deposit_exceptions ON public.deposit_exceptions;
CREATE POLICY aws_select_deposit_exceptions ON public.deposit_exceptions
  FOR SELECT TO authenticated
  USING (public.aws_can_access_deposit_item(deposit_item_id));

DROP POLICY IF EXISTS aws_select_deposit_items ON public.deposit_items;
CREATE POLICY aws_select_deposit_items ON public.deposit_items
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_id));

DROP POLICY IF EXISTS aws_select_deposit_manager_snapshots ON public.deposit_manager_snapshots;
CREATE POLICY aws_select_deposit_manager_snapshots ON public.deposit_manager_snapshots
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_deposit_notification_prefs ON public.deposit_notification_prefs;
CREATE POLICY aws_select_deposit_notification_prefs ON public.deposit_notification_prefs
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_deposit_pending_approvals ON public.deposit_pending_approvals;
CREATE POLICY aws_select_deposit_pending_approvals ON public.deposit_pending_approvals
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_deposit_provider_attempts ON public.deposit_provider_attempts;
CREATE POLICY aws_select_deposit_provider_attempts ON public.deposit_provider_attempts
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_deposit_provider_config ON public.deposit_provider_config;
CREATE POLICY aws_select_deposit_provider_config ON public.deposit_provider_config
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_deposit_webhook_events ON public.deposit_webhook_events;
CREATE POLICY aws_select_deposit_webhook_events ON public.deposit_webhook_events
  FOR SELECT TO authenticated
  USING (public.aws_can_access_deposit_item(deposit_item_id));

DROP POLICY IF EXISTS aws_select_disbursement_batches ON public.disbursement_batches;
CREATE POLICY aws_select_disbursement_batches ON public.disbursement_batches
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_disbursement_splits ON public.disbursement_splits;
CREATE POLICY aws_select_disbursement_splits ON public.disbursement_splits
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_document_templates ON public.document_templates;
CREATE POLICY aws_select_document_templates ON public.document_templates
  FOR SELECT TO authenticated
  USING ((is_active = true) OR public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_email_send_log ON public.email_send_log;
CREATE POLICY aws_select_email_send_log ON public.email_send_log
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_email_send_state ON public.email_send_state;
CREATE POLICY aws_select_email_send_state ON public.email_send_state
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_email_templates ON public.email_templates;
CREATE POLICY aws_select_email_templates ON public.email_templates
  FOR SELECT TO authenticated
  USING ((is_active = true) OR public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_email_unsubscribe_tokens ON public.email_unsubscribe_tokens;
CREATE POLICY aws_select_email_unsubscribe_tokens ON public.email_unsubscribe_tokens
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_emails ON public.emails;
CREATE POLICY aws_select_emails ON public.emails
  FOR SELECT TO authenticated
  USING (public.aws_can_access_claim(claim_id));

DROP POLICY IF EXISTS aws_select_endorsement_audit_log ON public.endorsement_audit_log;
CREATE POLICY aws_select_endorsement_audit_log ON public.endorsement_audit_log
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_id));

DROP POLICY IF EXISTS aws_select_endorsement_automated_reminders ON public.endorsement_automated_reminders;
CREATE POLICY aws_select_endorsement_automated_reminders ON public.endorsement_automated_reminders
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_endorsement_requests ON public.endorsement_requests;
CREATE POLICY aws_select_endorsement_requests ON public.endorsement_requests
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_id));

DROP POLICY IF EXISTS aws_select_esign_event_logs ON public.esign_event_logs;
CREATE POLICY aws_select_esign_event_logs ON public.esign_event_logs
  FOR SELECT TO authenticated
  USING (public.aws_can_access_claim(claim_id));

DROP POLICY IF EXISTS aws_select_external_payment_recipients ON public.external_payment_recipients;
CREATE POLICY aws_select_external_payment_recipients ON public.external_payment_recipients
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_glba_security_events ON public.glba_security_events;
CREATE POLICY aws_select_glba_security_events ON public.glba_security_events
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_homeowner_bank_link_tokens ON public.homeowner_bank_link_tokens;
CREATE POLICY aws_select_homeowner_bank_link_tokens ON public.homeowner_bank_link_tokens
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_homeowner_check_uploads ON public.homeowner_check_uploads;
CREATE POLICY aws_select_homeowner_check_uploads ON public.homeowner_check_uploads
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader() OR contractor_user_id = auth.uid() OR lower(homeowner_email) = lower(COALESCE(auth.email(), '')));

DROP POLICY IF EXISTS aws_select_homeowner_deductible_payments ON public.homeowner_deductible_payments;
CREATE POLICY aws_select_homeowner_deductible_payments ON public.homeowner_deductible_payments
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_homeowner_directory_leads ON public.homeowner_directory_leads;
CREATE POLICY aws_select_homeowner_directory_leads ON public.homeowner_directory_leads
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_homeowner_intro_requests ON public.homeowner_intro_requests;
CREATE POLICY aws_select_homeowner_intro_requests ON public.homeowner_intro_requests
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader() OR contractor_user_id = auth.uid() OR lower(homeowner_email) = lower(COALESCE(auth.email(), '')));

DROP POLICY IF EXISTS aws_select_homeowner_ledger_check_uploads ON public.homeowner_ledger_check_uploads;
CREATE POLICY aws_select_homeowner_ledger_check_uploads ON public.homeowner_ledger_check_uploads
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_homeowner_ledger_events ON public.homeowner_ledger_events;
CREATE POLICY aws_select_homeowner_ledger_events ON public.homeowner_ledger_events
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_homeowner_ledger_tokens ON public.homeowner_ledger_tokens;
CREATE POLICY aws_select_homeowner_ledger_tokens ON public.homeowner_ledger_tokens
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_loss_draft_audit_log ON public.loss_draft_audit_log;
CREATE POLICY aws_select_loss_draft_audit_log ON public.loss_draft_audit_log
  FOR SELECT TO authenticated
  USING (public.aws_can_access_loss_draft(loss_draft_id));

DROP POLICY IF EXISTS aws_select_loss_draft_documents ON public.loss_draft_documents;
CREATE POLICY aws_select_loss_draft_documents ON public.loss_draft_documents
  FOR SELECT TO authenticated
  USING (public.aws_can_access_loss_draft(loss_draft_id));

DROP POLICY IF EXISTS aws_select_loss_draft_mortgage_intake ON public.loss_draft_mortgage_intake;
CREATE POLICY aws_select_loss_draft_mortgage_intake ON public.loss_draft_mortgage_intake
  FOR SELECT TO authenticated
  USING (public.aws_can_access_loss_draft(loss_draft_id));

DROP POLICY IF EXISTS aws_select_loss_draft_releases ON public.loss_draft_releases;
CREATE POLICY aws_select_loss_draft_releases ON public.loss_draft_releases
  FOR SELECT TO authenticated
  USING (public.aws_can_access_loss_draft(loss_draft_id));

DROP POLICY IF EXISTS aws_select_loss_draft_tracking ON public.loss_draft_tracking;
CREATE POLICY aws_select_loss_draft_tracking ON public.loss_draft_tracking
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_intake_item_id));

DROP POLICY IF EXISTS aws_select_micro_deposit_verifications ON public.micro_deposit_verifications;
CREATE POLICY aws_select_micro_deposit_verifications ON public.micro_deposit_verifications
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_moov_invoice_customers ON public.moov_invoice_customers;
CREATE POLICY aws_select_moov_invoice_customers ON public.moov_invoice_customers
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_moov_invoices ON public.moov_invoices;
CREATE POLICY aws_select_moov_invoices ON public.moov_invoices
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_mortgage_companies ON public.mortgage_companies;
CREATE POLICY aws_select_mortgage_companies ON public.mortgage_companies
  FOR SELECT TO authenticated
  USING (true OR public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_mortgage_desk_config ON public.mortgage_desk_config;
CREATE POLICY aws_select_mortgage_desk_config ON public.mortgage_desk_config
  FOR SELECT TO authenticated
  USING (true OR public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_mortgage_handling_requests ON public.mortgage_handling_requests;
CREATE POLICY aws_select_mortgage_handling_requests ON public.mortgage_handling_requests
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_mortgage_releases ON public.mortgage_releases;
CREATE POLICY aws_select_mortgage_releases ON public.mortgage_releases
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_id));

DROP POLICY IF EXISTS aws_select_mortgage_request_library_documents ON public.mortgage_request_library_documents;
CREATE POLICY aws_select_mortgage_request_library_documents ON public.mortgage_request_library_documents
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_notification_delivery_logs ON public.notification_delivery_logs;
CREATE POLICY aws_select_notification_delivery_logs ON public.notification_delivery_logs
  FOR SELECT TO authenticated
  USING (public.aws_can_access_same_tenant_user(user_id));

DROP POLICY IF EXISTS aws_select_notification_preferences ON public.notification_preferences;
CREATE POLICY aws_select_notification_preferences ON public.notification_preferences
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_notifications ON public.notifications;
CREATE POLICY aws_select_notifications ON public.notifications
  FOR SELECT TO authenticated
  USING (public.aws_can_access_claim(claim_id));

DROP POLICY IF EXISTS aws_select_payment_event_log ON public.payment_event_log;
CREATE POLICY aws_select_payment_event_log ON public.payment_event_log
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_payment_idempotency_keys ON public.payment_idempotency_keys;
CREATE POLICY aws_select_payment_idempotency_keys ON public.payment_idempotency_keys
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_payment_method_verifications ON public.payment_method_verifications;
CREATE POLICY aws_select_payment_method_verifications ON public.payment_method_verifications
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_payment_methods ON public.payment_methods;
CREATE POLICY aws_select_payment_methods ON public.payment_methods
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_payment_provider_accounts ON public.payment_provider_accounts;
CREATE POLICY aws_select_payment_provider_accounts ON public.payment_provider_accounts
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_payment_provider_files ON public.payment_provider_files;
CREATE POLICY aws_select_payment_provider_files ON public.payment_provider_files
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_payment_provider_methods ON public.payment_provider_methods;
CREATE POLICY aws_select_payment_provider_methods ON public.payment_provider_methods
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_payment_sweep_configs ON public.payment_sweep_configs;
CREATE POLICY aws_select_payment_sweep_configs ON public.payment_sweep_configs
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_payment_transfer_groups ON public.payment_transfer_groups;
CREATE POLICY aws_select_payment_transfer_groups ON public.payment_transfer_groups
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_payment_transfers ON public.payment_transfers;
CREATE POLICY aws_select_payment_transfers ON public.payment_transfers
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_payment_wallet_ledger ON public.payment_wallet_ledger;
CREATE POLICY aws_select_payment_wallet_ledger ON public.payment_wallet_ledger
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_payment_wallet_sub_ledgers ON public.payment_wallet_sub_ledgers;
CREATE POLICY aws_select_payment_wallet_sub_ledgers ON public.payment_wallet_sub_ledgers
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_payment_wallets ON public.payment_wallets;
CREATE POLICY aws_select_payment_wallets ON public.payment_wallets
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_payment_webhook_events ON public.payment_webhook_events;
CREATE POLICY aws_select_payment_webhook_events ON public.payment_webhook_events
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_payroll_runs ON public.payroll_runs;
CREATE POLICY aws_select_payroll_runs ON public.payroll_runs
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_pii_reveal_logs ON public.pii_reveal_logs;
CREATE POLICY aws_select_pii_reveal_logs ON public.pii_reveal_logs
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_plaid_transfer_events ON public.plaid_transfer_events;
CREATE POLICY aws_select_plaid_transfer_events ON public.plaid_transfer_events
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_plaid_webhook_cursors ON public.plaid_webhook_cursors;
CREATE POLICY aws_select_plaid_webhook_cursors ON public.plaid_webhook_cursors
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_platform_announcements ON public.platform_announcements;
CREATE POLICY aws_select_platform_announcements ON public.platform_announcements
  FOR SELECT TO authenticated
  USING ((is_active = true) OR public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_platform_fee_line_items ON public.platform_fee_line_items;
CREATE POLICY aws_select_platform_fee_line_items ON public.platform_fee_line_items
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_platform_fee_occurrences ON public.platform_fee_occurrences;
CREATE POLICY aws_select_platform_fee_occurrences ON public.platform_fee_occurrences
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_platform_fee_schedules ON public.platform_fee_schedules;
CREATE POLICY aws_select_platform_fee_schedules ON public.platform_fee_schedules
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_privacy_notice_acknowledgments ON public.privacy_notice_acknowledgments;
CREATE POLICY aws_select_privacy_notice_acknowledgments ON public.privacy_notice_acknowledgments
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_profiles ON public.profiles;
CREATE POLICY aws_select_profiles ON public.profiles
  FOR SELECT TO authenticated
  USING (public.aws_can_access_same_tenant_user(id));

DROP POLICY IF EXISTS aws_select_recipient_tax_profiles ON public.recipient_tax_profiles;
CREATE POLICY aws_select_recipient_tax_profiles ON public.recipient_tax_profiles
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_referral_alerts ON public.referral_alerts;
CREATE POLICY aws_select_referral_alerts ON public.referral_alerts
  FOR SELECT TO authenticated
  USING (public.aws_can_access_claim(claim_id));

DROP POLICY IF EXISTS aws_select_referral_events ON public.referral_events;
CREATE POLICY aws_select_referral_events ON public.referral_events
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(referrer_tenant_id) OR public.aws_can_access_tenant(referred_tenant_id));

DROP POLICY IF EXISTS aws_select_referrers ON public.referrers;
CREATE POLICY aws_select_referrers ON public.referrers
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_role_version_tracker ON public.role_version_tracker;
CREATE POLICY aws_select_role_version_tracker ON public.role_version_tracker
  FOR SELECT TO authenticated
  USING (public.aws_can_access_same_tenant_user(user_id));

DROP POLICY IF EXISTS aws_select_shared_check_messages ON public.shared_check_messages;
CREATE POLICY aws_select_shared_check_messages ON public.shared_check_messages
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_id));

DROP POLICY IF EXISTS aws_select_shared_checks ON public.shared_checks;
CREATE POLICY aws_select_shared_checks ON public.shared_checks
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_id));

DROP POLICY IF EXISTS aws_select_signature_document_presets ON public.signature_document_presets;
CREATE POLICY aws_select_signature_document_presets ON public.signature_document_presets
  FOR SELECT TO authenticated
  USING (true OR public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_signature_field_templates ON public.signature_field_templates;
CREATE POLICY aws_select_signature_field_templates ON public.signature_field_templates
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_signature_field_values ON public.signature_field_values;
CREATE POLICY aws_select_signature_field_values ON public.signature_field_values
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.signature_fields sf  WHERE sf.id = signature_field_values.field_id    AND public.aws_can_access_signature_request(sf.signature_request_id)));

DROP POLICY IF EXISTS aws_select_signature_fields ON public.signature_fields;
CREATE POLICY aws_select_signature_fields ON public.signature_fields
  FOR SELECT TO authenticated
  USING (public.aws_can_access_signature_request(signature_request_id));

DROP POLICY IF EXISTS aws_select_signature_requests ON public.signature_requests;
CREATE POLICY aws_select_signature_requests ON public.signature_requests
  FOR SELECT TO authenticated
  USING (public.aws_can_access_check(check_intake_item_id));

DROP POLICY IF EXISTS aws_select_signature_signers ON public.signature_signers;
CREATE POLICY aws_select_signature_signers ON public.signature_signers
  FOR SELECT TO authenticated
  USING (public.aws_can_access_signature_request(signature_request_id));

DROP POLICY IF EXISTS aws_select_sms_messages ON public.sms_messages;
CREATE POLICY aws_select_sms_messages ON public.sms_messages
  FOR SELECT TO authenticated
  USING (public.aws_can_access_claim(claim_id));

DROP POLICY IF EXISTS aws_select_stakeholder_account_verification_log ON public.stakeholder_account_verification_log;
CREATE POLICY aws_select_stakeholder_account_verification_log ON public.stakeholder_account_verification_log
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_stakeholder_accounts ON public.stakeholder_accounts;
CREATE POLICY aws_select_stakeholder_accounts ON public.stakeholder_accounts
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_stakeholder_limit_requests ON public.stakeholder_limit_requests;
CREATE POLICY aws_select_stakeholder_limit_requests ON public.stakeholder_limit_requests
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_storage_backup_log ON public.storage_backup_log;
CREATE POLICY aws_select_storage_backup_log ON public.storage_backup_log
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_suppressed_emails ON public.suppressed_emails;
CREATE POLICY aws_select_suppressed_emails ON public.suppressed_emails
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_tenant_bank_accounts ON public.tenant_bank_accounts;
CREATE POLICY aws_select_tenant_bank_accounts ON public.tenant_bank_accounts
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_tenant_billing_accounts ON public.tenant_billing_accounts;
CREATE POLICY aws_select_tenant_billing_accounts ON public.tenant_billing_accounts
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_tenant_credit_balances ON public.tenant_credit_balances;
CREATE POLICY aws_select_tenant_credit_balances ON public.tenant_credit_balances
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_tenant_credit_transactions ON public.tenant_credit_transactions;
CREATE POLICY aws_select_tenant_credit_transactions ON public.tenant_credit_transactions
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_tenant_documents ON public.tenant_documents;
CREATE POLICY aws_select_tenant_documents ON public.tenant_documents
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_tenant_email_settings ON public.tenant_email_settings;
CREATE POLICY aws_select_tenant_email_settings ON public.tenant_email_settings
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_tenant_maintenance_payments ON public.tenant_maintenance_payments;
CREATE POLICY aws_select_tenant_maintenance_payments ON public.tenant_maintenance_payments
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_tenant_openai_credentials ON public.tenant_openai_credentials;
CREATE POLICY aws_select_tenant_openai_credentials ON public.tenant_openai_credentials
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_tenant_partner_code_aliases ON public.tenant_partner_code_aliases;
CREATE POLICY aws_select_tenant_partner_code_aliases ON public.tenant_partner_code_aliases
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_tenant_partnerships ON public.tenant_partnerships;
CREATE POLICY aws_select_tenant_partnerships ON public.tenant_partnerships
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(inviter_tenant_id) OR public.aws_can_access_tenant(invitee_tenant_id));

DROP POLICY IF EXISTS aws_select_tenant_usage_logs ON public.tenant_usage_logs;
CREATE POLICY aws_select_tenant_usage_logs ON public.tenant_usage_logs
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_tenant_users ON public.tenant_users;
CREATE POLICY aws_select_tenant_users ON public.tenant_users
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id) OR user_id = auth.uid());

DROP POLICY IF EXISTS aws_select_tenant_vetting_documents ON public.tenant_vetting_documents;
CREATE POLICY aws_select_tenant_vetting_documents ON public.tenant_vetting_documents
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_tenant_wallet_funding_settings ON public.tenant_wallet_funding_settings;
CREATE POLICY aws_select_tenant_wallet_funding_settings ON public.tenant_wallet_funding_settings
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_tenants ON public.tenants;
CREATE POLICY aws_select_tenants ON public.tenants
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(id));

DROP POLICY IF EXISTS aws_select_user_roles ON public.user_roles;
CREATE POLICY aws_select_user_roles ON public.user_roles
  FOR SELECT TO authenticated
  USING (public.aws_can_access_same_tenant_user(user_id));

DROP POLICY IF EXISTS aws_select_user_sessions ON public.user_sessions;
CREATE POLICY aws_select_user_sessions ON public.user_sessions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_select_wallet_funding_queue ON public.wallet_funding_queue;
CREATE POLICY aws_select_wallet_funding_queue ON public.wallet_funding_queue
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_wallet_funding_requests ON public.wallet_funding_requests;
CREATE POLICY aws_select_wallet_funding_requests ON public.wallet_funding_requests
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS aws_select_zip_geocache ON public.zip_geocache;
CREATE POLICY aws_select_zip_geocache ON public.zip_geocache
  FOR SELECT TO authenticated
  USING (true OR public.aws_is_cross_tenant_reader());

