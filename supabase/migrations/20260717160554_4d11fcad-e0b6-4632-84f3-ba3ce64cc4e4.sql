
-- Make init a no-op so new loss drafts start empty
CREATE OR REPLACE FUNCTION public.init_loss_draft_documents(p_loss_draft_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  -- Intentionally no-op: users now build the docs list on demand via the UI.
  RETURN;
END;
$$;

-- Add tracking columns
ALTER TABLE public.loss_draft_documents
  ADD COLUMN IF NOT EXISTS signature_request_id uuid REFERENCES public.signature_requests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_template_generated boolean NOT NULL DEFAULT false;

-- Allow mortgage agents to manage loss draft docs (for the mortgage ops portal)
CREATE POLICY "Mortgage agents can manage loss draft documents"
  ON public.loss_draft_documents
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'mortgage_agent'))
  WITH CHECK (public.has_role(auth.uid(), 'mortgage_agent'));
