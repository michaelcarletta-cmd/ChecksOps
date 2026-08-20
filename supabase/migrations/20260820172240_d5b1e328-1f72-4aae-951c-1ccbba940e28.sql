ALTER TABLE public.tenants ALTER COLUMN stakeholder_cap SET DEFAULT 5;
UPDATE public.tenants SET stakeholder_cap = 5 WHERE stakeholder_cap IS NULL OR stakeholder_cap > 5;