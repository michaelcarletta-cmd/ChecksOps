
CREATE TABLE public.signature_document_presets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  description TEXT,
  fields JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id)
);

ALTER TABLE public.signature_document_presets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read presets"
ON public.signature_document_presets FOR SELECT
TO authenticated USING (true);

CREATE POLICY "Authenticated users can manage presets"
ON public.signature_document_presets FOR ALL
TO authenticated USING (true) WITH CHECK (true);

-- Seed with defaults
INSERT INTO public.signature_document_presets (document_type, label, description, fields) VALUES
('contract', 'Contract', 'Standard contract or agreement', '{
  "signature_1": {"display_label": "Owner Signature", "display_help_text": "Sign here to approve and authorize the contract terms.", "display_section": "Signatures", "display_order": 1},
  "signature_2": {"display_label": "Co-Owner / Authorized Representative Signature", "display_help_text": "If applicable, the co-owner or authorized representative should sign here.", "display_section": "Signatures", "display_order": 2},
  "text_1": {"display_label": "Owner Printed Name", "display_help_text": "Enter the full legal name of the person signing this agreement.", "display_section": "Identification", "display_order": 3},
  "text_2": {"display_label": "Co-Owner Printed Name", "display_help_text": "Enter the full legal name of the co-owner or authorized representative.", "display_section": "Identification", "display_order": 4},
  "date_1": {"display_label": "Date Signed", "display_help_text": "Enter the date this agreement was signed.", "display_section": "Signatures", "display_order": 5},
  "checkbox_1": {"display_label": "Initial Here", "display_help_text": "Check here to confirm you reviewed the authorization language.", "display_section": "Acknowledgements", "display_order": 6}
}'::jsonb),
('check_endorsement', 'Check Endorsement', 'Insurance check endorsement', '{
  "signature_1": {"display_label": "Payee Signature", "display_help_text": "Sign exactly as your name appears on the insurance check.", "display_section": "Endorsement", "display_order": 1},
  "signature_2": {"display_label": "Additional Payee Signature", "display_help_text": "If you are a named payee on the check, sign here.", "display_section": "Endorsement", "display_order": 2},
  "text_1": {"display_label": "Printed Name", "display_help_text": "Enter the printed name of the person endorsing the check.", "display_section": "Endorsement", "display_order": 3},
  "date_1": {"display_label": "Date Signed", "display_help_text": "Enter the date the check was endorsed.", "display_section": "Endorsement", "display_order": 4}
}'::jsonb),
('payment_authorization', 'Payment Authorization', 'Authorization for payment or disbursement', '{
  "signature_1": {"display_label": "Authorizing Signature", "display_help_text": "Sign here to authorize the payment described in this document.", "display_section": "Authorization", "display_order": 1},
  "text_1": {"display_label": "Authorized By (Printed Name)", "display_help_text": "Enter the full name of the person authorizing this payment.", "display_section": "Authorization", "display_order": 2},
  "date_1": {"display_label": "Date Authorized", "display_help_text": "Enter the date this payment was authorized.", "display_section": "Authorization", "display_order": 3}
}'::jsonb),
('work_authorization', 'Work Authorization', 'Authorization to begin work or repairs', '{
  "signature_1": {"display_label": "Property Owner Signature", "display_help_text": "Sign here to authorize the described work to begin on your property.", "display_section": "Authorization", "display_order": 1},
  "text_1": {"display_label": "Property Owner Printed Name", "display_help_text": "Enter the full legal name of the property owner.", "display_section": "Identification", "display_order": 2},
  "date_1": {"display_label": "Date Authorized", "display_help_text": "Enter the date the work was authorized to begin.", "display_section": "Authorization", "display_order": 3},
  "checkbox_1": {"display_label": "Acknowledgement", "display_help_text": "Check here to confirm you understand the scope of work described above.", "display_section": "Acknowledgements", "display_order": 4}
}'::jsonb),
('proof_of_loss', 'Proof of Loss', 'Sworn proof of loss statement', '{
  "signature_1": {"display_label": "Insured Signature", "display_help_text": "Sign here as the insured party under oath.", "display_section": "Sworn Statement", "display_order": 1},
  "text_1": {"display_label": "Insured Printed Name", "display_help_text": "Enter the full legal name of the insured.", "display_section": "Identification", "display_order": 2},
  "date_1": {"display_label": "Date Signed", "display_help_text": "Enter the date this proof of loss was signed.", "display_section": "Sworn Statement", "display_order": 3},
  "signature_2": {"display_label": "Notary Signature", "display_help_text": "Notary public signature and seal.", "display_section": "Notarization", "display_order": 4},
  "date_2": {"display_label": "Notarization Date", "display_help_text": "Date the document was notarized.", "display_section": "Notarization", "display_order": 5}
}'::jsonb),
('lien_waiver', 'Lien Waiver', 'Conditional or unconditional lien waiver', '{
  "signature_1": {"display_label": "Claimant Signature", "display_help_text": "Sign here to waive lien rights as described.", "display_section": "Waiver", "display_order": 1},
  "text_1": {"display_label": "Claimant Printed Name", "display_help_text": "Enter the full legal name of the claimant.", "display_section": "Identification", "display_order": 2},
  "date_1": {"display_label": "Date Signed", "display_help_text": "Enter the date this waiver was signed.", "display_section": "Waiver", "display_order": 3}
}'::jsonb);
