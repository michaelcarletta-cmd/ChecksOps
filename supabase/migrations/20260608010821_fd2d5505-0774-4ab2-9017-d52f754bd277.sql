
CREATE OR REPLACE FUNCTION public.tg_auto_link_check_to_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  found_claim_id uuid;
  needle text;
BEGIN
  IF NEW.claim_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  needle := NULLIF(btrim(NEW.detected_claim_number), '');
  IF needle IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT c.id
    INTO found_claim_id
  FROM public.claims c
  WHERE lower(btrim(c.claim_number)) = lower(needle)
  ORDER BY c.created_at ASC
  LIMIT 1;

  IF found_claim_id IS NOT NULL THEN
    NEW.claim_id := found_claim_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_link_check_to_claim_ins ON public.check_intake_items;
CREATE TRIGGER trg_auto_link_check_to_claim_ins
  BEFORE INSERT ON public.check_intake_items
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_auto_link_check_to_claim();

DROP TRIGGER IF EXISTS trg_auto_link_check_to_claim_upd ON public.check_intake_items;
CREATE TRIGGER trg_auto_link_check_to_claim_upd
  BEFORE UPDATE OF detected_claim_number ON public.check_intake_items
  FOR EACH ROW
  WHEN (NEW.claim_id IS NULL AND NEW.detected_claim_number IS DISTINCT FROM OLD.detected_claim_number)
  EXECUTE FUNCTION public.tg_auto_link_check_to_claim();

-- Backfill: link existing unlinked checks whose detected_claim_number matches an existing claim
UPDATE public.check_intake_items ci
SET claim_id = c.id
FROM public.claims c
WHERE ci.claim_id IS NULL
  AND ci.detected_claim_number IS NOT NULL
  AND lower(btrim(ci.detected_claim_number)) = lower(btrim(c.claim_number));
