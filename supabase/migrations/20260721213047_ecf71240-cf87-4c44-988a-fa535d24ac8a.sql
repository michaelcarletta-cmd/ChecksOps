-- Phase 9: partial indexes to keep active queue fast and deposited pagination cheap
CREATE INDEX IF NOT EXISTS idx_cii_tenant_active_created_at
  ON public.check_intake_items (tenant_id, created_at DESC)
  WHERE check_stage IS DISTINCT FROM 'deposited';

CREATE INDEX IF NOT EXISTS idx_cii_tenant_deposited_at
  ON public.check_intake_items (tenant_id, deposited_at DESC NULLS LAST, updated_at DESC)
  WHERE check_stage = 'deposited';