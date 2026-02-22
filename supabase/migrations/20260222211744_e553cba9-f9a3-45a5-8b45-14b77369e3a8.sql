
CREATE TABLE public.darwin_jobs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  job_type text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'idle',
  started_at timestamptz,
  completed_at timestamptz,
  claimed_by text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.darwin_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read darwin_jobs"
  ON public.darwin_jobs FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Service role manages darwin_jobs"
  ON public.darwin_jobs FOR ALL
  USING (true)
  WITH CHECK (true);

-- Seed the two job types
INSERT INTO public.darwin_jobs (job_type, status) VALUES
  ('backfill_extracted_text', 'idle'),
  ('backfill_rebuild_events', 'idle');
