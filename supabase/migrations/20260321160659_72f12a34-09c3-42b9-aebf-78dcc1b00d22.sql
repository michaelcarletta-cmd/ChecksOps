
ALTER TABLE public.claim_statuses
ADD COLUMN IF NOT EXISTS gradient text DEFAULT NULL;

COMMENT ON COLUMN public.claim_statuses.gradient IS 'Optional CSS gradient string. When set, used instead of solid color for status badge backgrounds.';
