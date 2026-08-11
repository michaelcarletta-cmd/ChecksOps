CREATE TABLE IF NOT EXISTS public.wallet_funding_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  checkalt_deposit_id uuid REFERENCES public.checkalt_deposits(id) ON DELETE CASCADE,
  check_intake_item_id uuid,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  holdback_cents bigint NOT NULL DEFAULT 0 CHECK (holdback_cents >= 0),
  fund_cents bigint NOT NULL CHECK (fund_cents >= 0),
  wallet_type text NOT NULL DEFAULT 'operating',
  status text NOT NULL DEFAULT 'queued',
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  transfer_id uuid,
  funded_at timestamptz,
  trigger_source text NOT NULL DEFAULT 'checkalt_clear',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS wallet_funding_queue_deposit_uniq
  ON public.wallet_funding_queue(checkalt_deposit_id)
  WHERE checkalt_deposit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wallet_funding_queue_due_idx
  ON public.wallet_funding_queue(status, scheduled_for);

GRANT SELECT ON public.wallet_funding_queue TO authenticated;
GRANT ALL ON public.wallet_funding_queue TO service_role;
ALTER TABLE public.wallet_funding_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members can view their funding queue"
ON public.wallet_funding_queue FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin')
  OR EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.tenant_id = wallet_funding_queue.tenant_id
      AND tu.user_id = auth.uid()
  )
);

CREATE TRIGGER wallet_funding_queue_touch
BEFORE UPDATE ON public.wallet_funding_queue
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Enqueue a wallet top-up when CheckAlt reports a deposit cleared.
CREATE OR REPLACE FUNCTION public.enqueue_wallet_funding_on_clear()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled boolean;
  v_cushion numeric;
  v_holdback numeric;
  v_amount bigint;
  v_hold bigint;
BEGIN
  IF NEW.status <> 'cleared' OR COALESCE(OLD.status, '') = 'cleared' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE((setting_value)::text::boolean, false) INTO v_enabled
  FROM public.deposit_automation_settings WHERE setting_key = 'fund_on_clear_enabled';
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE((setting_value)::text::numeric, 1) INTO v_cushion
  FROM public.deposit_automation_settings WHERE setting_key = 'fund_on_clear_cushion_days';
  SELECT COALESCE((setting_value)::text::numeric, 0) INTO v_holdback
  FROM public.deposit_automation_settings WHERE setting_key = 'fund_on_clear_holdback_pct';

  v_amount := ROUND(COALESCE(NEW.amount, 0) * 100)::bigint;
  IF v_amount <= 0 THEN
    RETURN NEW;
  END IF;
  v_hold := FLOOR(v_amount * COALESCE(v_holdback, 0) / 100.0)::bigint;

  INSERT INTO public.wallet_funding_queue (
    tenant_id, checkalt_deposit_id, check_intake_item_id,
    amount_cents, holdback_cents, fund_cents, scheduled_for
  ) VALUES (
    NEW.tenant_id, NEW.id, NEW.check_intake_item_id,
    v_amount, v_hold, v_amount - v_hold,
    COALESCE(NEW.cleared_at, now()) + (COALESCE(v_cushion, 1) || ' days')::interval
  )
  ON CONFLICT (checkalt_deposit_id) WHERE checkalt_deposit_id IS NOT NULL DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS checkalt_deposits_fund_on_clear ON public.checkalt_deposits;
CREATE TRIGGER checkalt_deposits_fund_on_clear
AFTER UPDATE OF status ON public.checkalt_deposits
FOR EACH ROW EXECUTE FUNCTION public.enqueue_wallet_funding_on_clear();

INSERT INTO public.deposit_automation_settings (setting_key, setting_value, description) VALUES
  ('fund_on_clear_enabled', 'false'::jsonb, 'Automatically top up the Moov balance when a CheckAlt deposit clears'),
  ('fund_on_clear_cushion_days', '1'::jsonb, 'Days to wait after a deposit clears before pulling funds into the balance'),
  ('fund_on_clear_holdback_pct', '0'::jsonb, 'Percent of a cleared deposit held back from the automatic top-up')
ON CONFLICT (setting_key) DO NOTHING;