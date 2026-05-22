
-- Derive endorsements from payee_line for shared checks where the source app
-- did not push payees. Lets ChecksOps partners see required endorsements
-- immediately without waiting for the source app to sync.

CREATE OR REPLACE FUNCTION public.classify_payee_type(_name text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  n text := lower(coalesce(_name, ''));
BEGIN
  IF n ~ '(mortgage|loandepot|bank|credit union|isaoa|atima|loan servicing|phfa|fha|mr cooper|chase home|wells fargo home|rocket mortgage|nationstar|freedom mortgage|pennymac|carrington|lakeview|us bank home|truist|flagstar|caliber home|specialized loan|shellpoint|mr\.? cooper|fifth third|m&t|midfirst|new american funding|guild mortgage)' THEN
    RETURN 'mortgage_company';
  ELSIF n ~ '(adjustment|adjusters?|public adjuster|claims consult)' THEN
    RETURN 'public_adjuster';
  ELSIF n ~ '(construction|roofing|restoration|contractors?|builders?|exteriors?|remodel|services llc|services inc)' THEN
    RETURN 'contractor';
  ELSE
    RETURN 'insured';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.seed_endorsements_from_payee_line(_check_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_check record;
  v_line text;
  v_parts text[];
  v_part text;
  v_clean text;
  v_count integer := 0;
BEGIN
  SELECT id, tenant_id, payee_line
    INTO v_check
    FROM public.check_intake_items
    WHERE id = _check_id;

  IF NOT FOUND OR v_check.payee_line IS NULL OR length(trim(v_check.payee_line)) = 0 THEN
    RETURN 0;
  END IF;

  -- Don't overwrite existing endorsements
  IF EXISTS (SELECT 1 FROM public.check_endorsements WHERE check_id = _check_id) THEN
    RETURN 0;
  END IF;

  v_line := v_check.payee_line;

  -- Strip trailing street address fragments (very rough: drop anything after a 5-digit ZIP)
  v_line := regexp_replace(v_line, '\s+\d{1,6}\s+[A-Za-z0-9\s\.#]+(\d{5}).*$', '', 'i');

  -- Split on & or the standalone word AND/and (with surrounding whitespace)
  v_parts := regexp_split_to_array(v_line, '\s*&\s*|\s+AND\s+|\s+and\s+');

  FOREACH v_part IN ARRAY v_parts LOOP
    v_clean := trim(regexp_replace(v_part, '\s+', ' ', 'g'));
    -- Drop ISAOA/ATIMA suffix fragments that aren't real payees
    IF v_clean ~* '^(isaoa|atima|isaoa-atima|its successors)$' THEN
      CONTINUE;
    END IF;
    -- Trim trailing ISAOA-ATIMA from a mortgage payee name
    v_clean := regexp_replace(v_clean, '\s+ISAOA[-\s]?ATIMA.*$', '', 'i');
    v_clean := trim(v_clean);
    IF length(v_clean) < 2 THEN
      CONTINUE;
    END IF;

    INSERT INTO public.check_endorsements (
      check_id, tenant_id, payee_name, payee_type, status, signature_method
    ) VALUES (
      _check_id,
      v_check.tenant_id,
      v_clean,
      public.classify_payee_type(v_clean),
      'pending',
      'portal'
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- Trigger: when a shared/mirrored check is inserted or its payee_line
-- updated and no endorsements exist yet, auto-seed from the payee line.
CREATE OR REPLACE FUNCTION public.tg_auto_seed_endorsements()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.payee_line IS NULL OR length(trim(NEW.payee_line)) = 0 THEN
    RETURN NEW;
  END IF;
  -- Only auto-seed for mirrored (shared) checks from other apps to avoid
  -- duplicating the native endorsement workflow on locally uploaded checks.
  IF NEW.external_origin IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.check_endorsements WHERE check_id = NEW.id) THEN
    RETURN NEW;
  END IF;
  PERFORM public.seed_endorsements_from_payee_line(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_seed_endorsements_ins ON public.check_intake_items;
CREATE TRIGGER trg_auto_seed_endorsements_ins
AFTER INSERT ON public.check_intake_items
FOR EACH ROW EXECUTE FUNCTION public.tg_auto_seed_endorsements();

DROP TRIGGER IF EXISTS trg_auto_seed_endorsements_upd ON public.check_intake_items;
CREATE TRIGGER trg_auto_seed_endorsements_upd
AFTER UPDATE OF payee_line ON public.check_intake_items
FOR EACH ROW
WHEN (OLD.payee_line IS DISTINCT FROM NEW.payee_line)
EXECUTE FUNCTION public.tg_auto_seed_endorsements();

-- Backfill: every existing shared check from an external source that has no
-- endorsement rows yet.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT ci.id
    FROM public.check_intake_items ci
    WHERE ci.external_origin IS NOT NULL
      AND ci.payee_line IS NOT NULL
      AND length(trim(ci.payee_line)) > 0
      AND NOT EXISTS (SELECT 1 FROM public.check_endorsements e WHERE e.check_id = ci.id)
  LOOP
    PERFORM public.seed_endorsements_from_payee_line(r.id);
  END LOOP;
END $$;
