
-- Add automation_mode enum
CREATE TYPE public.automation_mode AS ENUM ('active', 'passive', 'suspended', 'closed');

-- Add columns to claims table
ALTER TABLE public.claims
  ADD COLUMN automation_mode public.automation_mode NOT NULL DEFAULT 'active',
  ADD COLUMN automation_resume_at timestamptz;

-- Index for autopilot queries
CREATE INDEX idx_claims_automation_mode ON public.claims (automation_mode) WHERE automation_mode != 'closed';
