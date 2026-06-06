ALTER TABLE public.stakeholder_accounts 
DROP CONSTRAINT IF EXISTS stakeholder_accounts_account_type_check;

ALTER TABLE public.stakeholder_accounts 
ADD CONSTRAINT stakeholder_accounts_account_type_check 
CHECK (account_type = ANY (ARRAY['operating'::text, 'vendor'::text, 'subcontractor'::text, 'overhead'::text, 'insured'::text, 'contractor'::text, 'supplier'::text, 'other'::text]));