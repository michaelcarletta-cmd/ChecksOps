ALTER TABLE public.claim_loss_of_use_expenses 
ADD COLUMN IF NOT EXISTS is_paid boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS paid_date date;