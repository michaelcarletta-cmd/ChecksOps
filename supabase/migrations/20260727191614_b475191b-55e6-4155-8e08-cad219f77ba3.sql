ALTER TABLE public.disbursement_splits
  ADD COLUMN IF NOT EXISTS rail text NOT NULL DEFAULT 'actum',
  ADD COLUMN IF NOT EXISTS plaid_authorization_id text,
  ADD COLUMN IF NOT EXISTS plaid_transfer_id text,
  ADD COLUMN IF NOT EXISTS plaid_transfer_status text,
  ADD COLUMN IF NOT EXISTS plaid_failure_reason text,
  ADD COLUMN IF NOT EXISTS plaid_sweep_status text;

ALTER TABLE public.disbursement_batches
  ADD COLUMN IF NOT EXISTS rail text NOT NULL DEFAULT 'actum';

CREATE INDEX IF NOT EXISTS idx_disbursement_splits_plaid_transfer_id
  ON public.disbursement_splits (plaid_transfer_id);

CREATE TABLE IF NOT EXISTS public.plaid_transfer_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id uuid,
  split_id uuid REFERENCES public.disbursement_splits(id) ON DELETE SET NULL,
  plaid_event_id bigint,
  plaid_transfer_id text,
  event_type text,
  transfer_status text,
  sweep_status text,
  failure_reason text,
  amount numeric,
  raw_payload jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_plaid_transfer_events_event_id
  ON public.plaid_transfer_events (plaid_event_id) WHERE plaid_event_id IS NOT NULL;

GRANT SELECT ON public.plaid_transfer_events TO authenticated;
GRANT ALL ON public.plaid_transfer_events TO service_role;
ALTER TABLE public.plaid_transfer_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members can view their plaid transfer events"
ON public.plaid_transfer_events FOR SELECT TO authenticated
USING (tenant_id IN (SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = auth.uid()));

CREATE TRIGGER set_plaid_transfer_events_updated_at
BEFORE UPDATE ON public.plaid_transfer_events
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.plaid_webhook_cursors (
  id text NOT NULL PRIMARY KEY,
  cursor_value bigint NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT ALL ON public.plaid_webhook_cursors TO service_role;
ALTER TABLE public.plaid_webhook_cursors ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER set_plaid_webhook_cursors_updated_at
BEFORE UPDATE ON public.plaid_webhook_cursors
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();