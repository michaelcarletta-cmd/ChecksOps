-- READ-ONLY diagnostic. UNAPPLIED. No INSERT/UPDATE/DELETE.
-- Does not treat missing claim_payments / claim_checks as missing Funds Received.
-- Funds Received on ClaimLedgerCard is SUM(check_intake_items.amount) by claim_id.
-- Existing-claim ownership is claims.org_id only.

WITH linked AS (
  SELECT ci.id, ci.claim_id, ci.tenant_id, ci.amount, ci.check_source
  FROM public.check_intake_items ci
  WHERE ci.claim_id IS NOT NULL
),
classified AS (
  SELECT
    l.id AS check_id,
    l.claim_id,
    l.tenant_id AS check_tenant_id,
    cl.org_id AS claim_org_id,
    EXISTS (SELECT 1 FROM public.claims c WHERE c.id = l.claim_id) AS claim_exists
  FROM linked l
  LEFT JOIN public.claims cl ON cl.id = l.claim_id
),
reasons AS (
  SELECT
    c.*,
    CASE
      WHEN NOT c.claim_exists THEN 'missing_claim'
      WHEN c.check_tenant_id IS NULL THEN 'missing_check_tenant'
      WHEN c.claim_org_id IS NULL THEN 'unassigned_claim'
      WHEN c.claim_org_id IS DISTINCT FROM c.check_tenant_id THEN 'cross_org'
      ELSE 'same_org'
    END AS reason
  FROM classified c
),
duplicate_received AS (
  SELECT check_id, COUNT(*) AS n
  FROM public.homeowner_ledger_events
  WHERE event_type = 'check_received'
    AND check_id IS NOT NULL
  GROUP BY check_id
  HAVING COUNT(*) > 1
),
missing_received AS (
  SELECT l.id
  FROM linked l
  WHERE COALESCE(l.check_source, 'insurance') = 'insurance'
    AND NOT EXISTS (
      SELECT 1 FROM public.homeowner_ledger_events hle
      WHERE hle.check_id = l.id
        AND hle.event_type = 'check_received'
    )
)
SELECT jsonb_build_object(
  'linked_checks', (SELECT COUNT(*) FROM linked),
  'legacy_null_org_claims', (
    SELECT COUNT(DISTINCT claim_id) FROM reasons WHERE claim_org_id IS NULL AND claim_exists
  ),
  'foreign_org_links', (SELECT COUNT(*) FROM reasons WHERE reason = 'cross_org'),
  'unassigned_claim_links', (SELECT COUNT(*) FROM reasons WHERE reason = 'unassigned_claim'),
  'duplicate_check_received_identities', (SELECT COUNT(*) FROM duplicate_received),
  'missing_homeowner_check_received', (SELECT COUNT(*) FROM missing_received),
  'anomalies', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'check_id', check_id,
      'claim_id', claim_id,
      'reason', reason,
      'claim_org_id', claim_org_id
    )), '[]'::jsonb)
    FROM reasons
    WHERE reason IN ('cross_org', 'unassigned_claim', 'missing_claim', 'missing_check_tenant')
  ),
  'duplicate_check_received', (SELECT COALESCE(jsonb_agg(duplicate_received), '[]'::jsonb) FROM duplicate_received),
  'missing_check_received_ids', (SELECT COALESCE(jsonb_agg(id), '[]'::jsonb) FROM missing_received),
  'funds_received_source', 'check_intake_items.amount where claim_id is set',
  'writes', 0
);
