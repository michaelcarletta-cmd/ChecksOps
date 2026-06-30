ALTER TABLE public.checkalt_deposits 
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS reject_code integer,
  ADD COLUMN IF NOT EXISTS reject_notes text;