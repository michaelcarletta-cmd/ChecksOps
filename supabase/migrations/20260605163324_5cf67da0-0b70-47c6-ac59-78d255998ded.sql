ALTER TABLE public.check_billing_events 
ADD COLUMN disbursement_split_id UUID REFERENCES public.disbursement_splits(id) ON DELETE CASCADE;

ALTER TABLE public.check_billing_events DROP CONSTRAINT check_billing_events_unique_check;

-- New unique constraint: processing events are unique per check, but actum events are unique per split
CREATE UNIQUE INDEX idx_unique_processing_event ON public.check_billing_events (check_intake_item_id) WHERE event_type = 'check_processing';
CREATE UNIQUE INDEX idx_unique_actum_event ON public.check_billing_events (disbursement_split_id) WHERE event_type IN ('actum_same_day', 'actum_instant');
