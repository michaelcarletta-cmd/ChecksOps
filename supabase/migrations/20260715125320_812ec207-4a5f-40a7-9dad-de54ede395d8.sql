
ALTER TABLE public.loss_draft_documents
  ADD COLUMN IF NOT EXISTS signer_role text NOT NULL DEFAULT 'internal',
  ADD COLUMN IF NOT EXISTS requires_signature boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS signature_status text NOT NULL DEFAULT 'not_required';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'loss_draft_documents_signer_role_chk'
  ) THEN
    ALTER TABLE public.loss_draft_documents
      ADD CONSTRAINT loss_draft_documents_signer_role_chk
      CHECK (signer_role IN ('homeowner','contractor','internal'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_loss_draft_docs_signer_pending
  ON public.loss_draft_documents (loss_draft_id, signer_role)
  WHERE is_submitted = false;
