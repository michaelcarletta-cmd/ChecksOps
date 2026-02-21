-- Allow tasks without a claim (personal tasks)
ALTER TABLE public.tasks ALTER COLUMN claim_id DROP NOT NULL;