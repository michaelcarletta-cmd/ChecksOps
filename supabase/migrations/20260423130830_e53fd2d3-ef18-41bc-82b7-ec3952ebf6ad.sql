
-- Drop existing function/trigger if exists
DROP TRIGGER IF EXISTS trg_generate_partner_code ON public.tenants;
DROP FUNCTION IF EXISTS public.generate_partner_code();

-- Auto-generate partner_code for new tenants
CREATE FUNCTION public.generate_partner_code()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  new_code TEXT;
  code_exists BOOLEAN;
BEGIN
  IF NEW.partner_code IS NULL OR NEW.partner_code = '' THEN
    LOOP
      new_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
      SELECT EXISTS(SELECT 1 FROM tenants WHERE partner_code = new_code) INTO code_exists;
      EXIT WHEN NOT code_exists;
    END LOOP;
    NEW.partner_code := new_code;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_generate_partner_code
BEFORE INSERT ON public.tenants
FOR EACH ROW
EXECUTE FUNCTION public.generate_partner_code();

-- Backfill any tenants missing partner_code
DO $$
DECLARE
  t RECORD;
  new_code TEXT;
  code_exists BOOLEAN;
BEGIN
  FOR t IN SELECT id FROM tenants WHERE partner_code IS NULL OR partner_code = '' LOOP
    LOOP
      new_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
      SELECT EXISTS(SELECT 1 FROM tenants WHERE partner_code = new_code) INTO code_exists;
      EXIT WHEN NOT code_exists;
    END LOOP;
    UPDATE tenants SET partner_code = new_code WHERE id = t.id;
  END LOOP;
END;
$$;

-- Function to get partner tenant IDs for cross-tenant check visibility
CREATE OR REPLACE FUNCTION public.get_partner_tenant_ids(_tenant_id UUID)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT invitee_tenant_id FROM tenant_partnerships
  WHERE inviter_tenant_id = _tenant_id AND status = 'active' AND invitee_tenant_id IS NOT NULL
  UNION
  SELECT inviter_tenant_id FROM tenant_partnerships
  WHERE invitee_tenant_id = _tenant_id AND status = 'active';
$$;
