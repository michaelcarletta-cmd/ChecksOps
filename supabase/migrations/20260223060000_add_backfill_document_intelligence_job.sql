-- Seed Darwin job type for Step 4 bulk document intelligence pass
INSERT INTO public.darwin_jobs (job_type, status)
VALUES ('backfill_document_intelligence', 'idle')
ON CONFLICT (job_type) DO NOTHING;

