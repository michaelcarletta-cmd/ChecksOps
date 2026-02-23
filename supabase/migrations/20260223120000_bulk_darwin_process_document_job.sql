-- Add bulk_darwin_process_document job type for Step 4 of Darwin document pipeline
INSERT INTO public.darwin_jobs (job_type, status) VALUES
  ('bulk_darwin_process_document', 'idle')
ON CONFLICT (job_type) DO NOTHING;
