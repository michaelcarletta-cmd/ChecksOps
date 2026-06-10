-- First, ensure there are no existing duplicates that would prevent creating the constraint
DELETE FROM public.loss_draft_documents a
USING public.loss_draft_documents b
WHERE a.id > b.id
  AND a.loss_draft_id = b.loss_draft_id
  AND a.document_type = b.document_type;

-- Add the unique constraint that was missing but required by ON CONFLICT specification
ALTER TABLE public.loss_draft_documents
ADD CONSTRAINT loss_draft_docs_unique_type UNIQUE (loss_draft_id, document_type);

-- Update the initialization function to be explicit about the conflict target
CREATE OR REPLACE FUNCTION public.init_loss_draft_documents(p_loss_draft_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 AS $$
BEGIN
  INSERT INTO public.loss_draft_documents (loss_draft_id, document_type, document_label, is_required)
  VALUES
    (p_loss_draft_id, 'endorsed_check', 'Endorsed Insurance Check', true),
    (p_loss_draft_id, 'contractor_estimate', 'Contractor Estimate / Scope of Work', true),
    (p_loss_draft_id, 'signed_contract', 'Signed Repair Contract', true),
    (p_loss_draft_id, 'w9', 'Contractor W-9', true),
    (p_loss_draft_id, 'certificate_completion', 'Certificate of Completion', true),
    (p_loss_draft_id, 'inspection_report', 'Lender Inspection Report', true),
    (p_loss_draft_id, 'photos_before', 'Before Photos', true),
    (p_loss_draft_id, 'photos_progress', 'Progress Photos', false),
    (p_loss_draft_id, 'photos_after', 'After / Completion Photos', true),
    (p_loss_draft_id, 'lien_waiver', 'Lien Waiver', false),
    (p_loss_draft_id, 'adjuster_report', 'Insurance Adjuster Report', false),
    (p_loss_draft_id, 'shipping_label', 'Shipping Label', false)
  ON CONFLICT (loss_draft_id, document_type) DO NOTHING;
END;
$$;