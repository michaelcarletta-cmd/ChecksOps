
CREATE OR REPLACE FUNCTION public.auto_link_check_to_claim()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  normalized TEXT;
BEGIN
  IF NEW.claim_id IS NULL THEN
    IF NEW.freedom_claim_id IS NOT NULL THEN
      SELECT id INTO NEW.claim_id
      FROM public.claims
      WHERE id = NEW.freedom_claim_id
      LIMIT 1;
    END IF;

    IF NEW.claim_id IS NULL AND NEW.detected_claim_number IS NOT NULL THEN
      normalized := regexp_replace(upper(NEW.detected_claim_number), '[^A-Z0-9]', '', 'g');
      IF length(normalized) > 0 THEN
        SELECT id INTO NEW.claim_id
        FROM public.claims
        WHERE regexp_replace(upper(coalesce(claim_number,'')), '[^A-Z0-9]', '', 'g') = normalized
        LIMIT 1;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_link_check_to_claim ON public.check_intake_items;
CREATE TRIGGER trg_auto_link_check_to_claim
BEFORE INSERT OR UPDATE OF freedom_claim_id, detected_claim_number, claim_id
ON public.check_intake_items
FOR EACH ROW
EXECUTE FUNCTION public.auto_link_check_to_claim();

UPDATE public.check_intake_items ci
SET claim_id = c.id
FROM public.claims c
WHERE ci.claim_id IS NULL
  AND ci.freedom_claim_id IS NOT NULL
  AND c.id = ci.freedom_claim_id;

UPDATE public.check_intake_items ci
SET claim_id = c.id
FROM public.claims c
WHERE ci.claim_id IS NULL
  AND ci.detected_claim_number IS NOT NULL
  AND regexp_replace(upper(coalesce(c.claim_number,'')), '[^A-Z0-9]', '', 'g')
      = regexp_replace(upper(ci.detected_claim_number), '[^A-Z0-9]', '', 'g');
