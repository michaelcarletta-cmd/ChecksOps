-- SQL 169: deleting a check keeps its ChecksOps charges; the charge is unlinked from the deleted check, not deleted.
-- AWS only: nothing under supabase/migrations changes.
--
-- Why (owner 2026-11-16): two checks could not be deleted; the API refused with "This check cannot be deleted because
-- it has dependent financial/provider records (check_billing_events)". Asked what a delete of a check that has a charge
-- should do, the owner chose "Delete, keep charge (Recommended)": the check is removed, its charge stays in billing
-- history, unlinked from the deleted check. Today the delete-check API (aws/functions/api/workflow-delete-check.mjs
-- FINANCIAL_DELETE_BLOCKERS, aws/functions/api/workflow.mjs) refuses any check with a check_billing_events row, and the
-- database could not keep the row anyway: public.check_billing_events.check_intake_item_id references
-- public.check_intake_items(id) ON DELETE CASCADE (supabase/migrations/20260501204336_0cf22f8b-4276-451b-a50c-69a58bbdb5a1.sql,
-- the inline REFERENCES, so the constraint is named check_billing_events_check_intake_item_id_fkey), so deleting the
-- check would delete its charges with it.
--
-- What this file does: replaces that foreign key with the same key ON DELETE SET NULL, under the same name. A deleted
-- check's charges stay, with check_intake_item_id NULL and every other column unchanged (tenant_id, claim_id, amounts,
-- event_type, status, payment_transfer_id, source_kind/source_id). The API change that lets such a check be deleted is a
-- separate, later step (a Lambda overlay of the delete-check code); until it ships the API still refuses, so this file
-- alone changes no behaviour a user can reach.
--
-- Accepted predecessor: exactly one foreign key on public.check_billing_events (check_intake_item_id) and it is
-- check_billing_events_check_intake_item_id_fkey, FOREIGN KEY (check_intake_item_id) REFERENCES
-- public.check_intake_items(id) ON DELETE CASCADE. Refuses (55000):
--   sql169_prerequisite_missing     the tables or columns are missing;
--   sql169_column_not_nullable      check_billing_events.check_intake_item_id is NOT NULL (Supabase dropped NOT NULL in
--                                   20260605163443; a database that still has it is not the one this file was written
--                                   for, and dropping it is not this file's change);
--   sql169_unexpected_foreign_key   no such key, more than one, another name, or another definition.
-- Idempotent: when the key is already exactly the SET NULL one it is left as it is
-- (sql169_foreign_key_already_current).
--
-- Safe for the rows the key unlinks: the delete's SET NULL is an UPDATE of check_intake_item_id only, run by the
-- foreign key as the owner of check_billing_events. No CHECK constraint requires the column; the unique indexes that
-- include it (SQL 84 one_mortgage_ops_per_check, SQL 98 check_event_uidx, SQL 153 one_second_mortgagee_per_check) treat
-- NULL as distinct or are partial on IS NOT NULL; SQL 154's aws_check_billing_event_starter_package trigger fires on
-- INSERT or UPDATE OF status only; the updated_at trigger (where present) stamps updated_at. The billing engine
-- (aws/functions/api/tenant-billing-engine.mjs) reads charges with LEFT JOIN check_intake_items, so an unlinked charge
-- still counts.
--
-- Not changed: no other constraint, column, index, trigger, function, policy, RLS setting, grant or row (no row is read
-- into or rewritten by the file; adding the key validates the existing rows, which the old key already held to the
-- same rule).
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL executor runs it
-- inside one transaction.
--
-- NOT APPLIED. Apply only through the guarded SQL path (AGENTS.md) after a read-only inspect, staging first.

DO $sql169$
DECLARE
  v_missing text[];
  v_notnull boolean;
  v_fk_count integer;
  v_name text;
  v_def text;
  v_pred constant text := 'FOREIGN KEY (check_intake_item_id) REFERENCES public.check_intake_items(id) ON DELETE CASCADE';
  v_next constant text := 'FOREIGN KEY (check_intake_item_id) REFERENCES public.check_intake_items(id) ON DELETE SET NULL';
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.check_billing_events', pg_catalog.to_regclass('public.check_billing_events')::oid),
      ('public.check_intake_items', pg_catalog.to_regclass('public.check_intake_items')::oid)
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg('column public.' || want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (VALUES
      ('check_billing_events', 'check_intake_item_id'),
      ('check_intake_items', 'id')
    ) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = pg_catalog.to_regclass('public.' || want.tbl)
        AND a.attname = want.col AND a.attnum > 0 AND NOT a.attisdropped
    );
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql169_prerequisite_missing: %', array_to_string(v_missing, ', ') USING ERRCODE = '55000';
  END IF;

  SELECT a.attnotnull INTO v_notnull
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid = 'public.check_billing_events'::regclass AND a.attname = 'check_intake_item_id';
  IF v_notnull THEN
    RAISE EXCEPTION 'sql169_column_not_nullable: public.check_billing_events.check_intake_item_id is NOT NULL'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*)::integer, min(c.conname), min(pg_catalog.pg_get_constraintdef(c.oid))
    INTO v_fk_count, v_name, v_def
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = 'public.check_billing_events'::regclass
    AND c.contype = 'f'
    AND c.conkey = ARRAY[(
      SELECT a.attnum FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = 'public.check_billing_events'::regclass AND a.attname = 'check_intake_item_id'
    )]::smallint[];

  IF v_fk_count <> 1 OR v_name IS DISTINCT FROM 'check_billing_events_check_intake_item_id_fkey' THEN
    RAISE EXCEPTION 'sql169_unexpected_foreign_key: % foreign key(s) on check_intake_item_id, name %', v_fk_count,
      coalesce(v_name, '-') USING ERRCODE = '55000';
  END IF;

  IF v_def = v_next THEN
    RAISE NOTICE 'sql169_foreign_key_already_current';
    RETURN;
  END IF;

  IF v_def IS DISTINCT FROM v_pred THEN
    RAISE EXCEPTION 'sql169_unexpected_foreign_key: definition md5=%', md5(v_def) USING ERRCODE = '55000';
  END IF;

  ALTER TABLE public.check_billing_events DROP CONSTRAINT check_billing_events_check_intake_item_id_fkey;
  ALTER TABLE public.check_billing_events
    ADD CONSTRAINT check_billing_events_check_intake_item_id_fkey
    FOREIGN KEY (check_intake_item_id) REFERENCES public.check_intake_items(id) ON DELETE SET NULL;

  RAISE NOTICE 'sql169_foreign_key_set_null_applied';
END
$sql169$;
