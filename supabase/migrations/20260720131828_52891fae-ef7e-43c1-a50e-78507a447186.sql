
WITH ranked AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY check_id, event_type, (floor(extract(epoch from occurred_at) / 900))::bigint
      ORDER BY occurred_at ASC
    ) AS rn
  FROM public.homeowner_ledger_events
  WHERE event_type IN ('endorsement_requested','endorsements_sent')
    AND check_id IS NOT NULL
)
DELETE FROM public.homeowner_ledger_events e
USING ranked r
WHERE e.id = r.id AND r.rn > 1;
