ALTER TABLE public.claim_expenses 
ADD COLUMN IF NOT EXISTS is_paid boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS paid_date date;