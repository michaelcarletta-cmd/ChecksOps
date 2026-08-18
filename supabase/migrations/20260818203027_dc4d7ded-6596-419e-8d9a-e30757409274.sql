DELETE FROM public.disbursement_batches AS b
WHERE b.notes LIKE 'External check #%'
  AND b.created_at >= now() - interval '24 hours'
  AND NOT EXISTS (
    SELECT 1
    FROM public.disbursement_splits AS s
    WHERE s.batch_id = b.id
  );