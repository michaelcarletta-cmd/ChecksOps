-- 40_collection_v2_synthetic_uat_cleanup.sql
-- SOURCE / TEST ONLY until a later authorized guarded SQL apply.
--
-- One-time staging cleanup of the accepted Collection V2 synthetic UAT fixture.
-- Exact IDs only. Fails closed unless every identifying invariant matches.
--
-- Authorized fixture:
--   harness  9ff1a038-2ea8-4d67-8082-74ffd2e79a7c
--   TMP      b0e70b5b-bbcb-4c74-a2a7-1b31aba8a9c1
--   xfer     ebcacb2b-c2c4-4763-bb34-63f72973290f
--   tenant   db13cc17-547b-4ca8-806a-f3cf79eafe59
--   marker   SYNTHETIC_UAT_COLLECTION_V2
--   events   60120c8f-5d83-4343-85f9-16bec592741e
--            1f832093-4d1b-43bd-829b-8fe34ccdbdb0
--
-- Does not GRANT / REVOKE.
-- Does not DISABLE / ENABLE / FORCE ROW LEVEL SECURITY.
-- Does not change SQL 39 policies.
-- Does not touch production.
-- Does not touch Freedom TMP 72b622f9-b68f-4032-a971-a854dbcfbf57
--   or transfer b31c7752-031f-4b8b-9b6e-82dd0aaed2cb.
-- Not a Supabase migration. No Supabase runtime/service dependency.
--
-- DELETE predicates always include the exact row IDs. This is not a
-- marker-only, tenant-only, or provider-transfer-only delete.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

DO $cleanup$
DECLARE
  auth_tmp constant uuid := 'b0e70b5b-bbcb-4c74-a2a7-1b31aba8a9c1';
  auth_tenant constant uuid := 'db13cc17-547b-4ca8-806a-f3cf79eafe59';
  auth_xfer constant text := 'ebcacb2b-c2c4-4763-bb34-63f72973290f';
  auth_harness constant text := '9ff1a038-2ea8-4d67-8082-74ffd2e79a7c';
  auth_marker constant text := 'SYNTHETIC_UAT_COLLECTION_V2';
  event_a constant uuid := '60120c8f-5d83-4343-85f9-16bec592741e';
  event_b constant uuid := '1f832093-4d1b-43bd-829b-8fe34ccdbdb0';
  forbidden_tenant constant uuid := '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
  forbidden_tmp constant uuid := '72b622f9-b68f-4032-a971-a854dbcfbf57';
  forbidden_xfer constant text := 'b31c7752-031f-4b8b-9b6e-82dd0aaed2cb';
  tmp_count int;
  event_count int;
  transfer_count int;
  tmp_tenant uuid;
  tmp_xfer text;
  tmp_amount int;
  tmp_env text;
  tmp_status text;
  tmp_notes text;
  deleted_events int;
  deleted_tmp int;
  tmp_left int;
  events_left int;
  transfers_left int;
BEGIN
  IF auth_tmp = forbidden_tmp
     OR auth_tenant = forbidden_tenant
     OR auth_xfer = forbidden_xfer
     OR event_a = forbidden_tmp
     OR event_b = forbidden_tmp THEN
    RAISE EXCEPTION 'SQL40_FORBIDDEN_ID_COLLISION';
  END IF;

  SELECT t.tenant_id, t.provider_transfer_id, t.amount_cents,
         t.provider_environment, t.status, t.notes
    INTO tmp_tenant, tmp_xfer, tmp_amount, tmp_env, tmp_status, tmp_notes
    FROM public.tenant_maintenance_payments t
   WHERE t.id = auth_tmp;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SQL40_TMP_MISSING';
  END IF;

  IF tmp_tenant = forbidden_tenant
     OR tmp_xfer = forbidden_xfer
     OR auth_tmp = forbidden_tmp
     OR position(forbidden_tmp::text in coalesce(tmp_notes, '')) > 0
     OR position(forbidden_xfer in coalesce(tmp_notes, '')) > 0
     OR position(forbidden_tenant::text in coalesce(tmp_notes, '')) > 0 THEN
    RAISE EXCEPTION 'SQL40_FORBIDDEN_TMP_REFERENCE';
  END IF;

  IF tmp_tenant IS DISTINCT FROM auth_tenant
     OR tmp_xfer IS DISTINCT FROM auth_xfer
     OR tmp_amount IS DISTINCT FROM 1
     OR tmp_env IS DISTINCT FROM 'sandbox'
     OR tmp_status IS DISTINCT FROM 'returned'
     OR tmp_notes IS NULL
     OR position(auth_marker in tmp_notes) = 0
     OR position('harness=' || auth_harness in tmp_notes) = 0 THEN
    RAISE EXCEPTION 'SQL40_TMP_MISMATCH: tenant=% xfer=% amount=% env=% status=%',
      tmp_tenant, tmp_xfer, tmp_amount, tmp_env, tmp_status;
  END IF;

  SELECT count(*)
    INTO tmp_count
    FROM public.tenant_maintenance_payments
   WHERE id = auth_tmp
     AND id <> forbidden_tmp
     AND tenant_id = auth_tenant
     AND tenant_id <> forbidden_tenant
     AND provider_transfer_id = auth_xfer
     AND provider_transfer_id <> forbidden_xfer
     AND amount_cents = 1
     AND provider_environment = 'sandbox'
     AND status = 'returned'
     AND notes LIKE '%' || auth_marker || '%'
     AND notes LIKE '%harness=' || auth_harness || '%';

  IF tmp_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'SQL40_TMP_COUNT: %', tmp_count;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.payment_event_log e
     WHERE e.id IN (event_a, event_b)
       AND (
         e.tenant_id = forbidden_tenant
         OR e.provider_transfer_id = forbidden_xfer
         OR e.id = forbidden_tmp
         OR coalesce(e.provider_metadata->>'checksops_payment_id', '') = forbidden_tmp::text
         OR coalesce(e.provider_metadata->>'harness_id', '') = forbidden_tmp::text
         OR coalesce(e.provider_metadata->>'checksops_payment_id', '') = forbidden_xfer
         OR coalesce(e.provider_metadata->>'harness_id', '') = forbidden_xfer
         OR coalesce(e.provider_metadata, '{}'::jsonb)::text LIKE '%' || forbidden_tenant::text || '%'
         OR coalesce(e.provider_metadata, '{}'::jsonb)::text LIKE '%' || forbidden_tmp::text || '%'
         OR coalesce(e.provider_metadata, '{}'::jsonb)::text LIKE '%' || forbidden_xfer || '%'
       )
  ) THEN
    RAISE EXCEPTION 'SQL40_FORBIDDEN_EVENT_REFERENCE';
  END IF;

  SELECT count(*)
    INTO event_count
    FROM public.payment_event_log e
   WHERE e.id IN (event_a, event_b)
     AND e.id <> forbidden_tmp
     AND e.provider_transfer_id = auth_xfer
     AND e.provider_transfer_id <> forbidden_xfer
     AND e.tenant_id = auth_tenant
     AND e.tenant_id <> forbidden_tenant
     AND coalesce(e.provider_metadata->>'synthetic_uat_marker', '') = auth_marker
     AND coalesce(e.provider_metadata->>'harness_id', '') = auth_harness
     AND coalesce(e.provider_metadata->>'checksops_payment_id', '') = auth_tmp::text;

  IF event_count IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'SQL40_EVENT_COUNT: %', event_count;
  END IF;

  IF (SELECT count(*) FROM public.payment_event_log WHERE id = event_a) <> 1
     OR (SELECT count(*) FROM public.payment_event_log WHERE id = event_b) <> 1 THEN
    RAISE EXCEPTION 'SQL40_EVENT_IDS_MISSING';
  END IF;

  SELECT count(*)
    INTO transfer_count
    FROM public.payment_transfers
   WHERE provider_transfer_id = auth_xfer
      OR coalesce(provider_metadata->>'obligation_id', '') = auth_tmp::text
      OR coalesce(provider_metadata->>'harness_id', '') = auth_harness
      OR coalesce(provider_metadata->>'checksops_payment_id', '') = auth_tmp::text;

  IF transfer_count IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'SQL40_PAYMENT_TRANSFER_PRESENT: %', transfer_count;
  END IF;

  DELETE FROM public.payment_event_log
   WHERE id IN (event_a, event_b)
     AND id <> forbidden_tmp
     AND provider_transfer_id = auth_xfer
     AND provider_transfer_id <> forbidden_xfer
     AND tenant_id = auth_tenant
     AND tenant_id <> forbidden_tenant
     AND provider_metadata->>'synthetic_uat_marker' = auth_marker
     AND provider_metadata->>'harness_id' = auth_harness
     AND provider_metadata->>'checksops_payment_id' = auth_tmp::text;

  GET DIAGNOSTICS deleted_events = ROW_COUNT;
  IF deleted_events IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'SQL40_EVENT_DELETE_COUNT: %', deleted_events;
  END IF;

  DELETE FROM public.tenant_maintenance_payments
   WHERE id = auth_tmp
     AND id <> forbidden_tmp
     AND tenant_id = auth_tenant
     AND tenant_id <> forbidden_tenant
     AND provider_transfer_id = auth_xfer
     AND provider_transfer_id <> forbidden_xfer
     AND amount_cents = 1
     AND provider_environment = 'sandbox'
     AND status = 'returned'
     AND notes LIKE '%' || auth_marker || '%'
     AND notes LIKE '%harness=' || auth_harness || '%';

  GET DIAGNOSTICS deleted_tmp = ROW_COUNT;
  IF deleted_tmp IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'SQL40_TMP_DELETE_COUNT: %', deleted_tmp;
  END IF;

  SELECT count(*)
    INTO tmp_left
    FROM public.tenant_maintenance_payments
   WHERE id = auth_tmp;

  SELECT count(*)
    INTO events_left
    FROM public.payment_event_log
   WHERE id IN (event_a, event_b);

  SELECT count(*)
    INTO transfers_left
    FROM public.payment_transfers
   WHERE provider_transfer_id = auth_xfer
      OR coalesce(provider_metadata->>'obligation_id', '') = auth_tmp::text
      OR coalesce(provider_metadata->>'harness_id', '') = auth_harness;

  IF tmp_left IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'SQL40_TMP_STILL_PRESENT: %', tmp_left;
  END IF;
  IF events_left IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'SQL40_EVENTS_STILL_PRESENT: %', events_left;
  END IF;
  IF transfers_left IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'SQL40_PAYMENT_TRANSFER_PRESENT_AFTER: %', transfers_left;
  END IF;
END
$cleanup$;

COMMIT;
