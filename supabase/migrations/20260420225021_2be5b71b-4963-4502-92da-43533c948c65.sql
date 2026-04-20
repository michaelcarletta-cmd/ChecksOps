
INSERT INTO public.claim_operational_state (claim_id, lifecycle_stage, follow_up_status, days_since_last_activity, last_activity_at)
SELECT
  id,
  CASE
    WHEN status = 'new' THEN 'new'
    WHEN status = 'in_progress' THEN 'active'
    WHEN status = 'review' THEN 'review'
    WHEN status = 'negotiation' THEN 'negotiation'
    ELSE 'active'
  END,
  'due',
  GREATEST(0, EXTRACT(DAY FROM now() - COALESCE(updated_at, created_at))::int),
  COALESCE(updated_at, created_at)
FROM public.claims
WHERE status != 'closed'
ON CONFLICT (claim_id) DO NOTHING;
