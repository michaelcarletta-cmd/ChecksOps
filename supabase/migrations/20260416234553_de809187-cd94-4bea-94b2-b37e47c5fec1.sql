-- 1. Per-claim version counter (one row per claim)
CREATE TABLE public.claim_intelligence_version (
  claim_id UUID NOT NULL PRIMARY KEY REFERENCES public.claims(id) ON DELETE CASCADE,
  version INT NOT NULL DEFAULT 1,
  last_bumped_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Generic cache table
CREATE TABLE public.claim_intelligence_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  cache_type TEXT NOT NULL,
  subkey TEXT NOT NULL DEFAULT '',
  version INT NOT NULL DEFAULT 1,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_claim_intelligence_cache_dedupe
  ON public.claim_intelligence_cache(claim_id, cache_type, subkey);
CREATE INDEX idx_claim_intelligence_cache_lookup
  ON public.claim_intelligence_cache(claim_id, cache_type);

ALTER TABLE public.claim_intelligence_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_intelligence_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read intelligence version"
  ON public.claim_intelligence_version FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can read intelligence cache"
  ON public.claim_intelligence_cache FOR SELECT TO authenticated USING (true);

CREATE TRIGGER trg_claim_intelligence_version_updated
  BEFORE UPDATE ON public.claim_intelligence_version
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_claim_intelligence_cache_updated
  BEFORE UPDATE ON public.claim_intelligence_cache
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. Bump function
CREATE OR REPLACE FUNCTION public.bump_claim_intelligence_version(_claim_id UUID, _reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _claim_id IS NULL THEN RETURN; END IF;
  INSERT INTO public.claim_intelligence_version (claim_id, version, last_bumped_reason)
  VALUES (_claim_id, 1, _reason)
  ON CONFLICT (claim_id) DO UPDATE
    SET version = public.claim_intelligence_version.version + 1,
        last_bumped_reason = _reason,
        updated_at = now();
END;
$$;

-- 4a. New claim file uploaded
CREATE OR REPLACE FUNCTION public.trg_bump_on_claim_file()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.bump_claim_intelligence_version(NEW.claim_id, 'claim_file_inserted');
  RETURN NEW;
END;
$$;
CREATE TRIGGER bump_intel_on_claim_file
  AFTER INSERT ON public.claim_files
  FOR EACH ROW EXECUTE FUNCTION public.trg_bump_on_claim_file();

-- 4b. New dismantler result stored
CREATE OR REPLACE FUNCTION public.trg_bump_on_dismantler()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.bump_claim_intelligence_version(NEW.claim_id, 'dismantler_inserted');
  RETURN NEW;
END;
$$;
CREATE TRIGGER bump_intel_on_dismantler
  AFTER INSERT ON public.claim_document_dismantlers
  FOR EACH ROW EXECUTE FUNCTION public.trg_bump_on_dismantler();

-- 4c. New argument map entry
CREATE OR REPLACE FUNCTION public.trg_bump_on_argument_map()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.bump_claim_intelligence_version(NEW.claim_id, 'argument_map_inserted');
  RETURN NEW;
END;
$$;
CREATE TRIGGER bump_intel_on_argument_map
  AFTER INSERT ON public.claim_argument_map
  FOR EACH ROW EXECUTE FUNCTION public.trg_bump_on_argument_map();

-- 4d. Declared position created/updated
CREATE OR REPLACE FUNCTION public.trg_bump_on_declared_position()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.bump_claim_intelligence_version(NEW.claim_id, 'declared_position_changed');
  RETURN NEW;
END;
$$;
CREATE TRIGGER bump_intel_on_declared_position
  AFTER INSERT OR UPDATE ON public.darwin_declared_positions
  FOR EACH ROW EXECUTE FUNCTION public.trg_bump_on_declared_position();