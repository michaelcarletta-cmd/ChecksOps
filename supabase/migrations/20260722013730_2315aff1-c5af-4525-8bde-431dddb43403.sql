ALTER TABLE public.homeowner_ledger_events DROP CONSTRAINT IF EXISTS homeowner_ledger_events_event_type_check;
ALTER TABLE public.homeowner_ledger_events ADD CONSTRAINT homeowner_ledger_events_event_type_check CHECK (event_type = ANY (ARRAY[
  'check_received','endorsement_requested','endorsement_signed','endorsements_sent','ready_for_deposit','loss_draft_routing',
  'deposited','cleared','funds_released','production_projected','production_confirmed','production_doc_uploaded',
  'supplement_check','depreciation_check','deductible_check','homeowner_check_upload','homeowner_upload_attached',
  'document_sent','document_uploaded','document_signed_all','document_shared','document_delivered','document_viewed',
  'signature_reminder','mortgage_check_sent','mortgage_check_returned','mortgage_followup','mortgage_update',
  'contractor_upload','ops_note'
]));