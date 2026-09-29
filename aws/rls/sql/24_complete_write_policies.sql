-- Remaining AWS staging write policies (107 tenant-scoped CREATE + 7 platform-owner).
-- mortgage_request_library_documents is DROP-only here: do not CREATE FOR ALL.
-- Overlay 29 installs validated INSERT-only. Re-running 24 after 29 fail-closes writes.
-- Does not ENABLE ROW LEVEL SECURITY. Does not replace aws_select_* (165).
-- No USING(true)/WITH CHECK(true). No anon. No service_role.
-- 13 server-side API tables and 2 obsolete tables have no write policy (default deny).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;
GRANT authenticated TO checksops;

DROP POLICY IF EXISTS aws_write_ach_authorizations ON public.ach_authorizations;
CREATE POLICY aws_write_ach_authorizations ON public.ach_authorizations
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_actum_transactions ON public.actum_transactions;
CREATE POLICY aws_write_actum_transactions ON public.actum_transactions
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_audit_logs ON public.audit_logs;
CREATE POLICY aws_write_audit_logs ON public.audit_logs
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND ( user_id = auth.uid() OR public.aws_is_cross_tenant_reader()))
  WITH CHECK (public.aws_is_authenticated() AND ( user_id = auth.uid() OR public.aws_is_cross_tenant_reader()));

DROP POLICY IF EXISTS aws_write_cash_job_attachments ON public.cash_job_attachments;
CREATE POLICY aws_write_cash_job_attachments ON public.cash_job_attachments
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_cash_job_line_items ON public.cash_job_line_items;
CREATE POLICY aws_write_cash_job_line_items ON public.cash_job_line_items
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_cash_job_payments ON public.cash_job_payments;
CREATE POLICY aws_write_cash_job_payments ON public.cash_job_payments
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_cash_jobs ON public.cash_jobs;
CREATE POLICY aws_write_cash_jobs ON public.cash_jobs
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_check_audit_log ON public.check_audit_log;
CREATE POLICY aws_write_check_audit_log ON public.check_audit_log
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_check_billing_config ON public.check_billing_config;
CREATE POLICY aws_write_check_billing_config ON public.check_billing_config
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_write_check_billing_events ON public.check_billing_events;
CREATE POLICY aws_write_check_billing_events ON public.check_billing_events
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_check_cases ON public.check_cases;
CREATE POLICY aws_write_check_cases ON public.check_cases
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_check_eligibility_results ON public.check_eligibility_results;
CREATE POLICY aws_write_check_eligibility_results ON public.check_eligibility_results
  FOR ALL TO authenticated
  USING (public.aws_can_write_check(check_id))
  WITH CHECK (public.aws_can_write_check(check_id));

DROP POLICY IF EXISTS aws_write_check_endorsement_events ON public.check_endorsement_events;
CREATE POLICY aws_write_check_endorsement_events ON public.check_endorsement_events
  FOR ALL TO authenticated
  USING (public.aws_can_write_check(check_id))
  WITH CHECK (public.aws_can_write_check(check_id));

DROP POLICY IF EXISTS aws_write_check_files ON public.check_files;
CREATE POLICY aws_write_check_files ON public.check_files
  FOR ALL TO authenticated
  USING (public.aws_can_write_check(check_intake_item_id))
  WITH CHECK (public.aws_can_write_check(check_intake_item_id));

DROP POLICY IF EXISTS aws_write_check_intake_mortgage_draws ON public.check_intake_mortgage_draws;
CREATE POLICY aws_write_check_intake_mortgage_draws ON public.check_intake_mortgage_draws
  FOR ALL TO authenticated
  USING (public.aws_can_write_check(check_id))
  WITH CHECK (public.aws_can_write_check(check_id));

DROP POLICY IF EXISTS aws_write_check_message_reads ON public.check_message_reads;
CREATE POLICY aws_write_check_message_reads ON public.check_message_reads
  FOR ALL TO authenticated
  USING (public.aws_can_write_check(check_id))
  WITH CHECK (public.aws_can_write_check(check_id));

DROP POLICY IF EXISTS aws_write_check_messages ON public.check_messages;
CREATE POLICY aws_write_check_messages ON public.check_messages
  FOR ALL TO authenticated
  USING (public.aws_can_write_check(check_id))
  WITH CHECK (public.aws_can_write_check(check_id));

DROP POLICY IF EXISTS aws_write_check_payees ON public.check_payees;
CREATE POLICY aws_write_check_payees ON public.check_payees
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_check_payment_directions ON public.check_payment_directions;
CREATE POLICY aws_write_check_payment_directions ON public.check_payment_directions
  FOR ALL TO authenticated
  USING (public.aws_can_write_check(check_id))
  WITH CHECK (public.aws_can_write_check(check_id));

DROP POLICY IF EXISTS aws_write_check_reissue_requests ON public.check_reissue_requests;
CREATE POLICY aws_write_check_reissue_requests ON public.check_reissue_requests
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_check_review_decisions ON public.check_review_decisions;
CREATE POLICY aws_write_check_review_decisions ON public.check_review_decisions
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_check_stakeholders ON public.check_stakeholders;
CREATE POLICY aws_write_check_stakeholders ON public.check_stakeholders
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_checkalt_tenant_accounts ON public.checkalt_tenant_accounts;
CREATE POLICY aws_write_checkalt_tenant_accounts ON public.checkalt_tenant_accounts
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_claim_check_mortgage_draws ON public.claim_check_mortgage_draws;
CREATE POLICY aws_write_claim_check_mortgage_draws ON public.claim_check_mortgage_draws
  FOR ALL TO authenticated
  USING (public.aws_can_write_check(check_id))
  WITH CHECK (public.aws_can_write_check(check_id));

DROP POLICY IF EXISTS aws_write_claim_check_payments ON public.claim_check_payments;
CREATE POLICY aws_write_claim_check_payments ON public.claim_check_payments
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_claim_checks ON public.claim_checks;
CREATE POLICY aws_write_claim_checks ON public.claim_checks
  FOR ALL TO authenticated
  USING (public.aws_can_write_check(check_intake_item_id))
  WITH CHECK (public.aws_can_write_check(check_intake_item_id));

DROP POLICY IF EXISTS aws_write_claim_disbursements ON public.claim_disbursements;
CREATE POLICY aws_write_claim_disbursements ON public.claim_disbursements
  FOR ALL TO authenticated
  USING (public.aws_can_write_check(check_id))
  WITH CHECK (public.aws_can_write_check(check_id));

DROP POLICY IF EXISTS aws_write_claim_operational_state ON public.claim_operational_state;
CREATE POLICY aws_write_claim_operational_state ON public.claim_operational_state
  FOR ALL TO authenticated
  USING (public.aws_can_write_claim(claim_id))
  WITH CHECK (public.aws_can_write_claim(claim_id));

DROP POLICY IF EXISTS aws_write_claim_payments ON public.claim_payments;
CREATE POLICY aws_write_claim_payments ON public.claim_payments
  FOR ALL TO authenticated
  USING (public.aws_can_write_check(check_intake_item_id))
  WITH CHECK (public.aws_can_write_check(check_intake_item_id));

DROP POLICY IF EXISTS aws_write_claim_project_plans ON public.claim_project_plans;
CREATE POLICY aws_write_claim_project_plans ON public.claim_project_plans
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_claim_settlements ON public.claim_settlements;
CREATE POLICY aws_write_claim_settlements ON public.claim_settlements
  FOR ALL TO authenticated
  USING (public.aws_can_write_claim(claim_id))
  WITH CHECK (public.aws_can_write_claim(claim_id));

DROP POLICY IF EXISTS aws_write_contractor_profiles ON public.contractor_profiles;
CREATE POLICY aws_write_contractor_profiles ON public.contractor_profiles
  FOR ALL TO authenticated
  USING (public.aws_can_write_same_tenant_user(user_id))
  WITH CHECK (public.aws_can_write_same_tenant_user(user_id));

DROP POLICY IF EXISTS aws_write_contractor_reviews ON public.contractor_reviews;
CREATE POLICY aws_write_contractor_reviews ON public.contractor_reviews
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(org_id))
  WITH CHECK (public.aws_can_write_tenant(org_id));

DROP POLICY IF EXISTS aws_write_deposit_attachments ON public.deposit_attachments;
CREATE POLICY aws_write_deposit_attachments ON public.deposit_attachments
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.deposit_items di WHERE di.id = deposit_item_id   AND public.aws_can_write_check(di.check_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.deposit_items di WHERE di.id = deposit_item_id   AND public.aws_can_write_check(di.check_id)));

DROP POLICY IF EXISTS aws_write_deposit_audit_log ON public.deposit_audit_log;
CREATE POLICY aws_write_deposit_audit_log ON public.deposit_audit_log
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.deposit_items di WHERE di.id = deposit_item_id   AND public.aws_can_write_check(di.check_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.deposit_items di WHERE di.id = deposit_item_id   AND public.aws_can_write_check(di.check_id)));

DROP POLICY IF EXISTS aws_write_deposit_batches ON public.deposit_batches;
CREATE POLICY aws_write_deposit_batches ON public.deposit_batches
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader() OR EXISTS ( SELECT 1 FROM public.deposit_items di JOIN public.check_intake_items ci ON ci.id = di.check_id WHERE di.batch_id = deposit_batches.id   AND public.aws_can_write_tenant(ci.tenant_id)))
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader() OR EXISTS ( SELECT 1 FROM public.deposit_items di JOIN public.check_intake_items ci ON ci.id = di.check_id WHERE di.batch_id = deposit_batches.id   AND public.aws_can_write_tenant(ci.tenant_id)));

DROP POLICY IF EXISTS aws_write_deposit_daily_digest ON public.deposit_daily_digest;
CREATE POLICY aws_write_deposit_daily_digest ON public.deposit_daily_digest
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_write_deposit_digest_delivery_log ON public.deposit_digest_delivery_log;
CREATE POLICY aws_write_deposit_digest_delivery_log ON public.deposit_digest_delivery_log
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_write_deposit_escalation_events ON public.deposit_escalation_events;
CREATE POLICY aws_write_deposit_escalation_events ON public.deposit_escalation_events
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.deposit_items di WHERE di.id = deposit_item_id   AND public.aws_can_write_check(di.check_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.deposit_items di WHERE di.id = deposit_item_id   AND public.aws_can_write_check(di.check_id)));

DROP POLICY IF EXISTS aws_write_deposit_exceptions ON public.deposit_exceptions;
CREATE POLICY aws_write_deposit_exceptions ON public.deposit_exceptions
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.deposit_items di WHERE di.id = deposit_item_id   AND public.aws_can_write_check(di.check_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.deposit_items di WHERE di.id = deposit_item_id   AND public.aws_can_write_check(di.check_id)));

DROP POLICY IF EXISTS aws_write_deposit_manager_snapshots ON public.deposit_manager_snapshots;
CREATE POLICY aws_write_deposit_manager_snapshots ON public.deposit_manager_snapshots
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_write_deposit_notification_prefs ON public.deposit_notification_prefs;
CREATE POLICY aws_write_deposit_notification_prefs ON public.deposit_notification_prefs
  FOR ALL TO authenticated
  USING (public.aws_can_write_same_tenant_user(user_id))
  WITH CHECK (public.aws_can_write_same_tenant_user(user_id));

DROP POLICY IF EXISTS aws_write_deposit_pending_approvals ON public.deposit_pending_approvals;
CREATE POLICY aws_write_deposit_pending_approvals ON public.deposit_pending_approvals
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_write_deposit_provider_attempts ON public.deposit_provider_attempts;
CREATE POLICY aws_write_deposit_provider_attempts ON public.deposit_provider_attempts
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.deposit_items di WHERE di.id = deposit_item_id   AND public.aws_can_write_check(di.check_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.deposit_items di WHERE di.id = deposit_item_id   AND public.aws_can_write_check(di.check_id)));

DROP POLICY IF EXISTS aws_write_deposit_webhook_events ON public.deposit_webhook_events;
CREATE POLICY aws_write_deposit_webhook_events ON public.deposit_webhook_events
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.deposit_items di WHERE di.id = deposit_item_id   AND public.aws_can_write_check(di.check_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.deposit_items di WHERE di.id = deposit_item_id   AND public.aws_can_write_check(di.check_id)));

DROP POLICY IF EXISTS aws_write_disbursement_splits ON public.disbursement_splits;
CREATE POLICY aws_write_disbursement_splits ON public.disbursement_splits
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_document_templates ON public.document_templates;
CREATE POLICY aws_write_document_templates ON public.document_templates
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_write_email_send_log ON public.email_send_log;
CREATE POLICY aws_write_email_send_log ON public.email_send_log
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_email_templates ON public.email_templates;
CREATE POLICY aws_write_email_templates ON public.email_templates
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_write_emails ON public.emails;
CREATE POLICY aws_write_emails ON public.emails
  FOR ALL TO authenticated
  USING (public.aws_can_write_claim(claim_id))
  WITH CHECK (public.aws_can_write_claim(claim_id));

DROP POLICY IF EXISTS aws_write_endorsement_audit_log ON public.endorsement_audit_log;
CREATE POLICY aws_write_endorsement_audit_log ON public.endorsement_audit_log
  FOR ALL TO authenticated
  USING (public.aws_can_write_check(check_id))
  WITH CHECK (public.aws_can_write_check(check_id));

DROP POLICY IF EXISTS aws_write_endorsement_requests ON public.endorsement_requests;
CREATE POLICY aws_write_endorsement_requests ON public.endorsement_requests
  FOR ALL TO authenticated
  USING (public.aws_can_write_check(check_id))
  WITH CHECK (public.aws_can_write_check(check_id));

DROP POLICY IF EXISTS aws_write_esign_event_logs ON public.esign_event_logs;
CREATE POLICY aws_write_esign_event_logs ON public.esign_event_logs
  FOR ALL TO authenticated
  USING (public.aws_can_write_claim(claim_id))
  WITH CHECK (public.aws_can_write_claim(claim_id));

DROP POLICY IF EXISTS aws_write_external_payment_recipients ON public.external_payment_recipients;
CREATE POLICY aws_write_external_payment_recipients ON public.external_payment_recipients
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_homeowner_bank_link_tokens ON public.homeowner_bank_link_tokens;
CREATE POLICY aws_write_homeowner_bank_link_tokens ON public.homeowner_bank_link_tokens
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_homeowner_check_uploads ON public.homeowner_check_uploads;
CREATE POLICY aws_write_homeowner_check_uploads ON public.homeowner_check_uploads
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader() OR contractor_user_id = auth.uid() OR public.aws_can_write_check(converted_check_id))
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader() OR contractor_user_id = auth.uid() OR public.aws_can_write_check(converted_check_id));

DROP POLICY IF EXISTS aws_write_homeowner_ledger_check_uploads ON public.homeowner_ledger_check_uploads;
CREATE POLICY aws_write_homeowner_ledger_check_uploads ON public.homeowner_ledger_check_uploads
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_homeowner_ledger_tokens ON public.homeowner_ledger_tokens;
CREATE POLICY aws_write_homeowner_ledger_tokens ON public.homeowner_ledger_tokens
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_loss_draft_audit_log ON public.loss_draft_audit_log;
CREATE POLICY aws_write_loss_draft_audit_log ON public.loss_draft_audit_log
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.loss_draft_tracking ldt WHERE ldt.id = loss_draft_id   AND public.aws_can_write_claim(ldt.claim_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.loss_draft_tracking ldt WHERE ldt.id = loss_draft_id   AND public.aws_can_write_claim(ldt.claim_id)));

DROP POLICY IF EXISTS aws_write_loss_draft_documents ON public.loss_draft_documents;
CREATE POLICY aws_write_loss_draft_documents ON public.loss_draft_documents
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.loss_draft_tracking ldt WHERE ldt.id = loss_draft_id   AND public.aws_can_write_claim(ldt.claim_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.loss_draft_tracking ldt WHERE ldt.id = loss_draft_id   AND public.aws_can_write_claim(ldt.claim_id)));

DROP POLICY IF EXISTS aws_write_loss_draft_releases ON public.loss_draft_releases;
CREATE POLICY aws_write_loss_draft_releases ON public.loss_draft_releases
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.loss_draft_tracking ldt WHERE ldt.id = loss_draft_id   AND public.aws_can_write_claim(ldt.claim_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.loss_draft_tracking ldt WHERE ldt.id = loss_draft_id   AND public.aws_can_write_claim(ldt.claim_id)));

DROP POLICY IF EXISTS aws_write_loss_draft_tracking ON public.loss_draft_tracking;
CREATE POLICY aws_write_loss_draft_tracking ON public.loss_draft_tracking
  FOR ALL TO authenticated
  USING (public.aws_can_write_check(check_intake_item_id))
  WITH CHECK (public.aws_can_write_check(check_intake_item_id));

DROP POLICY IF EXISTS aws_write_micro_deposit_verifications ON public.micro_deposit_verifications;
CREATE POLICY aws_write_micro_deposit_verifications ON public.micro_deposit_verifications
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_moov_invoice_customers ON public.moov_invoice_customers;
CREATE POLICY aws_write_moov_invoice_customers ON public.moov_invoice_customers
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_moov_invoices ON public.moov_invoices;
CREATE POLICY aws_write_moov_invoices ON public.moov_invoices
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_mortgage_companies ON public.mortgage_companies;
CREATE POLICY aws_write_mortgage_companies ON public.mortgage_companies
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_write_mortgage_desk_config ON public.mortgage_desk_config;
CREATE POLICY aws_write_mortgage_desk_config ON public.mortgage_desk_config
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_write_mortgage_handling_requests ON public.mortgage_handling_requests;
CREATE POLICY aws_write_mortgage_handling_requests ON public.mortgage_handling_requests
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_mortgage_request_library_documents ON public.mortgage_request_library_documents;
-- mortgage_request_library_documents: do not CREATE FOR ALL. Overlay 29 installs
-- validated INSERT-only. Re-running 24 after 29 fail-closes writes until 29.

DROP POLICY IF EXISTS aws_write_notification_delivery_logs ON public.notification_delivery_logs;
CREATE POLICY aws_write_notification_delivery_logs ON public.notification_delivery_logs
  FOR ALL TO authenticated
  USING (public.aws_can_write_same_tenant_user(user_id))
  WITH CHECK (public.aws_can_write_same_tenant_user(user_id));

DROP POLICY IF EXISTS aws_write_notification_preferences ON public.notification_preferences;
CREATE POLICY aws_write_notification_preferences ON public.notification_preferences
  FOR ALL TO authenticated
  USING (public.aws_can_write_same_tenant_user(user_id))
  WITH CHECK (public.aws_can_write_same_tenant_user(user_id));

DROP POLICY IF EXISTS aws_write_notifications ON public.notifications;
CREATE POLICY aws_write_notifications ON public.notifications
  FOR ALL TO authenticated
  USING (public.aws_can_write_claim(claim_id))
  WITH CHECK (public.aws_can_write_claim(claim_id));

DROP POLICY IF EXISTS aws_write_payment_event_log ON public.payment_event_log;
CREATE POLICY aws_write_payment_event_log ON public.payment_event_log
  FOR INSERT TO authenticated
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_payment_method_verifications ON public.payment_method_verifications;
CREATE POLICY aws_write_payment_method_verifications ON public.payment_method_verifications
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_payment_provider_methods ON public.payment_provider_methods;
CREATE POLICY aws_write_payment_provider_methods ON public.payment_provider_methods
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_payment_sweep_configs ON public.payment_sweep_configs;
CREATE POLICY aws_write_payment_sweep_configs ON public.payment_sweep_configs
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_payment_transfer_groups ON public.payment_transfer_groups;
CREATE POLICY aws_write_payment_transfer_groups ON public.payment_transfer_groups
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_payment_transfers ON public.payment_transfers;
CREATE POLICY aws_write_payment_transfers ON public.payment_transfers
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_payment_wallet_sub_ledgers ON public.payment_wallet_sub_ledgers;
CREATE POLICY aws_write_payment_wallet_sub_ledgers ON public.payment_wallet_sub_ledgers
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_payment_wallets ON public.payment_wallets;
CREATE POLICY aws_write_payment_wallets ON public.payment_wallets
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_payroll_runs ON public.payroll_runs;
CREATE POLICY aws_write_payroll_runs ON public.payroll_runs
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_pii_reveal_logs ON public.pii_reveal_logs;
CREATE POLICY aws_write_pii_reveal_logs ON public.pii_reveal_logs
  FOR ALL TO authenticated
  USING (public.aws_can_write_same_tenant_user(user_id))
  WITH CHECK (public.aws_can_write_same_tenant_user(user_id));

DROP POLICY IF EXISTS aws_write_platform_announcements ON public.platform_announcements;
CREATE POLICY aws_write_platform_announcements ON public.platform_announcements
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_write_platform_fee_schedules ON public.platform_fee_schedules;
CREATE POLICY aws_write_platform_fee_schedules ON public.platform_fee_schedules
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_profiles ON public.profiles;
CREATE POLICY aws_write_profiles ON public.profiles
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND ( id = auth.uid() OR public.aws_can_write_same_tenant_user(id)))
  WITH CHECK (public.aws_is_authenticated() AND ( id = auth.uid() OR public.aws_can_write_same_tenant_user(id)));

DROP POLICY IF EXISTS aws_write_recipient_tax_profiles ON public.recipient_tax_profiles;
CREATE POLICY aws_write_recipient_tax_profiles ON public.recipient_tax_profiles
  FOR ALL TO authenticated
  USING (public.aws_can_access_tax_profiles(tenant_id))
  WITH CHECK (public.aws_can_access_tax_profiles(tenant_id));

DROP POLICY IF EXISTS aws_write_referral_events ON public.referral_events;
CREATE POLICY aws_write_referral_events ON public.referral_events
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader() OR public.aws_can_write_tenant(referrer_tenant_id) OR public.aws_can_write_tenant(referred_tenant_id))
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader() OR public.aws_can_write_tenant(referrer_tenant_id) OR public.aws_can_write_tenant(referred_tenant_id));

DROP POLICY IF EXISTS aws_write_referrers ON public.referrers;
CREATE POLICY aws_write_referrers ON public.referrers
  FOR ALL TO authenticated
  USING (public.aws_can_write_same_tenant_user(user_id))
  WITH CHECK (public.aws_can_write_same_tenant_user(user_id));

DROP POLICY IF EXISTS aws_write_role_version_tracker ON public.role_version_tracker;
CREATE POLICY aws_write_role_version_tracker ON public.role_version_tracker
  FOR ALL TO authenticated
  USING (public.aws_can_write_same_tenant_user(user_id))
  WITH CHECK (public.aws_can_write_same_tenant_user(user_id));

DROP POLICY IF EXISTS aws_write_shared_check_messages ON public.shared_check_messages;
CREATE POLICY aws_write_shared_check_messages ON public.shared_check_messages
  FOR ALL TO authenticated
  USING (public.aws_can_write_check(check_id))
  WITH CHECK (public.aws_can_write_check(check_id));

DROP POLICY IF EXISTS aws_write_shared_checks ON public.shared_checks;
CREATE POLICY aws_write_shared_checks ON public.shared_checks
  FOR ALL TO authenticated
  USING (public.aws_can_write_check(check_id))
  WITH CHECK (public.aws_can_write_check(check_id));

DROP POLICY IF EXISTS aws_write_signature_field_templates ON public.signature_field_templates;
CREATE POLICY aws_write_signature_field_templates ON public.signature_field_templates
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_write_signature_requests ON public.signature_requests;
CREATE POLICY aws_write_signature_requests ON public.signature_requests
  FOR ALL TO authenticated
  USING (public.aws_can_write_check(check_intake_item_id))
  WITH CHECK (public.aws_can_write_check(check_intake_item_id));

DROP POLICY IF EXISTS aws_write_sms_messages ON public.sms_messages;
CREATE POLICY aws_write_sms_messages ON public.sms_messages
  FOR ALL TO authenticated
  USING (public.aws_can_write_claim(claim_id))
  WITH CHECK (public.aws_can_write_claim(claim_id));

DROP POLICY IF EXISTS aws_write_stakeholder_accounts ON public.stakeholder_accounts;
CREATE POLICY aws_write_stakeholder_accounts ON public.stakeholder_accounts
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_stakeholder_limit_requests ON public.stakeholder_limit_requests;
CREATE POLICY aws_write_stakeholder_limit_requests ON public.stakeholder_limit_requests
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_suppressed_emails ON public.suppressed_emails;
CREATE POLICY aws_write_suppressed_emails ON public.suppressed_emails
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_tenant_bank_accounts ON public.tenant_bank_accounts;
CREATE POLICY aws_write_tenant_bank_accounts ON public.tenant_bank_accounts
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_tenant_billing_accounts ON public.tenant_billing_accounts;
CREATE POLICY aws_write_tenant_billing_accounts ON public.tenant_billing_accounts
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_tenant_credit_balances ON public.tenant_credit_balances;
CREATE POLICY aws_write_tenant_credit_balances ON public.tenant_credit_balances
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_tenant_credit_transactions ON public.tenant_credit_transactions;
CREATE POLICY aws_write_tenant_credit_transactions ON public.tenant_credit_transactions
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_tenant_documents ON public.tenant_documents;
CREATE POLICY aws_write_tenant_documents ON public.tenant_documents
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_tenant_maintenance_payments ON public.tenant_maintenance_payments;
CREATE POLICY aws_write_tenant_maintenance_payments ON public.tenant_maintenance_payments
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_tenant_partner_code_aliases ON public.tenant_partner_code_aliases;
CREATE POLICY aws_write_tenant_partner_code_aliases ON public.tenant_partner_code_aliases
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_tenant_partnerships ON public.tenant_partnerships;
CREATE POLICY aws_write_tenant_partnerships ON public.tenant_partnerships
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader() OR public.aws_can_write_tenant(inviter_tenant_id) OR public.aws_can_write_tenant(invitee_tenant_id))
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader() OR public.aws_can_write_tenant(inviter_tenant_id) OR public.aws_can_write_tenant(invitee_tenant_id));

DROP POLICY IF EXISTS aws_write_tenant_users ON public.tenant_users;
CREATE POLICY aws_write_tenant_users ON public.tenant_users
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader() OR ( public.aws_can_write_tenant(tenant_id) AND public.has_role(auth.uid(), 'admin'::public.app_role)))
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader() OR ( public.aws_can_write_tenant(tenant_id) AND public.has_role(auth.uid(), 'admin'::public.app_role)));

DROP POLICY IF EXISTS aws_write_tenant_vetting_documents ON public.tenant_vetting_documents;
CREATE POLICY aws_write_tenant_vetting_documents ON public.tenant_vetting_documents
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_tenant_wallet_funding_settings ON public.tenant_wallet_funding_settings;
CREATE POLICY aws_write_tenant_wallet_funding_settings ON public.tenant_wallet_funding_settings
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DROP POLICY IF EXISTS aws_write_user_sessions ON public.user_sessions;
CREATE POLICY aws_write_user_sessions ON public.user_sessions
  FOR ALL TO authenticated
  USING (public.aws_can_write_same_tenant_user(user_id))
  WITH CHECK (public.aws_can_write_same_tenant_user(user_id));

-- Platform-owner/API tables: authenticated owner writes only. Not tenant staff.

DROP POLICY IF EXISTS aws_write_ai_response_cache ON public.ai_response_cache;
CREATE POLICY aws_write_ai_response_cache ON public.ai_response_cache
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_write_company_branding ON public.company_branding;
CREATE POLICY aws_write_company_branding ON public.company_branding
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_write_deposit_automation_settings ON public.deposit_automation_settings;
CREATE POLICY aws_write_deposit_automation_settings ON public.deposit_automation_settings
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_write_deposit_escalation_rules ON public.deposit_escalation_rules;
CREATE POLICY aws_write_deposit_escalation_rules ON public.deposit_escalation_rules
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_write_email_send_state ON public.email_send_state;
CREATE POLICY aws_write_email_send_state ON public.email_send_state
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_write_email_unsubscribe_tokens ON public.email_unsubscribe_tokens;
CREATE POLICY aws_write_email_unsubscribe_tokens ON public.email_unsubscribe_tokens
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader());

DROP POLICY IF EXISTS aws_write_payment_methods ON public.payment_methods;
CREATE POLICY aws_write_payment_methods ON public.payment_methods
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader());

-- Intentionally no write policies (default deny once RLS is on):
-- server_side_api: check_reconciliation_alerts, checkalt_config, checkalt_deposits, checkalt_webhook_events, deposit_provider_config, endorsement_automated_reminders, homeowner_directory_leads, homeowner_intro_requests, mortgage_releases, privacy_notice_acknowledgments, referral_alerts, signature_document_presets, signature_signers
-- do_not_restore: signature_field_values, signature_fields

