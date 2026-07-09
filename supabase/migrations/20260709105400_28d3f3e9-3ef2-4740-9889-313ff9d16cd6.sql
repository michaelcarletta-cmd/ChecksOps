
-- ============================================================================
-- Contractor verification: hybrid auto + admin-approved tier system
-- ============================================================================

ALTER TABLE public.contractor_profiles
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS pro_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS pro_approved_by uuid,
  ADD COLUMN IF NOT EXISTS admin_disbursed_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_open_disputes boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verification_notes text;

-- ---------------------------------------------------------------------------
-- Status/eligibility function — returns a JSON checklist for one contractor
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.contractor_verification_status(p_contractor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile      public.contractor_profiles;
  v_w9           boolean := false;
  v_coi_ok       boolean := false;
  v_license_ok   boolean := false;
  v_review_count int := 0;
  v_avg_rating   numeric := 0;
  v_days         int := 0;
  v_eligible_verified boolean := false;
  v_eligible_pro      boolean := false;
BEGIN
  SELECT * INTO v_profile FROM public.contractor_profiles WHERE id = p_contractor_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.contractor_documents
    WHERE contractor_id = p_contractor_id AND document_type ILIKE '%w-9%' OR document_type ILIKE 'w9%'
  ) INTO v_w9;

  SELECT EXISTS (
    SELECT 1 FROM public.contractor_documents
    WHERE contractor_id = p_contractor_id
      AND (document_type ILIKE '%coi%' OR document_type ILIKE '%insurance%')
      AND (expiration_date IS NULL OR expiration_date >= CURRENT_DATE)
  ) INTO v_coi_ok;

  v_license_ok := v_profile.license_number IS NOT NULL AND length(trim(v_profile.license_number)) > 0;

  SELECT count(*), COALESCE(avg(rating), 0)
    INTO v_review_count, v_avg_rating
  FROM public.contractor_reviews
  WHERE contractor_id = p_contractor_id;

  v_days := GREATEST(0, EXTRACT(day FROM (now() - v_profile.created_at))::int);

  v_eligible_verified := v_w9 AND v_coi_ok AND v_license_ok;
  v_eligible_pro := v_eligible_verified
    AND v_profile.admin_disbursed_verified
    AND NOT v_profile.has_open_disputes
    AND v_review_count >= 5
    AND v_avg_rating >= 4.5
    AND v_days >= 90;

  RETURN jsonb_build_object(
    'found', true,
    'current_tier', v_profile.tier,
    'checks', jsonb_build_object(
      'w9_on_file', v_w9,
      'coi_current', v_coi_ok,
      'license_on_file', v_license_ok,
      'admin_payment_attested', v_profile.admin_disbursed_verified,
      'no_open_disputes', NOT v_profile.has_open_disputes,
      'review_count', v_review_count,
      'review_count_ok', v_review_count >= 5,
      'avg_rating', v_avg_rating,
      'avg_rating_ok', v_avg_rating >= 4.5,
      'days_on_platform', v_days,
      'days_on_platform_ok', v_days >= 90
    ),
    'eligible_verified', v_eligible_verified,
    'eligible_pro', v_eligible_pro,
    'verified_at', v_profile.verified_at,
    'pro_approved_at', v_profile.pro_approved_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.contractor_verification_status(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Recompute tier — auto Verified/Guest transitions; Pro is admin-only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recompute_contractor_tier(p_contractor_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status jsonb;
  v_tier   text;
  v_new_tier text;
  v_pro_still_ok boolean;
BEGIN
  v_status := public.contractor_verification_status(p_contractor_id);
  IF NOT COALESCE((v_status->>'found')::boolean, false) THEN
    RETURN;
  END IF;

  v_tier := v_status->>'current_tier';

  -- Determine target tier:
  --   Guest    → Verified if eligible_verified
  --   Verified → Guest if lost eligibility
  --   Pro      → Verified if pro criteria lost; stays Pro otherwise
  IF v_tier = 'pro' THEN
    v_pro_still_ok := COALESCE((v_status->>'eligible_pro')::boolean, false);
    IF v_pro_still_ok THEN
      v_new_tier := 'pro';
    ELSIF COALESCE((v_status->>'eligible_verified')::boolean, false) THEN
      v_new_tier := 'verified';
    ELSE
      v_new_tier := 'guest';
    END IF;
  ELSIF COALESCE((v_status->>'eligible_verified')::boolean, false) THEN
    v_new_tier := 'verified';
  ELSE
    v_new_tier := 'guest';
  END IF;

  IF v_new_tier <> COALESCE(v_tier, 'guest') THEN
    UPDATE public.contractor_profiles
       SET tier = v_new_tier,
           verified_at = CASE
             WHEN v_new_tier IN ('verified','pro') AND verified_at IS NULL THEN now()
             WHEN v_new_tier = 'guest' THEN NULL
             ELSE verified_at
           END,
           pro_approved_at = CASE WHEN v_new_tier <> 'pro' THEN NULL ELSE pro_approved_at END,
           pro_approved_by = CASE WHEN v_new_tier <> 'pro' THEN NULL ELSE pro_approved_by END,
           updated_at = now()
     WHERE id = p_contractor_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.recompute_contractor_tier(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Admin Pro approval / revocation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_contractor_pro(p_contractor_id uuid, p_approve boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status jsonb;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  IF p_approve THEN
    v_status := public.contractor_verification_status(p_contractor_id);
    IF NOT COALESCE((v_status->>'eligible_pro')::boolean, false) THEN
      RAISE EXCEPTION 'contractor_not_pro_eligible: %', v_status;
    END IF;
    UPDATE public.contractor_profiles
       SET tier = 'pro',
           pro_approved_at = now(),
           pro_approved_by = auth.uid(),
           verified_at = COALESCE(verified_at, now()),
           updated_at = now()
     WHERE id = p_contractor_id;
  ELSE
    UPDATE public.contractor_profiles
       SET pro_approved_at = NULL,
           pro_approved_by = NULL,
           updated_at = now()
     WHERE id = p_contractor_id;
    PERFORM public.recompute_contractor_tier(p_contractor_id);
  END IF;

  RETURN public.contractor_verification_status(p_contractor_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_set_contractor_pro(uuid, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Triggers to keep tier fresh
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._trg_recompute_contractor_tier_from_docs()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.recompute_contractor_tier(COALESCE(NEW.contractor_id, OLD.contractor_id));
  RETURN COALESCE(NEW, OLD);
END; $$;

DROP TRIGGER IF EXISTS recompute_tier_on_docs ON public.contractor_documents;
CREATE TRIGGER recompute_tier_on_docs
AFTER INSERT OR UPDATE OR DELETE ON public.contractor_documents
FOR EACH ROW EXECUTE FUNCTION public._trg_recompute_contractor_tier_from_docs();

CREATE OR REPLACE FUNCTION public._trg_recompute_contractor_tier_from_reviews()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.recompute_contractor_tier(COALESCE(NEW.contractor_id, OLD.contractor_id));
  RETURN COALESCE(NEW, OLD);
END; $$;

DROP TRIGGER IF EXISTS recompute_tier_on_reviews ON public.contractor_reviews;
CREATE TRIGGER recompute_tier_on_reviews
AFTER INSERT OR UPDATE OR DELETE ON public.contractor_reviews
FOR EACH ROW EXECUTE FUNCTION public._trg_recompute_contractor_tier_from_reviews();

CREATE OR REPLACE FUNCTION public._trg_recompute_contractor_tier_from_profile()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (NEW.license_number IS DISTINCT FROM OLD.license_number)
     OR (NEW.coi_expires_at IS DISTINCT FROM OLD.coi_expires_at)
     OR (NEW.admin_disbursed_verified IS DISTINCT FROM OLD.admin_disbursed_verified)
     OR (NEW.has_open_disputes IS DISTINCT FROM OLD.has_open_disputes)
  THEN
    PERFORM public.recompute_contractor_tier(NEW.id);
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS recompute_tier_on_profile ON public.contractor_profiles;
CREATE TRIGGER recompute_tier_on_profile
AFTER UPDATE ON public.contractor_profiles
FOR EACH ROW EXECUTE FUNCTION public._trg_recompute_contractor_tier_from_profile();
