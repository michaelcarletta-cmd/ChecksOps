CREATE UNIQUE INDEX IF NOT EXISTS check_endorsements_unique_completed_payee
ON public.check_endorsements (
  check_id,
  lower(btrim(payee_name)),
  payee_type
)
WHERE status IN ('signed', 'waived');