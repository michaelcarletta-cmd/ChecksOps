DROP POLICY IF EXISTS "tenant_isolation_cash_jobs" ON public.cash_jobs;
DROP POLICY IF EXISTS "tenant_isolation_cash_job_payments" ON public.cash_job_payments;
DROP POLICY IF EXISTS "tenant_isolation_cash_job_line_items" ON public.cash_job_line_items;
DROP POLICY IF EXISTS "tenant_isolation_cash_job_attachments" ON public.cash_job_attachments;

CREATE POLICY "tenant_isolation_cash_jobs" ON public.cash_jobs
  FOR ALL USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));
CREATE POLICY "tenant_isolation_cash_job_payments" ON public.cash_job_payments
  FOR ALL USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));
CREATE POLICY "tenant_isolation_cash_job_line_items" ON public.cash_job_line_items
  FOR ALL USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));
CREATE POLICY "tenant_isolation_cash_job_attachments" ON public.cash_job_attachments
  FOR ALL USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));

CREATE OR REPLACE FUNCTION public.sync_cash_job_total_paid()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE public.cash_jobs
    SET total_paid = (
      SELECT COALESCE(SUM(amount), 0)
      FROM public.cash_job_payments
      WHERE cash_job_id = COALESCE(NEW.cash_job_id, OLD.cash_job_id)
    ), updated_at = now()
  WHERE id = COALESCE(NEW.cash_job_id, OLD.cash_job_id);
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_sync_cash_job_total_paid ON public.cash_job_payments;
CREATE TRIGGER trg_sync_cash_job_total_paid
  AFTER INSERT OR UPDATE OR DELETE ON public.cash_job_payments
  FOR EACH ROW EXECUTE FUNCTION public.sync_cash_job_total_paid();

CREATE OR REPLACE FUNCTION public.sync_cash_job_status()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE public.cash_jobs
    SET status = CASE
      WHEN NEW.total_paid <= 0 THEN 'estimate'
      WHEN NEW.total_paid >= NEW.contract_amount AND NEW.contract_amount > 0 THEN 'paid_in_full'
      WHEN NEW.total_paid > 0 AND NEW.total_paid < NEW.contract_amount * 0.5 THEN 'deposit_received'
      ELSE 'in_progress'
    END
  WHERE id = NEW.id AND status != 'cancelled';
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_sync_cash_job_status ON public.cash_jobs;
CREATE TRIGGER trg_sync_cash_job_status
  AFTER UPDATE OF total_paid ON public.cash_jobs
  FOR EACH ROW EXECUTE FUNCTION public.sync_cash_job_status();

CREATE INDEX IF NOT EXISTS idx_cash_jobs_tenant_id ON public.cash_jobs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cash_job_payments_job_id ON public.cash_job_payments(cash_job_id);
CREATE INDEX IF NOT EXISTS idx_cash_job_payments_tenant_id ON public.cash_job_payments(tenant_id);