-- Drop ALL existing signatures of ocr_commit_results to resolve parameter default conflicts
DROP FUNCTION IF EXISTS public.ocr_commit_results(uuid,text,text,numeric,text,text,text,boolean,jsonb,text,text,jsonb,text,jsonb,jsonb,uuid,uuid);
DROP FUNCTION IF EXISTS public.ocr_commit_results(uuid,text,text,numeric,text,text,text,boolean,jsonb,text,text,jsonb,text,jsonb,jsonb,uuid,uuid,boolean);