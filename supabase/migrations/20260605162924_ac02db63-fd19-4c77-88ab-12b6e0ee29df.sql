ALTER TABLE public.tenants 
ADD COLUMN per_check_billing_enabled BOOLEAN DEFAULT false,
ADD COLUMN per_check_rate_cents INTEGER DEFAULT 0;

ALTER TABLE public.check_billing_events 
ADD COLUMN event_type TEXT DEFAULT 'check_processing';

-- Update existing events
UPDATE public.check_billing_events SET event_type = 'check_processing' WHERE event_type IS NULL;

-- Add a comment for documentation
COMMENT ON COLUMN public.check_billing_events.event_type IS 'Type of billing event: check_processing, actum_same_day, or actum_instant';
