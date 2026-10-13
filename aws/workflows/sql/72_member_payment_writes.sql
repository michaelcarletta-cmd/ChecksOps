-- Let any member of a tenant fund its Moov wallet and refresh its balance
-- through the API, without a platform admin/staff role.
--
-- The existing aws_write_payment_* policies require aws_can_write_tenant()
-- (platform admin/staff or cross-tenant reader). These additional permissive
-- policies allow a tenant member's writes only while the server's funding or
-- balance-refresh code has set both financial execution GUCs
-- (aws_financial_execution_active()). Browsers cannot set GUCs, so this opens
-- no direct browser write path. Cross-tenant readers and platform roles gain
-- nothing: the tenant must be one of the caller's own tenant_users tenants.
--
-- Writers: aws/functions/api/providers/production/moov-wallet-fund.mjs
--          aws/functions/api/providers/production/moov-wallet-sync.mjs

DROP POLICY IF EXISTS aws_member_insert_payment_transfers ON public.payment_transfers;
CREATE POLICY aws_member_insert_payment_transfers ON public.payment_transfers
  FOR INSERT TO authenticated
  WITH CHECK (
    public.aws_is_authenticated()
    AND COALESCE(public.aws_financial_execution_active(), false)
    AND tenant_id IN (SELECT public.aws_user_tenant_ids())
  );

DROP POLICY IF EXISTS aws_member_update_payment_transfers ON public.payment_transfers;
CREATE POLICY aws_member_update_payment_transfers ON public.payment_transfers
  FOR UPDATE TO authenticated
  USING (
    public.aws_is_authenticated()
    AND COALESCE(public.aws_financial_execution_active(), false)
    AND tenant_id IN (SELECT public.aws_user_tenant_ids())
  )
  WITH CHECK (
    public.aws_is_authenticated()
    AND COALESCE(public.aws_financial_execution_active(), false)
    AND tenant_id IN (SELECT public.aws_user_tenant_ids())
  );

DROP POLICY IF EXISTS aws_member_insert_payment_wallets ON public.payment_wallets;
CREATE POLICY aws_member_insert_payment_wallets ON public.payment_wallets
  FOR INSERT TO authenticated
  WITH CHECK (
    public.aws_is_authenticated()
    AND COALESCE(public.aws_financial_execution_active(), false)
    AND tenant_id IN (SELECT public.aws_user_tenant_ids())
  );

DROP POLICY IF EXISTS aws_member_update_payment_wallets ON public.payment_wallets;
CREATE POLICY aws_member_update_payment_wallets ON public.payment_wallets
  FOR UPDATE TO authenticated
  USING (
    public.aws_is_authenticated()
    AND COALESCE(public.aws_financial_execution_active(), false)
    AND tenant_id IN (SELECT public.aws_user_tenant_ids())
  )
  WITH CHECK (
    public.aws_is_authenticated()
    AND COALESCE(public.aws_financial_execution_active(), false)
    AND tenant_id IN (SELECT public.aws_user_tenant_ids())
  );

DROP POLICY IF EXISTS aws_member_insert_payment_event_log ON public.payment_event_log;
CREATE POLICY aws_member_insert_payment_event_log ON public.payment_event_log
  FOR INSERT TO authenticated
  WITH CHECK (
    public.aws_is_authenticated()
    AND COALESCE(public.aws_financial_execution_active(), false)
    AND tenant_id IN (SELECT public.aws_user_tenant_ids())
  );
