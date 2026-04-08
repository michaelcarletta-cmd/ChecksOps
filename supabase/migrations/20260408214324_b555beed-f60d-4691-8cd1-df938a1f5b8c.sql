
-- Create claim_sub_statuses table
CREATE TABLE public.claim_sub_statuses (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  parent_status_id UUID NOT NULL REFERENCES public.claim_statuses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Add sub_status_id to claims
ALTER TABLE public.claims ADD COLUMN sub_status_id UUID REFERENCES public.claim_sub_statuses(id) ON DELETE SET NULL;

-- Enable RLS
ALTER TABLE public.claim_sub_statuses ENABLE ROW LEVEL SECURITY;

-- RLS policies - authenticated users can manage sub-statuses
CREATE POLICY "Authenticated users can view sub-statuses"
ON public.claim_sub_statuses FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can create sub-statuses"
ON public.claim_sub_statuses FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update sub-statuses"
ON public.claim_sub_statuses FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Authenticated users can delete sub-statuses"
ON public.claim_sub_statuses FOR DELETE TO authenticated USING (true);

-- Index for fast lookup by parent
CREATE INDEX idx_claim_sub_statuses_parent ON public.claim_sub_statuses(parent_status_id);

-- Index on claims for sub_status_id
CREATE INDEX idx_claims_sub_status ON public.claims(sub_status_id);
