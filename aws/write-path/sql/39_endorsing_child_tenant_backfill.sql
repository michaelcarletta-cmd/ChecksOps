-- Idempotent child tenant_id backfill for check_payees and check_endorsements.
--
-- Copies parent check_intake_items.tenant_id onto child rows where:
--   child.tenant_id IS NULL
--   AND parent.tenant_id IS NOT NULL
--   AND parent row exists (JOIN, not LEFT JOIN).
--
-- Does not:
--   - change RLS / FORCE RLS / policies
--   - INSERT or DELETE payees or endorsements
--   - overwrite a non-NULL child tenant_id (mismatches are reported and abort)
--   - touch orphan children (no parent row)
--   - touch children whose parent tenant_id is NULL
--   - modify status, signatures, reminders, amounts, or parent check fields
--
-- Apply as table owner (checksops_admin), never as the application role.
-- This file does not COMMIT. Wrap it:
--   Dry-run (required before any apply): BEGIN; \i 39_...sql; ROLLBACK;
--   Apply (not this PR):                 BEGIN; \i 39_...sql; COMMIT;
--
-- Source-dump rehearsal (endorsement_audit_source, 2026-09-09):
--   payees_to_backfill=313, endorsements_to_backfill=181
--   payee_orphan=0, endorsement_orphan=0
--   payee_parent_null=0, endorsement_parent_null=0
--   payee_mismatch=0, endorsement_mismatch=0
-- Production AWS must be re-counted as owner before apply. Do not reuse
-- source-dump constants on RDS. Hidden Freedom Endorsing children were
-- inferred as 56 payees / 37 endorsements on 24 parent checks; global NULL
-- children on other stages are also eligible and are included.

DO $backfill$
DECLARE
  payee_mismatch int;
  endorsement_mismatch int;
  payee_orphan int;
  endorsement_orphan int;
  payee_parent_null int;
  endorsement_parent_null int;
  payee_plan int;
  endorsement_plan int;
  payee_updated int;
  endorsement_updated int;
  payee_rest_changed int;
  endorsement_rest_changed int;
  parent_changed int;
  hash_payee_before text;
  hash_payee_after text;
  hash_endorsement_before text;
  hash_endorsement_after text;
  hash_parent_before text;
  hash_parent_after text;
BEGIN
  IF current_setting('transaction_read_only') = 'on' THEN
    RAISE EXCEPTION 'refusing backfill: transaction is read-only';
  END IF;

  SELECT count(*) INTO payee_mismatch
  FROM public.check_payees p
  JOIN public.check_intake_items i ON i.id = p.check_id
  WHERE p.tenant_id IS NOT NULL
    AND i.tenant_id IS NOT NULL
    AND p.tenant_id IS DISTINCT FROM i.tenant_id;

  SELECT count(*) INTO endorsement_mismatch
  FROM public.check_endorsements e
  JOIN public.check_intake_items i ON i.id = e.check_id
  WHERE e.tenant_id IS NOT NULL
    AND i.tenant_id IS NOT NULL
    AND e.tenant_id IS DISTINCT FROM i.tenant_id;

  SELECT count(*) INTO payee_orphan
  FROM public.check_payees p
  LEFT JOIN public.check_intake_items i ON i.id = p.check_id
  WHERE p.tenant_id IS NULL AND i.id IS NULL;

  SELECT count(*) INTO endorsement_orphan
  FROM public.check_endorsements e
  LEFT JOIN public.check_intake_items i ON i.id = e.check_id
  WHERE e.tenant_id IS NULL AND i.id IS NULL;

  SELECT count(*) INTO payee_parent_null
  FROM public.check_payees p
  JOIN public.check_intake_items i ON i.id = p.check_id
  WHERE p.tenant_id IS NULL AND i.tenant_id IS NULL;

  SELECT count(*) INTO endorsement_parent_null
  FROM public.check_endorsements e
  JOIN public.check_intake_items i ON i.id = e.check_id
  WHERE e.tenant_id IS NULL AND i.tenant_id IS NULL;

  CREATE TEMP TABLE _backfill_payee_plan ON COMMIT DROP AS
  SELECT p.id AS child_id, i.tenant_id AS parent_tenant_id
  FROM public.check_payees p
  JOIN public.check_intake_items i ON i.id = p.check_id
  WHERE p.tenant_id IS NULL AND i.tenant_id IS NOT NULL;

  CREATE TEMP TABLE _backfill_endorsement_plan ON COMMIT DROP AS
  SELECT e.id AS child_id, i.tenant_id AS parent_tenant_id
  FROM public.check_endorsements e
  JOIN public.check_intake_items i ON i.id = e.check_id
  WHERE e.tenant_id IS NULL AND i.tenant_id IS NOT NULL;

  SELECT count(*) INTO payee_plan FROM _backfill_payee_plan;
  SELECT count(*) INTO endorsement_plan FROM _backfill_endorsement_plan;

  RAISE NOTICE 'endorsing_tenant_backfill plan payees=% endorsements=% orphans_payees=% orphans_endorsements=% parent_null_payees=% parent_null_endorsements=% mismatches_payees=% mismatches_endorsements=%',
    payee_plan, endorsement_plan, payee_orphan, endorsement_orphan,
    payee_parent_null, endorsement_parent_null, payee_mismatch, endorsement_mismatch;

  IF payee_mismatch <> 0 OR endorsement_mismatch <> 0 THEN
    RAISE EXCEPTION 'refusing backfill: tenant mismatch payees=% endorsements=% (reported only; not overwritten)',
      payee_mismatch, endorsement_mismatch;
  END IF;

  CREATE TEMP TABLE _payee_rest_before ON COMMIT DROP AS
  SELECT p.id, (to_jsonb(p) - 'tenant_id') AS rest
  FROM public.check_payees p
  WHERE p.id IN (SELECT child_id FROM _backfill_payee_plan);

  CREATE TEMP TABLE _endorsement_rest_before ON COMMIT DROP AS
  SELECT e.id, (to_jsonb(e) - 'tenant_id') AS rest
  FROM public.check_endorsements e
  WHERE e.id IN (SELECT child_id FROM _backfill_endorsement_plan);

  SELECT md5(coalesce(string_agg(concat_ws(E'\x1f',
    id::text,
    coalesce(endorsement_status, ''),
    coalesce(endorsed_at::text, ''),
    coalesce(endorsement_image_path, ''),
    check_id::text,
    coalesce(payee_name, ''),
    coalesce(payee_type, '')
  ), ',' ORDER BY id), ''))
  INTO hash_payee_before
  FROM public.check_payees;

  SELECT md5(coalesce(string_agg(concat_ws(E'\x1f',
    id::text,
    coalesce(status, ''),
    coalesce(signed_at::text, ''),
    coalesce(signature_image_url, ''),
    coalesce(reminder_count::text, ''),
    coalesce(last_reminder_at::text, ''),
    check_id::text,
    coalesce(payee_id::text, ''),
    coalesce(payee_name, ''),
    coalesce(payee_type, '')
  ), ',' ORDER BY id), ''))
  INTO hash_endorsement_before
  FROM public.check_endorsements;

  SELECT md5(coalesce(string_agg(concat_ws(E'\x1f',
    id::text,
    coalesce(tenant_id::text, ''),
    coalesce(check_number, ''),
    coalesce(amount::text, ''),
    coalesce(status, ''),
    coalesce(check_stage::text, ''),
    coalesce(payee_line, '')
  ), ',' ORDER BY id), ''))
  INTO hash_parent_before
  FROM public.check_intake_items;

  UPDATE public.check_payees p
  SET tenant_id = plan.parent_tenant_id
  FROM _backfill_payee_plan plan
  WHERE p.id = plan.child_id
    AND p.tenant_id IS NULL;
  GET DIAGNOSTICS payee_updated = ROW_COUNT;

  UPDATE public.check_endorsements e
  SET tenant_id = plan.parent_tenant_id
  FROM _backfill_endorsement_plan plan
  WHERE e.id = plan.child_id
    AND e.tenant_id IS NULL;
  GET DIAGNOSTICS endorsement_updated = ROW_COUNT;

  IF payee_updated <> payee_plan OR endorsement_updated <> endorsement_plan THEN
    RAISE EXCEPTION 'backfill rowcount mismatch payees %/% endorsements %/%',
      payee_updated, payee_plan, endorsement_updated, endorsement_plan;
  END IF;

  SELECT count(*) INTO payee_rest_changed
  FROM _payee_rest_before b
  JOIN public.check_payees p ON p.id = b.id
  WHERE (to_jsonb(p) - 'tenant_id') IS DISTINCT FROM b.rest;

  SELECT count(*) INTO endorsement_rest_changed
  FROM _endorsement_rest_before b
  JOIN public.check_endorsements e ON e.id = b.id
  WHERE (to_jsonb(e) - 'tenant_id') IS DISTINCT FROM b.rest;

  IF payee_rest_changed <> 0 OR endorsement_rest_changed <> 0 THEN
    RAISE EXCEPTION 'refusing: non-tenant columns changed payees=% endorsements=%',
      payee_rest_changed, endorsement_rest_changed;
  END IF;

  SELECT md5(coalesce(string_agg(concat_ws(E'\x1f',
    id::text,
    coalesce(endorsement_status, ''),
    coalesce(endorsed_at::text, ''),
    coalesce(endorsement_image_path, ''),
    check_id::text,
    coalesce(payee_name, ''),
    coalesce(payee_type, '')
  ), ',' ORDER BY id), ''))
  INTO hash_payee_after
  FROM public.check_payees;

  SELECT md5(coalesce(string_agg(concat_ws(E'\x1f',
    id::text,
    coalesce(status, ''),
    coalesce(signed_at::text, ''),
    coalesce(signature_image_url, ''),
    coalesce(reminder_count::text, ''),
    coalesce(last_reminder_at::text, ''),
    check_id::text,
    coalesce(payee_id::text, ''),
    coalesce(payee_name, ''),
    coalesce(payee_type, '')
  ), ',' ORDER BY id), ''))
  INTO hash_endorsement_after
  FROM public.check_endorsements;

  SELECT md5(coalesce(string_agg(concat_ws(E'\x1f',
    id::text,
    coalesce(tenant_id::text, ''),
    coalesce(check_number, ''),
    coalesce(amount::text, ''),
    coalesce(status, ''),
    coalesce(check_stage::text, ''),
    coalesce(payee_line, '')
  ), ',' ORDER BY id), ''))
  INTO hash_parent_after
  FROM public.check_intake_items;

  IF hash_payee_before IS DISTINCT FROM hash_payee_after THEN
    RAISE EXCEPTION 'payee protected-field hash changed';
  END IF;
  IF hash_endorsement_before IS DISTINCT FROM hash_endorsement_after THEN
    RAISE EXCEPTION 'endorsement protected-field hash changed';
  END IF;
  IF hash_parent_before IS DISTINCT FROM hash_parent_after THEN
    RAISE EXCEPTION 'parent check hash changed';
  END IF;

  SELECT count(*) INTO parent_changed
  FROM public.check_payees p
  JOIN _backfill_payee_plan plan ON plan.child_id = p.id
  WHERE p.tenant_id IS DISTINCT FROM plan.parent_tenant_id;
  IF parent_changed <> 0 THEN
    RAISE EXCEPTION 'payee tenant_id not equal to parent after backfill';
  END IF;

  SELECT count(*) INTO parent_changed
  FROM public.check_endorsements e
  JOIN _backfill_endorsement_plan plan ON plan.child_id = e.id
  WHERE e.tenant_id IS DISTINCT FROM plan.parent_tenant_id;
  IF parent_changed <> 0 THEN
    RAISE EXCEPTION 'endorsement tenant_id not equal to parent after backfill';
  END IF;

  RAISE NOTICE 'endorsing_tenant_backfill applied payees=% endorsements=% payee_hash=% endorsement_hash=% parent_hash=%',
    payee_updated, endorsement_updated, hash_payee_after, hash_endorsement_after, hash_parent_after;
END
$backfill$;
