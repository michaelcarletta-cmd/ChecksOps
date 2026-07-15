
CREATE TABLE IF NOT EXISTS public.loss_draft_mortgage_intake (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loss_draft_id UUID NOT NULL REFERENCES public.loss_draft_tracking(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES public.homeowner_intro_requests(id) ON DELETE SET NULL,
  loss_draft_document_id UUID REFERENCES public.loss_draft_documents(id) ON DELETE SET NULL,
  mortgage_servicer TEXT NOT NULL,
  loan_number TEXT,
  servicer_phone TEXT,
  borrower_names TEXT NOT NULL,
  mailing_address TEXT,
  ssn_last4 TEXT,
  notes TEXT,
  signer_name TEXT NOT NULL,
  signer_ip TEXT,
  signer_user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (loss_draft_id)
);

GRANT ALL ON public.loss_draft_mortgage_intake TO service_role;
GRANT SELECT ON public.loss_draft_mortgage_intake TO authenticated;

ALTER TABLE public.loss_draft_mortgage_intake ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view mortgage intake for their tenant loss drafts"
  ON public.loss_draft_mortgage_intake FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.loss_draft_tracking ldt
      JOIN public.check_intake_items ci ON ci.id = ldt.check_intake_item_id
      JOIN public.tenant_users tu ON tu.tenant_id = ci.tenant_id
      WHERE ldt.id = loss_draft_mortgage_intake.loss_draft_id
        AND tu.user_id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS idx_loss_draft_mortgage_intake_ld
  ON public.loss_draft_mortgage_intake(loss_draft_id);

CREATE TRIGGER trg_loss_draft_mortgage_intake_updated
  BEFORE UPDATE ON public.loss_draft_mortgage_intake
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.loss_draft_documents
  ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ;
