
ALTER TABLE public.homeowner_intro_requests
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz;

CREATE OR REPLACE FUNCTION public.homeowner_lead_set_accepted_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'accepted' AND (OLD.status IS DISTINCT FROM NEW.status) AND NEW.accepted_at IS NULL THEN
    NEW.accepted_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hir_set_accepted_at ON public.homeowner_intro_requests;
CREATE TRIGGER trg_hir_set_accepted_at
BEFORE UPDATE ON public.homeowner_intro_requests
FOR EACH ROW EXECUTE FUNCTION public.homeowner_lead_set_accepted_at();
