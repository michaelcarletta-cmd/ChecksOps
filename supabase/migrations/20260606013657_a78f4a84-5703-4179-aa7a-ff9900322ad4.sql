
-- Per-check stakeholder whitelist
CREATE TABLE public.check_stakeholders (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  check_intake_item_id uuid NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  stakeholder_account_id uuid NOT NULL REFERENCES public.stakeholder_accounts(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  added_via text NOT NULL DEFAULT 'manual' CHECK (added_via IN ('manual','partner_share')),
  partner_tenant_id uuid REFERENCES public.tenants(id),
  added_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (check_intake_item_id, stakeholder_account_id)
);

CREATE INDEX idx_check_stakeholders_check ON public.check_stakeholders(check_intake_item_id);
CREATE INDEX idx_check_stakeholders_tenant ON public.check_stakeholders(tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.check_stakeholders TO authenticated;
GRANT ALL ON public.check_stakeholders TO service_role;

ALTER TABLE public.check_stakeholders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_check_stakeholders"
ON public.check_stakeholders
FOR ALL
TO authenticated
USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()))
WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));

CREATE TRIGGER trg_check_stakeholders_updated_at
BEFORE UPDATE ON public.check_stakeholders
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Auto-add partner stakeholder when a payment is sent to them
CREATE OR REPLACE FUNCTION public.auto_add_partner_stakeholder()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.recipient_stakeholder_account_id IS NOT NULL
     AND NEW.check_intake_item_id IS NOT NULL
     AND NEW.sender_tenant_id IS NOT NULL THEN
    INSERT INTO public.check_stakeholders (
      check_intake_item_id, stakeholder_account_id, tenant_id,
      added_via, partner_tenant_id, added_by
    ) VALUES (
      NEW.check_intake_item_id,
      NEW.recipient_stakeholder_account_id,
      NEW.sender_tenant_id,
      'partner_share',
      NEW.recipient_tenant_id,
      NEW.sender_user_id
    )
    ON CONFLICT (check_intake_item_id, stakeholder_account_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auto_add_partner_stakeholder
AFTER INSERT ON public.claim_check_payments
FOR EACH ROW EXECUTE FUNCTION public.auto_add_partner_stakeholder();
