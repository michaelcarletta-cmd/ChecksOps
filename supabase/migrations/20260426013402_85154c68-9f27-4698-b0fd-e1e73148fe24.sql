-- Add canonical link from loss_draft_tracking to the mortgage_companies directory
ALTER TABLE public.loss_draft_tracking
  ADD COLUMN IF NOT EXISTS mortgage_company_id uuid REFERENCES public.mortgage_companies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_loss_draft_mortgage_company
  ON public.loss_draft_tracking (mortgage_company_id)
  WHERE mortgage_company_id IS NOT NULL;

-- Helper: normalize company names for fuzzy matching (lowercase, strip punctuation,
-- drop common suffixes like LLC / Inc / Mortgage / Servicing / Bank / NA / Corporation)
CREATE OR REPLACE FUNCTION public.normalize_mortgage_company_name(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT NULLIF(
    btrim(
      regexp_replace(
        regexp_replace(
          regexp_replace(lower(coalesce(p_name, '')), '[[:punct:]]', ' ', 'g'),
          '\s+(llc|inc|corp|corporation|co|company|na|n a|mortgage|servicing|services|bank|financial|home loans|home mortgage|loan servicing|trust)\b',
          ' ', 'gi'
        ),
        '\s+', ' ', 'g'
      )
    ),
    ''
  );
$$;

-- Fast lookup index on normalized name
CREATE INDEX IF NOT EXISTS idx_mortgage_companies_normalized_name
  ON public.mortgage_companies (public.normalize_mortgage_company_name(name))
  WHERE is_active;

-- Auto-link trigger: when a loss_draft_tracking row is created or its servicer changes,
-- try to match an active directory entry by normalized name.
CREATE OR REPLACE FUNCTION public.auto_link_loss_draft_mortgage_company()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_norm text;
BEGIN
  -- Only act if not already linked, or servicer changed
  IF NEW.mortgage_company_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.mortgage_servicer = OLD.mortgage_servicer) THEN
    RETURN NEW;
  END IF;

  v_norm := public.normalize_mortgage_company_name(NEW.mortgage_servicer);
  IF v_norm IS NULL OR length(v_norm) = 0 THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_id
  FROM public.mortgage_companies
  WHERE is_active = true
    AND public.normalize_mortgage_company_name(name) = v_norm
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    NEW.mortgage_company_id := v_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_loss_draft_auto_link_company ON public.loss_draft_tracking;
CREATE TRIGGER trg_loss_draft_auto_link_company
  BEFORE INSERT OR UPDATE OF mortgage_servicer ON public.loss_draft_tracking
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_link_loss_draft_mortgage_company();

-- Backfill: link existing loss_draft_tracking rows to directory entries by normalized name
UPDATE public.loss_draft_tracking ldt
SET mortgage_company_id = mc.id
FROM public.mortgage_companies mc
WHERE ldt.mortgage_company_id IS NULL
  AND mc.is_active = true
  AND public.normalize_mortgage_company_name(ldt.mortgage_servicer)
      = public.normalize_mortgage_company_name(mc.name)
  AND public.normalize_mortgage_company_name(ldt.mortgage_servicer) IS NOT NULL;