DROP POLICY IF EXISTS "tenant_isolation_stakeholder_accounts" ON public.stakeholder_accounts;
DROP POLICY IF EXISTS "tenant_isolation_reserve_config" ON public.reserve_config;
DROP POLICY IF EXISTS "tenant_isolation_disbursement_batches" ON public.disbursement_batches;
DROP POLICY IF EXISTS "tenant_isolation_disbursement_splits" ON public.disbursement_splits;
DROP POLICY IF EXISTS "tenant_isolation_actum_transactions" ON public.actum_transactions;

CREATE POLICY "tenant_isolation_stakeholder_accounts" ON public.stakeholder_accounts
  FOR ALL USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));

CREATE POLICY "tenant_isolation_reserve_config" ON public.reserve_config
  FOR ALL USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));

CREATE POLICY "tenant_isolation_disbursement_batches" ON public.disbursement_batches
  FOR ALL USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));

CREATE POLICY "tenant_isolation_disbursement_splits" ON public.disbursement_splits
  FOR ALL USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));

CREATE POLICY "tenant_isolation_actum_transactions" ON public.actum_transactions
  FOR ALL USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));