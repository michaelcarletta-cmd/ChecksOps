-- Retarget 47 former auth.users FKs to identity_accounts(application_user_id).
-- Staging only. Do not rewrite stored UUID values. Ninth UUID needs no Cognito sub.
-- ADD ... NOT VALID then VALIDATE. Stop the oneshot if orphans exist.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.identity_accounts'::regclass
      AND contype IN ('p','u')
      AND pg_get_constraintdef(oid) ILIKE '%application_user_id%'
  ) THEN
    RAISE EXCEPTION 'identity_accounts.application_user_id is not unique';
  END IF;
END $$;

ALTER TABLE public.profiles ADD CONSTRAINT profiles_id_identity_fkey FOREIGN KEY (id) REFERENCES public.identity_accounts(application_user_id) ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.tenant_users ADD CONSTRAINT tenant_users_user_id_identity_fkey FOREIGN KEY (user_id) REFERENCES public.identity_accounts(application_user_id) ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_user_id_identity_fkey FOREIGN KEY (user_id) REFERENCES public.identity_accounts(application_user_id) ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.contractor_profiles ADD CONSTRAINT contractor_profiles_user_id_identity_fkey FOREIGN KEY (user_id) REFERENCES public.identity_accounts(application_user_id) ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.notification_preferences ADD CONSTRAINT notification_preferences_user_id_identity_fkey FOREIGN KEY (user_id) REFERENCES public.identity_accounts(application_user_id) ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.contractor_reviews ADD CONSTRAINT contractor_reviews_author_user_id_identity_fkey FOREIGN KEY (author_user_id) REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.referral_events ADD CONSTRAINT referral_events_referred_user_id_identity_fkey FOREIGN KEY (referred_user_id) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.ach_authorizations ADD CONSTRAINT ach_authorizations_authorized_by_identity_fkey FOREIGN KEY (authorized_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.audit_logs ADD CONSTRAINT audit_logs_user_id_identity_fkey FOREIGN KEY (user_id) REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.cash_jobs ADD CONSTRAINT cash_jobs_created_by_identity_fkey FOREIGN KEY (created_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.check_audit_log ADD CONSTRAINT check_audit_log_actor_id_identity_fkey FOREIGN KEY (actor_id) REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.check_eligibility_results ADD CONSTRAINT check_eligibility_results_evaluated_by_identity_fkey FOREIGN KEY (evaluated_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.check_files ADD CONSTRAINT check_files_uploaded_by_identity_fkey FOREIGN KEY (uploaded_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.check_intake_items ADD CONSTRAINT check_intake_items_uploaded_by_identity_fkey FOREIGN KEY (uploaded_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.check_stakeholders ADD CONSTRAINT check_stakeholders_added_by_identity_fkey FOREIGN KEY (added_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.claim_checks ADD CONSTRAINT claim_checks_created_by_identity_fkey FOREIGN KEY (created_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.claim_settlements ADD CONSTRAINT claim_settlements_created_by_identity_fkey FOREIGN KEY (created_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.deposit_batches ADD CONSTRAINT deposit_batches_created_by_identity_fkey FOREIGN KEY (created_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.disbursement_batches ADD CONSTRAINT disbursement_batches_created_by_identity_fkey FOREIGN KEY (created_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.homeowner_bank_link_tokens ADD CONSTRAINT homeowner_bank_link_tokens_sent_by_user_id_identity_fkey FOREIGN KEY (sent_by_user_id) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.micro_deposit_verifications ADD CONSTRAINT micro_deposit_verifications_initiated_by_identity_fkey FOREIGN KEY (initiated_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.mortgage_handling_requests ADD CONSTRAINT mortgage_handling_requests_assigned_employee_id_identity_fkey FOREIGN KEY (assigned_employee_id) REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.mortgage_handling_requests ADD CONSTRAINT mortgage_handling_requests_requested_by_identity_fkey FOREIGN KEY (requested_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.stakeholder_account_verification_log ADD CONSTRAINT stakeholder_account_verification_log_actor_user_id_identity_fkey FOREIGN KEY (actor_user_id) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.stakeholder_accounts ADD CONSTRAINT stakeholder_accounts_created_by_identity_fkey FOREIGN KEY (created_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.tenant_maintenance_payments ADD CONSTRAINT tenant_maintenance_payments_recorded_by_identity_fkey FOREIGN KEY (recorded_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.tenant_openai_credentials ADD CONSTRAINT tenant_openai_credentials_created_by_identity_fkey FOREIGN KEY (created_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.ach_authorizations ADD CONSTRAINT ach_authorizations_revoked_by_identity_fkey FOREIGN KEY (revoked_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.cash_job_attachments ADD CONSTRAINT cash_job_attachments_uploaded_by_identity_fkey FOREIGN KEY (uploaded_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.cash_job_payments ADD CONSTRAINT cash_job_payments_created_by_identity_fkey FOREIGN KEY (created_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.check_endorsement_events ADD CONSTRAINT check_endorsement_events_actor_id_identity_fkey FOREIGN KEY (actor_id) REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.claim_check_payments ADD CONSTRAINT claim_check_payments_sender_user_id_identity_fkey FOREIGN KEY (sender_user_id) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.claim_files ADD CONSTRAINT claim_files_uploaded_by_identity_fkey FOREIGN KEY (uploaded_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.claim_folders ADD CONSTRAINT claim_folders_created_by_identity_fkey FOREIGN KEY (created_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.claim_payments ADD CONSTRAINT claim_payments_created_by_identity_fkey FOREIGN KEY (created_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.document_templates ADD CONSTRAINT document_templates_created_by_identity_fkey FOREIGN KEY (created_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.email_templates ADD CONSTRAINT email_templates_created_by_identity_fkey FOREIGN KEY (created_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.emails ADD CONSTRAINT emails_sent_by_identity_fkey FOREIGN KEY (sent_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.payroll_runs ADD CONSTRAINT payroll_runs_initiated_by_identity_fkey FOREIGN KEY (initiated_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.pii_reveal_logs ADD CONSTRAINT pii_reveal_logs_user_id_identity_fkey FOREIGN KEY (user_id) REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.platform_announcements ADD CONSTRAINT platform_announcements_created_by_identity_fkey FOREIGN KEY (created_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.signature_document_presets ADD CONSTRAINT signature_document_presets_created_by_identity_fkey FOREIGN KEY (created_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.signature_requests ADD CONSTRAINT signature_requests_created_by_identity_fkey FOREIGN KEY (created_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.sms_messages ADD CONSTRAINT sms_messages_user_id_identity_fkey FOREIGN KEY (user_id) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.stakeholder_limit_requests ADD CONSTRAINT stakeholder_limit_requests_requested_by_identity_fkey FOREIGN KEY (requested_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.stakeholder_limit_requests ADD CONSTRAINT stakeholder_limit_requests_reviewed_by_identity_fkey FOREIGN KEY (reviewed_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE public.tenant_billing_accounts ADD CONSTRAINT tenant_billing_accounts_ach_authorized_by_identity_fkey FOREIGN KEY (ach_authorized_by) REFERENCES public.identity_accounts(application_user_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;

ALTER TABLE public.profiles VALIDATE CONSTRAINT profiles_id_identity_fkey;
ALTER TABLE public.tenant_users VALIDATE CONSTRAINT tenant_users_user_id_identity_fkey;
ALTER TABLE public.user_roles VALIDATE CONSTRAINT user_roles_user_id_identity_fkey;
ALTER TABLE public.contractor_profiles VALIDATE CONSTRAINT contractor_profiles_user_id_identity_fkey;
ALTER TABLE public.notification_preferences VALIDATE CONSTRAINT notification_preferences_user_id_identity_fkey;
ALTER TABLE public.contractor_reviews VALIDATE CONSTRAINT contractor_reviews_author_user_id_identity_fkey;
ALTER TABLE public.referral_events VALIDATE CONSTRAINT referral_events_referred_user_id_identity_fkey;
ALTER TABLE public.ach_authorizations VALIDATE CONSTRAINT ach_authorizations_authorized_by_identity_fkey;
ALTER TABLE public.audit_logs VALIDATE CONSTRAINT audit_logs_user_id_identity_fkey;
ALTER TABLE public.cash_jobs VALIDATE CONSTRAINT cash_jobs_created_by_identity_fkey;
ALTER TABLE public.check_audit_log VALIDATE CONSTRAINT check_audit_log_actor_id_identity_fkey;
ALTER TABLE public.check_eligibility_results VALIDATE CONSTRAINT check_eligibility_results_evaluated_by_identity_fkey;
ALTER TABLE public.check_files VALIDATE CONSTRAINT check_files_uploaded_by_identity_fkey;
ALTER TABLE public.check_intake_items VALIDATE CONSTRAINT check_intake_items_uploaded_by_identity_fkey;
ALTER TABLE public.check_stakeholders VALIDATE CONSTRAINT check_stakeholders_added_by_identity_fkey;
ALTER TABLE public.claim_checks VALIDATE CONSTRAINT claim_checks_created_by_identity_fkey;
ALTER TABLE public.claim_settlements VALIDATE CONSTRAINT claim_settlements_created_by_identity_fkey;
ALTER TABLE public.deposit_batches VALIDATE CONSTRAINT deposit_batches_created_by_identity_fkey;
ALTER TABLE public.disbursement_batches VALIDATE CONSTRAINT disbursement_batches_created_by_identity_fkey;
ALTER TABLE public.homeowner_bank_link_tokens VALIDATE CONSTRAINT homeowner_bank_link_tokens_sent_by_user_id_identity_fkey;
ALTER TABLE public.micro_deposit_verifications VALIDATE CONSTRAINT micro_deposit_verifications_initiated_by_identity_fkey;
ALTER TABLE public.mortgage_handling_requests VALIDATE CONSTRAINT mortgage_handling_requests_assigned_employee_id_identity_fkey;
ALTER TABLE public.mortgage_handling_requests VALIDATE CONSTRAINT mortgage_handling_requests_requested_by_identity_fkey;
ALTER TABLE public.stakeholder_account_verification_log VALIDATE CONSTRAINT stakeholder_account_verification_log_actor_user_id_identity_fkey;
ALTER TABLE public.stakeholder_accounts VALIDATE CONSTRAINT stakeholder_accounts_created_by_identity_fkey;
ALTER TABLE public.tenant_maintenance_payments VALIDATE CONSTRAINT tenant_maintenance_payments_recorded_by_identity_fkey;
ALTER TABLE public.tenant_openai_credentials VALIDATE CONSTRAINT tenant_openai_credentials_created_by_identity_fkey;
ALTER TABLE public.ach_authorizations VALIDATE CONSTRAINT ach_authorizations_revoked_by_identity_fkey;
ALTER TABLE public.cash_job_attachments VALIDATE CONSTRAINT cash_job_attachments_uploaded_by_identity_fkey;
ALTER TABLE public.cash_job_payments VALIDATE CONSTRAINT cash_job_payments_created_by_identity_fkey;
ALTER TABLE public.check_endorsement_events VALIDATE CONSTRAINT check_endorsement_events_actor_id_identity_fkey;
ALTER TABLE public.claim_check_payments VALIDATE CONSTRAINT claim_check_payments_sender_user_id_identity_fkey;
ALTER TABLE public.claim_files VALIDATE CONSTRAINT claim_files_uploaded_by_identity_fkey;
ALTER TABLE public.claim_folders VALIDATE CONSTRAINT claim_folders_created_by_identity_fkey;
ALTER TABLE public.claim_payments VALIDATE CONSTRAINT claim_payments_created_by_identity_fkey;
ALTER TABLE public.document_templates VALIDATE CONSTRAINT document_templates_created_by_identity_fkey;
ALTER TABLE public.email_templates VALIDATE CONSTRAINT email_templates_created_by_identity_fkey;
ALTER TABLE public.emails VALIDATE CONSTRAINT emails_sent_by_identity_fkey;
ALTER TABLE public.payroll_runs VALIDATE CONSTRAINT payroll_runs_initiated_by_identity_fkey;
ALTER TABLE public.pii_reveal_logs VALIDATE CONSTRAINT pii_reveal_logs_user_id_identity_fkey;
ALTER TABLE public.platform_announcements VALIDATE CONSTRAINT platform_announcements_created_by_identity_fkey;
ALTER TABLE public.signature_document_presets VALIDATE CONSTRAINT signature_document_presets_created_by_identity_fkey;
ALTER TABLE public.signature_requests VALIDATE CONSTRAINT signature_requests_created_by_identity_fkey;
ALTER TABLE public.sms_messages VALIDATE CONSTRAINT sms_messages_user_id_identity_fkey;
ALTER TABLE public.stakeholder_limit_requests VALIDATE CONSTRAINT stakeholder_limit_requests_requested_by_identity_fkey;
ALTER TABLE public.stakeholder_limit_requests VALIDATE CONSTRAINT stakeholder_limit_requests_reviewed_by_identity_fkey;
ALTER TABLE public.tenant_billing_accounts VALIDATE CONSTRAINT tenant_billing_accounts_ach_authorized_by_identity_fkey;

