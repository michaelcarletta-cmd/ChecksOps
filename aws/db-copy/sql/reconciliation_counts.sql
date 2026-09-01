-- Pre/post copy row-count reconciliation.
-- PREPARATION ONLY: do not run against live or staging databases yet.
-- Run the same statements on the source snapshot and the RDS restore, then diff.

SELECT 'check_cases' AS table_name, count(*)::bigint AS row_count FROM public.check_cases
UNION ALL SELECT 'check_intake_items', count(*) FROM public.check_intake_items
UNION ALL SELECT 'check_payees', count(*) FROM public.check_payees
UNION ALL SELECT 'check_files', count(*) FROM public.check_files
UNION ALL SELECT 'check_stakeholders', count(*) FROM public.check_stakeholders
UNION ALL SELECT 'shared_checks', count(*) FROM public.shared_checks
UNION ALL SELECT 'deposit_batches', count(*) FROM public.deposit_batches
UNION ALL SELECT 'deposit_items', count(*) FROM public.deposit_items
UNION ALL SELECT 'checkalt_deposits', count(*) FROM public.checkalt_deposits
UNION ALL SELECT 'checkalt_tenant_accounts', count(*) FROM public.checkalt_tenant_accounts
UNION ALL SELECT 'deposit_exceptions', count(*) FROM public.deposit_exceptions
UNION ALL SELECT 'deposit_provider_attempts', count(*) FROM public.deposit_provider_attempts
UNION ALL SELECT 'check_endorsements', count(*) FROM public.check_endorsements
UNION ALL SELECT 'endorsement_requests', count(*) FROM public.endorsement_requests
UNION ALL SELECT 'check_endorsement_events', count(*) FROM public.check_endorsement_events
UNION ALL SELECT 'endorsement_audit_log', count(*) FROM public.endorsement_audit_log
UNION ALL SELECT 'disbursement_batches', count(*) FROM public.disbursement_batches
UNION ALL SELECT 'disbursement_splits', count(*) FROM public.disbursement_splits
UNION ALL SELECT 'claim_disbursements', count(*) FROM public.claim_disbursements
UNION ALL SELECT 'claim_check_payments', count(*) FROM public.claim_check_payments
UNION ALL SELECT 'claim_payments', count(*) FROM public.claim_payments
UNION ALL SELECT 'payment_webhook_events', count(*) FROM public.payment_webhook_events
UNION ALL SELECT 'payment_event_log', count(*) FROM public.payment_event_log
UNION ALL SELECT 'payment_idempotency_keys', count(*) FROM public.payment_idempotency_keys
UNION ALL SELECT 'checkalt_webhook_events', count(*) FROM public.checkalt_webhook_events
UNION ALL SELECT 'deposit_webhook_events', count(*) FROM public.deposit_webhook_events
UNION ALL SELECT 'plaid_webhook_cursors', count(*) FROM public.plaid_webhook_cursors
UNION ALL SELECT 'payment_wallets', count(*) FROM public.payment_wallets
UNION ALL SELECT 'payment_wallet_ledger', count(*) FROM public.payment_wallet_ledger
UNION ALL SELECT 'payment_wallet_sub_ledgers', count(*) FROM public.payment_wallet_sub_ledgers
UNION ALL SELECT 'payment_provider_accounts', count(*) FROM public.payment_provider_accounts
UNION ALL SELECT 'payment_provider_methods', count(*) FROM public.payment_provider_methods
UNION ALL SELECT 'payment_transfers', count(*) FROM public.payment_transfers
UNION ALL SELECT 'payment_transfer_groups', count(*) FROM public.payment_transfer_groups
UNION ALL SELECT 'payment_sweep_configs', count(*) FROM public.payment_sweep_configs
UNION ALL SELECT 'wallet_funding_requests', count(*) FROM public.wallet_funding_requests
UNION ALL SELECT 'wallet_funding_queue', count(*) FROM public.wallet_funding_queue
UNION ALL SELECT 'tenants', count(*) FROM public.tenants
UNION ALL SELECT 'tenant_users', count(*) FROM public.tenant_users
UNION ALL SELECT 'user_roles', count(*) FROM public.user_roles
UNION ALL SELECT 'profiles', count(*) FROM public.profiles
UNION ALL SELECT 'stakeholder_accounts', count(*) FROM public.stakeholder_accounts
UNION ALL SELECT 'claims', count(*) FROM public.claims
UNION ALL SELECT 'claim_checks', count(*) FROM public.claim_checks
UNION ALL SELECT 'claim_files', count(*) FROM public.claim_files
UNION ALL SELECT 'loss_draft_tracking', count(*) FROM public.loss_draft_tracking
UNION ALL SELECT 'homeowner_ledger_events', count(*) FROM public.homeowner_ledger_events
UNION ALL SELECT 'audit_logs', count(*) FROM public.audit_logs
UNION ALL SELECT 'check_audit_log', count(*) FROM public.check_audit_log
UNION ALL SELECT 'check_status_audit', count(*) FROM public.check_status_audit
UNION ALL SELECT 'deposit_audit_log', count(*) FROM public.deposit_audit_log
UNION ALL SELECT 'loss_draft_audit_log', count(*) FROM public.loss_draft_audit_log
UNION ALL SELECT 'esign_event_logs', count(*) FROM public.esign_event_logs
UNION ALL SELECT 'check_reconciliation_alerts', count(*) FROM public.check_reconciliation_alerts
ORDER BY table_name;
