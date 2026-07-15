ALTER TABLE public.mortgage_handling_requests
ADD COLUMN IF NOT EXISTS homeowner_ssn_last_four TEXT;

ALTER TABLE public.mortgage_handling_requests
DROP CONSTRAINT IF EXISTS mortgage_handling_requests_ssn_last_four_chk;

ALTER TABLE public.mortgage_handling_requests
ADD CONSTRAINT mortgage_handling_requests_ssn_last_four_chk
CHECK (homeowner_ssn_last_four IS NULL OR homeowner_ssn_last_four ~ '^[0-9]{4}$');