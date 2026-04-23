
-- Add permanent partner code to tenants
ALTER TABLE public.tenants ADD COLUMN partner_code TEXT UNIQUE;

-- Generate codes for existing tenants
CREATE OR REPLACE FUNCTION public.generate_partner_code()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  chars TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code TEXT := '';
  i INT;
BEGIN
  FOR i IN 1..8 LOOP
    code := code || substr(chars, floor(random() * length(chars) + 1)::int, 1);
  END LOOP;
  RETURN code;
END;
$$;

-- Set codes for existing tenants
UPDATE public.tenants SET partner_code = public.generate_partner_code() WHERE partner_code IS NULL;

-- Auto-generate for new tenants
CREATE OR REPLACE FUNCTION public.set_tenant_partner_code()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.partner_code IS NULL THEN
    NEW.partner_code := public.generate_partner_code();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tenant_partner_code
BEFORE INSERT ON public.tenants
FOR EACH ROW EXECUTE FUNCTION public.set_tenant_partner_code();

-- Banking info table
CREATE TABLE public.tenant_bank_accounts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  bank_name TEXT NOT NULL,
  account_holder_name TEXT NOT NULL,
  routing_number TEXT NOT NULL,
  account_number_last4 TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'checking',
  is_primary BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.tenant_bank_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members can view own bank accounts"
ON public.tenant_bank_accounts FOR SELECT
TO authenticated
USING (public.user_belongs_to_tenant(auth.uid(), tenant_id));

CREATE POLICY "Tenant members can manage own bank accounts"
ON public.tenant_bank_accounts FOR INSERT
TO authenticated
WITH CHECK (public.user_belongs_to_tenant(auth.uid(), tenant_id));

CREATE POLICY "Tenant members can update own bank accounts"
ON public.tenant_bank_accounts FOR UPDATE
TO authenticated
USING (public.user_belongs_to_tenant(auth.uid(), tenant_id));

CREATE POLICY "Tenant members can delete own bank accounts"
ON public.tenant_bank_accounts FOR DELETE
TO authenticated
USING (public.user_belongs_to_tenant(auth.uid(), tenant_id));
