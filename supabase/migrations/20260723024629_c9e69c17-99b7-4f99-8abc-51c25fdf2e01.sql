UPDATE public.disbursement_splits s
SET status = 'failed'
FROM public.disbursement_batches b
WHERE s.batch_id = b.id
  AND b.status IN ('failed','cancelled')
  AND s.status = 'pending';