-- Add metadata column to darwin_analysis_results for storing generation context
ALTER TABLE public.darwin_analysis_results
ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT NULL;