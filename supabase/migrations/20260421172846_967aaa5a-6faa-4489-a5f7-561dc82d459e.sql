
-- Recreate view with security invoker
DROP VIEW IF EXISTS public.claim_last_activity;
CREATE VIEW public.claim_last_activity 
WITH (security_invoker = true)
AS
SELECT 
  c.id AS claim_id,
  public.compute_claim_last_activity(c.id) AS last_activity_at,
  EXTRACT(DAY FROM (NOW() - public.compute_claim_last_activity(c.id)))::INT AS days_inactive
FROM claims c
WHERE c.status NOT IN ('Claim Settled', 'Dead File', 'Closed');
