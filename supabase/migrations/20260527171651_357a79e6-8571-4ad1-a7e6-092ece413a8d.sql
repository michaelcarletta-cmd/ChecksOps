
ALTER TABLE public.check_intake_items
  ADD COLUMN IF NOT EXISTS deposited_at timestamptz,
  ADD COLUMN IF NOT EXISTS deposited_by_tenant_id uuid REFERENCES public.tenants(id);

CREATE INDEX IF NOT EXISTS idx_check_intake_items_deposited_at
  ON public.check_intake_items(deposited_at) WHERE deposited_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.tg_set_deposited_metadata()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deposited_states text[] := ARRAY['deposited','cleared','submitted_for_deposit','deposit_submitted'];
  v_user_tenants uuid[];
BEGIN
  IF NEW.status = ANY(v_deposited_states)
     AND (OLD.status IS NULL OR OLD.status <> NEW.status)
     AND NEW.deposited_at IS NULL
  THEN
    NEW.deposited_at := now();
    IF NEW.deposited_by_tenant_id IS NULL THEN
      BEGIN
        SELECT public.get_user_tenant_ids(auth.uid()) INTO v_user_tenants;
        IF v_user_tenants IS NOT NULL AND array_length(v_user_tenants, 1) >= 1 THEN
          NEW.deposited_by_tenant_id := v_user_tenants[1];
        ELSE
          NEW.deposited_by_tenant_id := NEW.tenant_id;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        NEW.deposited_by_tenant_id := NEW.tenant_id;
      END;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_deposited_metadata ON public.check_intake_items;
CREATE TRIGGER trg_set_deposited_metadata
  BEFORE UPDATE ON public.check_intake_items
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_set_deposited_metadata();
