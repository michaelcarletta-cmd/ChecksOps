
-- Table to store Darwin-generated assets (analyses, case studies, marketing, etc.)
CREATE TABLE public.generated_assets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  claim_id UUID REFERENCES public.claims(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content_md TEXT,
  redacted BOOLEAN DEFAULT false,
  created_by UUID,
  metadata_json JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for claim lookups
CREATE INDEX idx_generated_assets_claim_id ON public.generated_assets(claim_id);
CREATE INDEX idx_generated_assets_asset_type ON public.generated_assets(asset_type);

-- Enable RLS
ALTER TABLE public.generated_assets ENABLE ROW LEVEL SECURITY;

-- Staff/admin can read all assets
CREATE POLICY "Staff can view generated assets"
  ON public.generated_assets FOR SELECT
  USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

-- Staff/admin can insert
CREATE POLICY "Staff can create generated assets"
  ON public.generated_assets FOR INSERT
  WITH CHECK (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

-- Staff/admin can delete their own
CREATE POLICY "Staff can delete own generated assets"
  ON public.generated_assets FOR DELETE
  USING ((public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin')) AND created_by = auth.uid());

-- Service role (edge functions) bypasses RLS, so darwin-command will work

-- Updated_at trigger
CREATE TRIGGER update_generated_assets_updated_at
  BEFORE UPDATE ON public.generated_assets
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
