
-- Credit balances per tenant
CREATE TABLE public.tenant_credit_balances (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE UNIQUE,
  balance INTEGER NOT NULL DEFAULT 0,
  has_payment_method BOOLEAN NOT NULL DEFAULT false,
  payment_method_type TEXT, -- 'card' or 'bank_account'
  payment_method_last4 TEXT,
  lifetime_purchased INTEGER NOT NULL DEFAULT 0,
  lifetime_used INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.tenant_credit_balances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members can view own credit balance"
ON public.tenant_credit_balances FOR SELECT
TO authenticated
USING (public.user_belongs_to_tenant(auth.uid(), tenant_id));

CREATE POLICY "Tenant members can update own credit balance"
ON public.tenant_credit_balances FOR UPDATE
TO authenticated
USING (public.user_belongs_to_tenant(auth.uid(), tenant_id));

CREATE POLICY "Tenant members can insert own credit balance"
ON public.tenant_credit_balances FOR INSERT
TO authenticated
WITH CHECK (public.user_belongs_to_tenant(auth.uid(), tenant_id));

-- Credit transaction log
CREATE TABLE public.tenant_credit_transactions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  transaction_type TEXT NOT NULL, -- 'purchase', 'deduction', 'refund', 'adjustment'
  amount INTEGER NOT NULL, -- positive for credits added, negative for credits used
  balance_after INTEGER NOT NULL,
  description TEXT,
  reference_id TEXT, -- check_id, payment_id, etc.
  reference_type TEXT, -- 'check_ocr', 'stripe_payment', 'manual', etc.
  created_by TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.tenant_credit_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members can view own credit transactions"
ON public.tenant_credit_transactions FOR SELECT
TO authenticated
USING (public.user_belongs_to_tenant(auth.uid(), tenant_id));

CREATE POLICY "Tenant members can insert own credit transactions"
ON public.tenant_credit_transactions FOR INSERT
TO authenticated
WITH CHECK (public.user_belongs_to_tenant(auth.uid(), tenant_id));

-- Atomic credit deduction function (used by edge functions)
CREATE OR REPLACE FUNCTION public.deduct_tenant_credits(
  p_tenant_id UUID,
  p_amount INTEGER,
  p_description TEXT DEFAULT 'Check processing',
  p_reference_id TEXT DEFAULT NULL,
  p_reference_type TEXT DEFAULT 'check_ocr'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_bal INTEGER;
  new_bal INTEGER;
BEGIN
  -- Lock the row for update
  SELECT balance INTO current_bal
  FROM tenant_credit_balances
  WHERE tenant_id = p_tenant_id
  FOR UPDATE;

  IF current_bal IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'no_balance_record', 'balance', 0);
  END IF;

  IF current_bal < p_amount THEN
    RETURN json_build_object('success', false, 'error', 'insufficient_credits', 'balance', current_bal);
  END IF;

  new_bal := current_bal - p_amount;

  UPDATE tenant_credit_balances
  SET balance = new_bal,
      lifetime_used = lifetime_used + p_amount,
      updated_at = now()
  WHERE tenant_id = p_tenant_id;

  INSERT INTO tenant_credit_transactions (
    tenant_id, transaction_type, amount, balance_after, description, reference_id, reference_type
  ) VALUES (
    p_tenant_id, 'deduction', -p_amount, new_bal, p_description, p_reference_id, p_reference_type
  );

  RETURN json_build_object('success', true, 'balance', new_bal);
END;
$$;

-- Initialize balances for existing tenants
INSERT INTO public.tenant_credit_balances (tenant_id, balance)
SELECT id, 0 FROM public.tenants
ON CONFLICT (tenant_id) DO NOTHING;

-- Auto-create balance row for new tenants
CREATE OR REPLACE FUNCTION public.init_tenant_credit_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.tenant_credit_balances (tenant_id, balance) VALUES (NEW.id, 0)
  ON CONFLICT (tenant_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_init_tenant_credits
AFTER INSERT ON public.tenants
FOR EACH ROW EXECUTE FUNCTION public.init_tenant_credit_balance();
