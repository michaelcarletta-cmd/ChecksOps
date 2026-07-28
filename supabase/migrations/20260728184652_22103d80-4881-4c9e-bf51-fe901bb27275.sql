DELETE FROM public.check_endorsements e
WHERE e.check_id = '663b3c16-bd5f-4b2b-84be-b6da6d094985'
  AND e.status = 'pending'
  AND EXISTS (
    SELECT 1 FROM public.check_endorsements s
    WHERE s.check_id = e.check_id
      AND s.id <> e.id
      AND lower(btrim(s.payee_name)) = lower(btrim(e.payee_name))
      AND s.payee_type = e.payee_type
      AND s.status IN ('signed','waived')
  );

UPDATE public.check_payees p
SET endorsement_status = 'signed',
    endorsed_at = COALESCE(p.endorsed_at, e.signed_at)
FROM public.check_endorsements e
WHERE p.check_id = '663b3c16-bd5f-4b2b-84be-b6da6d094985'
  AND e.check_id = p.check_id
  AND lower(btrim(e.payee_name)) = lower(btrim(p.payee_name))
  AND e.status = 'signed'
  AND p.endorsement_status IS DISTINCT FROM 'signed';