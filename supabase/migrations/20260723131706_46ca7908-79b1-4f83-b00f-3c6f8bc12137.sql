
-- Function: pull known payees & contact info from other checks on the same claim
CREATE OR REPLACE FUNCTION public.sync_claim_payees_to_check(p_check_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim_id uuid;
  v_tenant_id uuid;
BEGIN
  SELECT claim_id, tenant_id INTO v_claim_id, v_tenant_id
  FROM public.check_intake_items WHERE id = p_check_id;

  IF v_claim_id IS NULL THEN
    RETURN;
  END IF;

  -- 1) Back-fill missing contact info on existing payees for this check
  UPDATE public.check_payees tgt
  SET
    contact_email = COALESCE(tgt.contact_email, src.contact_email),
    contact_phone = COALESCE(tgt.contact_phone, src.contact_phone),
    updated_at = now()
  FROM (
    SELECT DISTINCT ON (lower(trim(cp.payee_name)))
      lower(trim(cp.payee_name)) AS name_key,
      cp.contact_email,
      cp.contact_phone
    FROM public.check_payees cp
    JOIN public.check_intake_items ci ON ci.id = cp.check_id
    WHERE ci.claim_id = v_claim_id
      AND ci.id <> p_check_id
      AND (cp.contact_email IS NOT NULL OR cp.contact_phone IS NOT NULL)
    ORDER BY lower(trim(cp.payee_name)), cp.updated_at DESC NULLS LAST
  ) src
  WHERE tgt.check_id = p_check_id
    AND lower(trim(tgt.payee_name)) = src.name_key
    AND (tgt.contact_email IS NULL OR tgt.contact_phone IS NULL);

  -- 2) Insert insured / mortgage_company / public_adjuster / contractor payees that
  --    exist on other checks in this claim but are missing on this check.
  --    (Contractors are copied so their email is preserved as a CC target, but
  --    the endorsement send path prevents them from receiving a signing link.)
  INSERT INTO public.check_payees (
    check_id, tenant_id, payee_name, payee_type, contact_email, contact_phone, endorsement_status
  )
  SELECT
    p_check_id,
    COALESCE(v_tenant_id, system_tenant_id()),
    src.payee_name,
    src.payee_type,
    src.contact_email,
    src.contact_phone,
    'pending'
  FROM (
    SELECT DISTINCT ON (lower(trim(cp.payee_name)))
      cp.payee_name,
      cp.payee_type,
      cp.contact_email,
      cp.contact_phone
    FROM public.check_payees cp
    JOIN public.check_intake_items ci ON ci.id = cp.check_id
    WHERE ci.claim_id = v_claim_id
      AND ci.id <> p_check_id
      AND cp.payee_type IN ('insured','mortgage_company','public_adjuster','contractor')
    ORDER BY lower(trim(cp.payee_name)), cp.updated_at DESC NULLS LAST
  ) src
  WHERE NOT EXISTS (
    SELECT 1 FROM public.check_payees existing
    WHERE existing.check_id = p_check_id
      AND lower(trim(existing.payee_name)) = lower(trim(src.payee_name))
  );
END;
$$;

-- Trigger on check_intake_items: run sync when claim_id becomes set / changes
CREATE OR REPLACE FUNCTION public.tg_sync_claim_payees_on_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.claim_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.claim_id IS DISTINCT FROM OLD.claim_id)
  THEN
    PERFORM public.sync_claim_payees_to_check(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_claim_payees_on_link ON public.check_intake_items;
CREATE TRIGGER trg_sync_claim_payees_on_link
AFTER INSERT OR UPDATE OF claim_id ON public.check_intake_items
FOR EACH ROW EXECUTE FUNCTION public.tg_sync_claim_payees_on_link();

-- Trigger on check_payees: back-fill contact from prior payees on same claim by name
CREATE OR REPLACE FUNCTION public.tg_hydrate_payee_contact_from_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim_id uuid;
  v_email text;
  v_phone text;
BEGIN
  IF NEW.contact_email IS NOT NULL AND NEW.contact_phone IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT claim_id INTO v_claim_id
  FROM public.check_intake_items WHERE id = NEW.check_id;

  IF v_claim_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT cp.contact_email, cp.contact_phone
    INTO v_email, v_phone
  FROM public.check_payees cp
  JOIN public.check_intake_items ci ON ci.id = cp.check_id
  WHERE ci.claim_id = v_claim_id
    AND cp.id <> NEW.id
    AND lower(trim(cp.payee_name)) = lower(trim(NEW.payee_name))
    AND (cp.contact_email IS NOT NULL OR cp.contact_phone IS NOT NULL)
  ORDER BY cp.updated_at DESC NULLS LAST
  LIMIT 1;

  IF v_email IS NOT NULL AND NEW.contact_email IS NULL THEN
    NEW.contact_email := v_email;
  END IF;
  IF v_phone IS NOT NULL AND NEW.contact_phone IS NULL THEN
    NEW.contact_phone := v_phone;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hydrate_payee_contact_from_claim ON public.check_payees;
CREATE TRIGGER trg_hydrate_payee_contact_from_claim
BEFORE INSERT ON public.check_payees
FOR EACH ROW EXECUTE FUNCTION public.tg_hydrate_payee_contact_from_claim();

-- Backfill across every existing check with a claim link
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT id FROM public.check_intake_items WHERE claim_id IS NOT NULL
  LOOP
    PERFORM public.sync_claim_payees_to_check(r.id);
  END LOOP;
END $$;
