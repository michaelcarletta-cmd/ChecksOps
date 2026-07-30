UPDATE public.disbursement_splits
SET amount = round(amount, 2)
WHERE amount IS NOT NULL
  AND amount <> round(amount, 2);

ALTER TABLE public.disbursement_splits
  ALTER COLUMN amount TYPE numeric(14, 2)
  USING round(amount, 2);