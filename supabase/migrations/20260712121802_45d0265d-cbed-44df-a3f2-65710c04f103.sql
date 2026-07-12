
ALTER TABLE public.homeowner_ledger_tokens
  ADD COLUMN IF NOT EXISTS partner_code text,
  ADD COLUMN IF NOT EXISTS sent_by_user_id uuid;

ALTER TABLE public.homeowner_ledger_check_uploads
  ADD COLUMN IF NOT EXISTS partner_code text,
  ADD COLUMN IF NOT EXISTS assigned_to_user_id uuid;

CREATE INDEX IF NOT EXISTS idx_hlcu_partner_code ON public.homeowner_ledger_check_uploads(tenant_id, partner_code);
CREATE INDEX IF NOT EXISTS idx_hlcu_assigned ON public.homeowner_ledger_check_uploads(assigned_to_user_id);
