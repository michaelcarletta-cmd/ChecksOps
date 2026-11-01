-- SQL 136: the 24 money tables writable by an authenticated session only on a server write path.
-- AWS only: nothing under supabase/migrations changes.
--
-- Why: security audit 2026-10-29, finding 14 (medium). SQL 90 made public.aws_can_write_tenant() plain
-- tenant membership, so the SQL 24 policies `aws_write_<table> FOR ALL TO authenticated USING / WITH
-- CHECK (public.aws_can_write_tenant(tenant_id))` (aws/rls/sql/24_complete_write_policies.sql) let any
-- tenant member's session INSERT, UPDATE or DELETE the money tables directly; the gated SQL 72 / SQL 91
-- policies are permissive too, so they add nothing. Owner decision 2026-10-31 (a): two steps, the API
-- first (#1498: every API money write sets the transaction-local, server-only GUC
-- request.money_write = '1' first; aws/functions/api/money-write-flag.mjs, aws/docs/money-write-flag.md),
-- then this file.
--
-- STOP: do not apply this file in staging or in production before #1498's API is live there: the
-- eight production overlay members (money-write-flag.mjs ADD, then moov-wallet-sync, parity
-- moov-functions, tenant-settings-handlers, tenant-collection-v2-settlement, tenant-collection-v2,
-- tenant-billing-engine, tenant-billing-handlers) AND a full Lambda rebuild carrying
-- invoice-provider.mjs, mortgage-ops-usage.mjs and tenant-collection-v2-uat.mjs. Applied earlier, every
-- API money write that does not yet set the flag is refused. Nothing in this file or its tooling can
-- check the Lambda: the runbook (ops/production-sql-136-apply.md) and the pins carry that gate.
--
-- What this file does:
-- 1) public.aws_money_write_allowed(): LANGUAGE sql, STABLE, SECURITY INVOKER, no search_path change.
--    True only while the session's transaction set one of the server-only GUCs:
--      request.money_write = '1'          (the #1498 API writers)
--      request.financial_execution = '1'  (SQL 72's writers: production moov-wallet-fund.mjs and
--                                         moov-send.mjs, which set it but not the SQL 72 activation
--                                         GUC, so aws_financial_execution_active() would be false)
--      public.aws_moov_onboarding_active()   (SQL 91 onboarding handlers)
--      public.aws_moov_webhook_apply_active() (SQL 91 provider webhook apply)
--    The browser sends no SQL and cannot set a GUC; the generic /data/write route never sets one and
--    refuses every money table. EXECUTE: revoked from PUBLIC, granted to checksops and authenticated (a
--    policy expression runs as the querying role).
-- 2) On each of the 24 money tables, three RESTRICTIVE policies TO authenticated, one per write
--    command, each requiring public.aws_money_write_allowed():
--      aws_money_write_gate_insert_<table>  FOR INSERT  WITH CHECK
--      aws_money_write_gate_update_<table>  FOR UPDATE  USING and WITH CHECK
--      aws_money_write_gate_delete_<table>  FOR DELETE  USING
--    Never FOR ALL (a restrictive FOR ALL would also filter SELECT). The permissive SQL 24 / SQL 72 /
--    SQL 91 policies stay and still decide which tenant's rows a session may write; the restrictive
--    policy decides that only a server write path may write at all. SELECT is unchanged.
--
-- Not affected: SECURITY DEFINER functions owned by the table owner (RLS does not apply to the owner
-- while the table is not FORCE ROW LEVEL SECURITY: SQL 98 / SQL 120 billing triggers, SQL 109 / SQL 62
-- transfer status writers, SQL 113 / SQL 138 payee functions) and FK referential actions. Not changed:
-- every existing policy, grant, table, column, index, trigger and row.
--
-- Preconditions fail closed (nothing changes otherwise):
--   a. the 24 tables, public.aws_moov_onboarding_active(), public.aws_moov_webhook_apply_active() and the
--      roles checksops and authenticated exist (sql136_table_missing, sql136_function_missing,
--      sql136_role_missing);
--   b. no money table is FORCE ROW LEVEL SECURITY (sql136_force_rls): the definer writers above rely
--      on the owner bypass;
--   c. every SECURITY DEFINER function in public whose body writes a money table is owned by a role
--      that bypasses RLS on that table (superuser, BYPASSRLS, or the table owner's privileges)
--      (sql136_definer_writer_cannot_bypass_rls);
--   d. no SECURITY INVOKER trigger function attached to any table writes a money table
--      (sql136_invoker_trigger_writes_money_table): such a trigger (the live-only
--      tg_accrue_mortgage_ops_billing would be one if it is SECURITY INVOKER) fires on a write that
--      did not set the flag and would now be refused.
--   The release engine checks b, c and d read-only before any apply (counts
--   money_tables_forced_rls, money_definer_writers_without_bypass, money_invoker_trigger_writers;
--   money_invoker_function_writers is reported only), so a staging read-live or production inspect
--   shows them first.
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL
-- executor runs it inside one transaction.
-- Idempotent: CREATE OR REPLACE with the same body, DROP POLICY IF EXISTS then CREATE POLICY, GRANT of a
-- held privilege and REVOKE of an absent one leave the same state. Not applied by this change: staging
-- first, then production, through the guarded SQL path (AGENTS.md).

DO $sql136_preconditions$
DECLARE
  v_tables text[] := ARRAY[
    'public.ach_authorizations',
    'public.actum_transactions',
    'public.check_billing_events',
    'public.claim_check_payments',
    'public.disbursement_splits',
    'public.external_payment_recipients',
    'public.micro_deposit_verifications',
    'public.moov_invoice_customers',
    'public.moov_invoices',
    'public.payment_method_verifications',
    'public.payment_provider_methods',
    'public.payment_sweep_configs',
    'public.payment_transfer_groups',
    'public.payment_transfers',
    'public.payment_wallet_sub_ledgers',
    'public.payment_wallets',
    'public.payroll_runs',
    'public.stakeholder_limit_requests',
    'public.tenant_bank_accounts',
    'public.tenant_billing_accounts',
    'public.tenant_credit_balances',
    'public.tenant_credit_transactions',
    'public.tenant_maintenance_payments',
    'public.tenant_wallet_funding_settings'
  ];
  v_table text;
  v_role text;
  v_n integer;
  v_names text;
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    IF pg_catalog.to_regclass(v_table) IS NULL THEN
      RAISE EXCEPTION 'sql136_table_missing: % does not exist', v_table
        USING ERRCODE = '42P01';
    END IF;
  END LOOP;
  IF pg_catalog.to_regprocedure('public.aws_moov_onboarding_active()') IS NULL
     OR pg_catalog.to_regprocedure('public.aws_moov_webhook_apply_active()') IS NULL THEN
    RAISE EXCEPTION 'sql136_function_missing: public.aws_moov_onboarding_active() and public.aws_moov_webhook_apply_active() must exist (SQL 91)'
      USING ERRCODE = '42883';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['checksops', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) THEN
      RAISE EXCEPTION 'sql136_role_missing: role % does not exist', v_role
        USING ERRCODE = '42704';
    END IF;
  END LOOP;
  SELECT count(*), pg_catalog.string_agg(c.oid::regclass::text, ', ') INTO v_n, v_names
    FROM pg_catalog.pg_class c
   WHERE c.oid = ANY (SELECT pg_catalog.to_regclass(t) FROM pg_catalog.unnest(v_tables) AS t)
     AND c.relforcerowsecurity;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'sql136_force_rls: % money tables are FORCE ROW LEVEL SECURITY (%)', v_n, v_names
      USING ERRCODE = '55000';
  END IF;
  SELECT count(*), pg_catalog.string_agg(DISTINCT p.oid::regprocedure::text, ', ') INTO v_n, v_names
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    JOIN pg_catalog.pg_roles o ON o.oid = p.proowner
    JOIN pg_catalog.pg_class c ON c.oid = ANY (SELECT pg_catalog.to_regclass(t) FROM pg_catalog.unnest(v_tables) AS t)
   WHERE p.prosecdef
     AND p.prosrc ~* ('\m(insert\s+into|update|delete\s+from)\s+(public\.)?' || c.relname || '\M')
     AND NOT (o.rolsuper OR o.rolbypassrls OR pg_catalog.pg_has_role(p.proowner, c.relowner, 'USAGE'));
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'sql136_definer_writer_cannot_bypass_rls: % SECURITY DEFINER writers of a money table are owned by a role that does not bypass its RLS (%)', v_n, v_names
      USING ERRCODE = '55000';
  END IF;
  SELECT count(*), pg_catalog.string_agg(DISTINCT p.oid::regprocedure::text, ', ') INTO v_n, v_names
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_class c ON c.oid = ANY (SELECT pg_catalog.to_regclass(t) FROM pg_catalog.unnest(v_tables) AS t)
   WHERE NOT p.prosecdef
     AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_trigger tg WHERE tg.tgfoid = p.oid AND NOT tg.tgisinternal)
     AND p.prosrc ~* ('\m(insert\s+into|update|delete\s+from)\s+(public\.)?' || c.relname || '\M');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'sql136_invoker_trigger_writes_money_table: % SECURITY INVOKER trigger functions write a money table and would be refused (%)', v_n, v_names
      USING ERRCODE = '55000';
  END IF;
END
$sql136_preconditions$;

-- 1) The one gate every restrictive policy calls.
CREATE OR REPLACE FUNCTION public.aws_money_write_allowed()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    current_setting('request.money_write', true) = '1'
    OR current_setting('request.financial_execution', true) = '1'
    OR public.aws_moov_onboarding_active()
    OR public.aws_moov_webhook_apply_active(),
    false);
$$;

COMMENT ON FUNCTION public.aws_money_write_allowed() IS
  'True only while a server write path set request.money_write, request.financial_execution, request.moov_onboarding or request.provider_webhook_apply to 1 in this transaction (SQL 136, finding 14).';

REVOKE ALL ON FUNCTION public.aws_money_write_allowed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_money_write_allowed() TO checksops, authenticated;

-- 2) Three restrictive write policies on each money table.
DROP POLICY IF EXISTS aws_money_write_gate_insert_ach_authorizations ON public.ach_authorizations;
CREATE POLICY aws_money_write_gate_insert_ach_authorizations ON public.ach_authorizations
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_ach_authorizations ON public.ach_authorizations;
CREATE POLICY aws_money_write_gate_update_ach_authorizations ON public.ach_authorizations
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_ach_authorizations ON public.ach_authorizations;
CREATE POLICY aws_money_write_gate_delete_ach_authorizations ON public.ach_authorizations
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_actum_transactions ON public.actum_transactions;
CREATE POLICY aws_money_write_gate_insert_actum_transactions ON public.actum_transactions
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_actum_transactions ON public.actum_transactions;
CREATE POLICY aws_money_write_gate_update_actum_transactions ON public.actum_transactions
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_actum_transactions ON public.actum_transactions;
CREATE POLICY aws_money_write_gate_delete_actum_transactions ON public.actum_transactions
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_check_billing_events ON public.check_billing_events;
CREATE POLICY aws_money_write_gate_insert_check_billing_events ON public.check_billing_events
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_check_billing_events ON public.check_billing_events;
CREATE POLICY aws_money_write_gate_update_check_billing_events ON public.check_billing_events
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_check_billing_events ON public.check_billing_events;
CREATE POLICY aws_money_write_gate_delete_check_billing_events ON public.check_billing_events
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_claim_check_payments ON public.claim_check_payments;
CREATE POLICY aws_money_write_gate_insert_claim_check_payments ON public.claim_check_payments
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_claim_check_payments ON public.claim_check_payments;
CREATE POLICY aws_money_write_gate_update_claim_check_payments ON public.claim_check_payments
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_claim_check_payments ON public.claim_check_payments;
CREATE POLICY aws_money_write_gate_delete_claim_check_payments ON public.claim_check_payments
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_disbursement_splits ON public.disbursement_splits;
CREATE POLICY aws_money_write_gate_insert_disbursement_splits ON public.disbursement_splits
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_disbursement_splits ON public.disbursement_splits;
CREATE POLICY aws_money_write_gate_update_disbursement_splits ON public.disbursement_splits
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_disbursement_splits ON public.disbursement_splits;
CREATE POLICY aws_money_write_gate_delete_disbursement_splits ON public.disbursement_splits
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_external_payment_recipients ON public.external_payment_recipients;
CREATE POLICY aws_money_write_gate_insert_external_payment_recipients ON public.external_payment_recipients
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_external_payment_recipients ON public.external_payment_recipients;
CREATE POLICY aws_money_write_gate_update_external_payment_recipients ON public.external_payment_recipients
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_external_payment_recipients ON public.external_payment_recipients;
CREATE POLICY aws_money_write_gate_delete_external_payment_recipients ON public.external_payment_recipients
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_micro_deposit_verifications ON public.micro_deposit_verifications;
CREATE POLICY aws_money_write_gate_insert_micro_deposit_verifications ON public.micro_deposit_verifications
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_micro_deposit_verifications ON public.micro_deposit_verifications;
CREATE POLICY aws_money_write_gate_update_micro_deposit_verifications ON public.micro_deposit_verifications
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_micro_deposit_verifications ON public.micro_deposit_verifications;
CREATE POLICY aws_money_write_gate_delete_micro_deposit_verifications ON public.micro_deposit_verifications
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_moov_invoice_customers ON public.moov_invoice_customers;
CREATE POLICY aws_money_write_gate_insert_moov_invoice_customers ON public.moov_invoice_customers
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_moov_invoice_customers ON public.moov_invoice_customers;
CREATE POLICY aws_money_write_gate_update_moov_invoice_customers ON public.moov_invoice_customers
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_moov_invoice_customers ON public.moov_invoice_customers;
CREATE POLICY aws_money_write_gate_delete_moov_invoice_customers ON public.moov_invoice_customers
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_moov_invoices ON public.moov_invoices;
CREATE POLICY aws_money_write_gate_insert_moov_invoices ON public.moov_invoices
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_moov_invoices ON public.moov_invoices;
CREATE POLICY aws_money_write_gate_update_moov_invoices ON public.moov_invoices
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_moov_invoices ON public.moov_invoices;
CREATE POLICY aws_money_write_gate_delete_moov_invoices ON public.moov_invoices
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_payment_method_verifications ON public.payment_method_verifications;
CREATE POLICY aws_money_write_gate_insert_payment_method_verifications ON public.payment_method_verifications
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_payment_method_verifications ON public.payment_method_verifications;
CREATE POLICY aws_money_write_gate_update_payment_method_verifications ON public.payment_method_verifications
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_payment_method_verifications ON public.payment_method_verifications;
CREATE POLICY aws_money_write_gate_delete_payment_method_verifications ON public.payment_method_verifications
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_payment_provider_methods ON public.payment_provider_methods;
CREATE POLICY aws_money_write_gate_insert_payment_provider_methods ON public.payment_provider_methods
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_payment_provider_methods ON public.payment_provider_methods;
CREATE POLICY aws_money_write_gate_update_payment_provider_methods ON public.payment_provider_methods
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_payment_provider_methods ON public.payment_provider_methods;
CREATE POLICY aws_money_write_gate_delete_payment_provider_methods ON public.payment_provider_methods
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_payment_sweep_configs ON public.payment_sweep_configs;
CREATE POLICY aws_money_write_gate_insert_payment_sweep_configs ON public.payment_sweep_configs
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_payment_sweep_configs ON public.payment_sweep_configs;
CREATE POLICY aws_money_write_gate_update_payment_sweep_configs ON public.payment_sweep_configs
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_payment_sweep_configs ON public.payment_sweep_configs;
CREATE POLICY aws_money_write_gate_delete_payment_sweep_configs ON public.payment_sweep_configs
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_payment_transfer_groups ON public.payment_transfer_groups;
CREATE POLICY aws_money_write_gate_insert_payment_transfer_groups ON public.payment_transfer_groups
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_payment_transfer_groups ON public.payment_transfer_groups;
CREATE POLICY aws_money_write_gate_update_payment_transfer_groups ON public.payment_transfer_groups
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_payment_transfer_groups ON public.payment_transfer_groups;
CREATE POLICY aws_money_write_gate_delete_payment_transfer_groups ON public.payment_transfer_groups
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_payment_transfers ON public.payment_transfers;
CREATE POLICY aws_money_write_gate_insert_payment_transfers ON public.payment_transfers
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_payment_transfers ON public.payment_transfers;
CREATE POLICY aws_money_write_gate_update_payment_transfers ON public.payment_transfers
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_payment_transfers ON public.payment_transfers;
CREATE POLICY aws_money_write_gate_delete_payment_transfers ON public.payment_transfers
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_payment_wallet_sub_ledgers ON public.payment_wallet_sub_ledgers;
CREATE POLICY aws_money_write_gate_insert_payment_wallet_sub_ledgers ON public.payment_wallet_sub_ledgers
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_payment_wallet_sub_ledgers ON public.payment_wallet_sub_ledgers;
CREATE POLICY aws_money_write_gate_update_payment_wallet_sub_ledgers ON public.payment_wallet_sub_ledgers
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_payment_wallet_sub_ledgers ON public.payment_wallet_sub_ledgers;
CREATE POLICY aws_money_write_gate_delete_payment_wallet_sub_ledgers ON public.payment_wallet_sub_ledgers
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_payment_wallets ON public.payment_wallets;
CREATE POLICY aws_money_write_gate_insert_payment_wallets ON public.payment_wallets
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_payment_wallets ON public.payment_wallets;
CREATE POLICY aws_money_write_gate_update_payment_wallets ON public.payment_wallets
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_payment_wallets ON public.payment_wallets;
CREATE POLICY aws_money_write_gate_delete_payment_wallets ON public.payment_wallets
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_payroll_runs ON public.payroll_runs;
CREATE POLICY aws_money_write_gate_insert_payroll_runs ON public.payroll_runs
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_payroll_runs ON public.payroll_runs;
CREATE POLICY aws_money_write_gate_update_payroll_runs ON public.payroll_runs
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_payroll_runs ON public.payroll_runs;
CREATE POLICY aws_money_write_gate_delete_payroll_runs ON public.payroll_runs
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_stakeholder_limit_requests ON public.stakeholder_limit_requests;
CREATE POLICY aws_money_write_gate_insert_stakeholder_limit_requests ON public.stakeholder_limit_requests
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_stakeholder_limit_requests ON public.stakeholder_limit_requests;
CREATE POLICY aws_money_write_gate_update_stakeholder_limit_requests ON public.stakeholder_limit_requests
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_stakeholder_limit_requests ON public.stakeholder_limit_requests;
CREATE POLICY aws_money_write_gate_delete_stakeholder_limit_requests ON public.stakeholder_limit_requests
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_tenant_bank_accounts ON public.tenant_bank_accounts;
CREATE POLICY aws_money_write_gate_insert_tenant_bank_accounts ON public.tenant_bank_accounts
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_tenant_bank_accounts ON public.tenant_bank_accounts;
CREATE POLICY aws_money_write_gate_update_tenant_bank_accounts ON public.tenant_bank_accounts
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_tenant_bank_accounts ON public.tenant_bank_accounts;
CREATE POLICY aws_money_write_gate_delete_tenant_bank_accounts ON public.tenant_bank_accounts
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_tenant_billing_accounts ON public.tenant_billing_accounts;
CREATE POLICY aws_money_write_gate_insert_tenant_billing_accounts ON public.tenant_billing_accounts
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_tenant_billing_accounts ON public.tenant_billing_accounts;
CREATE POLICY aws_money_write_gate_update_tenant_billing_accounts ON public.tenant_billing_accounts
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_tenant_billing_accounts ON public.tenant_billing_accounts;
CREATE POLICY aws_money_write_gate_delete_tenant_billing_accounts ON public.tenant_billing_accounts
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_tenant_credit_balances ON public.tenant_credit_balances;
CREATE POLICY aws_money_write_gate_insert_tenant_credit_balances ON public.tenant_credit_balances
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_tenant_credit_balances ON public.tenant_credit_balances;
CREATE POLICY aws_money_write_gate_update_tenant_credit_balances ON public.tenant_credit_balances
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_tenant_credit_balances ON public.tenant_credit_balances;
CREATE POLICY aws_money_write_gate_delete_tenant_credit_balances ON public.tenant_credit_balances
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_tenant_credit_transactions ON public.tenant_credit_transactions;
CREATE POLICY aws_money_write_gate_insert_tenant_credit_transactions ON public.tenant_credit_transactions
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_tenant_credit_transactions ON public.tenant_credit_transactions;
CREATE POLICY aws_money_write_gate_update_tenant_credit_transactions ON public.tenant_credit_transactions
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_tenant_credit_transactions ON public.tenant_credit_transactions;
CREATE POLICY aws_money_write_gate_delete_tenant_credit_transactions ON public.tenant_credit_transactions
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_tenant_maintenance_payments ON public.tenant_maintenance_payments;
CREATE POLICY aws_money_write_gate_insert_tenant_maintenance_payments ON public.tenant_maintenance_payments
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_tenant_maintenance_payments ON public.tenant_maintenance_payments;
CREATE POLICY aws_money_write_gate_update_tenant_maintenance_payments ON public.tenant_maintenance_payments
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_tenant_maintenance_payments ON public.tenant_maintenance_payments;
CREATE POLICY aws_money_write_gate_delete_tenant_maintenance_payments ON public.tenant_maintenance_payments
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());

DROP POLICY IF EXISTS aws_money_write_gate_insert_tenant_wallet_funding_settings ON public.tenant_wallet_funding_settings;
CREATE POLICY aws_money_write_gate_insert_tenant_wallet_funding_settings ON public.tenant_wallet_funding_settings
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_update_tenant_wallet_funding_settings ON public.tenant_wallet_funding_settings;
CREATE POLICY aws_money_write_gate_update_tenant_wallet_funding_settings ON public.tenant_wallet_funding_settings
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
DROP POLICY IF EXISTS aws_money_write_gate_delete_tenant_wallet_funding_settings ON public.tenant_wallet_funding_settings;
CREATE POLICY aws_money_write_gate_delete_tenant_wallet_funding_settings ON public.tenant_wallet_funding_settings
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.aws_money_write_allowed());
