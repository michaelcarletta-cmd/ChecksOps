-- READ-ONLY ledger backfill inspect.
-- UNAPPLIED. Do not wrap in a write transaction. No INSERT/UPDATE/DELETE.
-- Discovers current state at execution time. Do not hardcode preflight counts.

WITH linked AS (
  SELECT
    ci.id,
    ci.claim_id,
    ci.tenant_id,
    ci.amount,
    ci.check_number,
    ci.carrier_name,
    ci.issue_date,
    ci.payee_line,
    ci.created_at
  FROM public.check_intake_items ci
  WHERE ci.claim_id IS NOT NULL
),
claim_tenants AS (
  SELECT
    l.id AS check_id,
    l.claim_id,
    l.tenant_id AS check_tenant_id,
    ARRAY(
      SELECT DISTINCT x.tenant_id
      FROM (
        SELECT other.tenant_id
        FROM public.check_intake_items other
        WHERE other.claim_id = l.claim_id
          AND other.tenant_id IS NOT NULL
          AND other.id IS DISTINCT FROM l.id
        UNION
        SELECT cc.tenant_id
        FROM public.check_cases cc
        WHERE cc.external_claim_id = l.claim_id
          AND cc.tenant_id IS NOT NULL
        UNION
        SELECT cl.org_id
        FROM public.claims cl
        WHERE cl.id = l.claim_id
          AND cl.org_id IS NOT NULL
        UNION
        SELECT hle.tenant_id
        FROM public.homeowner_ledger_events hle
        WHERE hle.claim_id = l.claim_id
          AND hle.tenant_id IS NOT NULL
        UNION
        SELECT intake.tenant_id
        FROM public.claim_checks chk
        JOIN public.check_intake_items intake ON intake.id = chk.check_intake_item_id
        WHERE chk.claim_id = l.claim_id
          AND intake.tenant_id IS NOT NULL
          AND intake.id IS DISTINCT FROM l.id
        UNION
        SELECT intake.tenant_id
        FROM public.claim_payments cp
        JOIN public.check_intake_items intake ON intake.id = cp.check_intake_item_id
        WHERE cp.claim_id = l.claim_id
          AND intake.tenant_id IS NOT NULL
          AND intake.id IS DISTINCT FROM l.id
      ) x
      WHERE x.tenant_id IS NOT NULL
    ) AS claim_tenant_ids,
    EXISTS (SELECT 1 FROM public.claims c WHERE c.id = l.claim_id) AS claim_exists
  FROM linked l
),
classified AS (
  SELECT
    ct.*,
    CASE
      WHEN NOT ct.claim_exists THEN 'missing_claim'
      WHEN ct.check_tenant_id IS NULL THEN 'missing_check_tenant'
      WHEN COALESCE(array_length(ct.claim_tenant_ids, 1), 0) = 0 THEN 'first_link'
      WHEN COALESCE(array_length(ct.claim_tenant_ids, 1), 0) > 1 THEN 'conflicting_claim_tenants'
      WHEN ct.claim_tenant_ids[1] IS DISTINCT FROM ct.check_tenant_id THEN 'cross_tenant'
      ELSE 'same_tenant'
    END AS ownership_reason
  FROM claim_tenants ct
),
missing_claim_checks AS (
  SELECT l.id
  FROM linked l
  WHERE NOT EXISTS (
    SELECT 1 FROM public.claim_checks chk
    WHERE chk.check_intake_item_id = l.id
  )
),
missing_claim_payments AS (
  SELECT l.id
  FROM linked l
  WHERE l.amount IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.claim_payments cp
      WHERE cp.check_intake_item_id = l.id
    )
),
missing_check_received AS (
  SELECT l.id
  FROM linked l
  WHERE NOT EXISTS (
    SELECT 1 FROM public.homeowner_ledger_events hle
    WHERE hle.check_id = l.id
      AND hle.event_type = 'check_received'
  )
),
mismatched AS (
  SELECT l.id AS check_id, 'claim_checks'::text AS table_name, chk.claim_id AS existing_claim_id, l.claim_id AS expected_claim_id
  FROM linked l
  JOIN public.claim_checks chk ON chk.check_intake_item_id = l.id
  WHERE chk.claim_id IS DISTINCT FROM l.claim_id
  UNION ALL
  SELECT l.id, 'claim_payments', cp.claim_id, l.claim_id
  FROM linked l
  JOIN public.claim_payments cp ON cp.check_intake_item_id = l.id
  WHERE cp.claim_id IS DISTINCT FROM l.claim_id
),
duplicate_payments AS (
  SELECT check_intake_item_id, COUNT(*) AS n
  FROM public.claim_payments
  WHERE check_intake_item_id IS NOT NULL
  GROUP BY check_intake_item_id
  HAVING COUNT(*) > 1
),
duplicate_received AS (
  SELECT check_id, COUNT(*) AS n
  FROM public.homeowner_ledger_events
  WHERE event_type = 'check_received'
    AND check_id IS NOT NULL
  GROUP BY check_id
  HAVING COUNT(*) > 1
)
SELECT jsonb_build_object(
  'eligible_linked_checks', (SELECT COUNT(*) FROM linked),
  'missing_claim_checks', (SELECT COUNT(*) FROM missing_claim_checks),
  'missing_claim_payments', (SELECT COUNT(*) FROM missing_claim_payments),
  'missing_check_received', (SELECT COUNT(*) FROM missing_check_received),
  'mismatched_claim_ids', (SELECT COUNT(*) FROM mismatched),
  'cross_tenant_anomalies', (
    SELECT COUNT(*) FROM classified
    WHERE ownership_reason IN ('cross_tenant', 'conflicting_claim_tenants', 'missing_claim', 'missing_check_tenant')
  ),
  'duplicate_payment_identities', (SELECT COUNT(*) FROM duplicate_payments),
  'duplicate_check_received_identities', (SELECT COUNT(*) FROM duplicate_received),
  'missing_claim_check_ids', (SELECT COALESCE(jsonb_agg(id), '[]'::jsonb) FROM missing_claim_checks),
  'missing_claim_payment_ids', (SELECT COALESCE(jsonb_agg(id), '[]'::jsonb) FROM missing_claim_payments),
  'missing_check_received_ids', (SELECT COALESCE(jsonb_agg(id), '[]'::jsonb) FROM missing_check_received),
  'mismatches', (SELECT COALESCE(jsonb_agg(mismatched), '[]'::jsonb) FROM mismatched),
  'anomalies', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'check_id', check_id,
      'claim_id', claim_id,
      'reason', ownership_reason,
      'claim_tenant_ids', claim_tenant_ids
    )), '[]'::jsonb)
    FROM classified
    WHERE ownership_reason IN ('cross_tenant', 'conflicting_claim_tenants', 'missing_claim', 'missing_check_tenant')
  ),
  'duplicate_payments', (SELECT COALESCE(jsonb_agg(duplicate_payments), '[]'::jsonb) FROM duplicate_payments),
  'duplicate_check_received', (SELECT COALESCE(jsonb_agg(duplicate_received), '[]'::jsonb) FROM duplicate_received),
  'writes', 0
);
