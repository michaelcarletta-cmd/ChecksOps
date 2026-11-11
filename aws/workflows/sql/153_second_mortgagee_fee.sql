-- AWS: Mortgage Ops fee for the 2nd mortgage company on a check (SQL 153).
-- Forward migration on top of SQL 84 (one Mortgage Ops charge per check), SQL 98 (tenant fee
-- collection) and SQL 148 (a 2nd mortgagee request). AWS only: nothing under supabase/migrations
-- changes.
--
-- Why (owner, 2026-11-10/11): "For 2 mortgage companies in check charge $5 for the additional
-- mortgage company." Asked flat $5 or the tenant's rate: "Flat $5". Since SQL 148 a check made out
-- to two mortgage companies has two Mortgage Desk requests (the 2nd: endorsement_order 2,
-- total_mortgagees 2, predecessor_request_id = the 1st). The Mortgage Ops charge is recorded when
-- the Mortgage Desk accepts a request (aws/functions/api/workflow-rpc.mjs executeAcceptMortgage ->
-- mortgage-ops-usage.mjs accrueMortgageOpsAcceptedRequest), one per check (SQL 84's
-- check_billing_events_one_mortgage_ops_per_check), so the 2nd company's accept records nothing.
--
-- The API (same change) records, when the accepted request is the 2nd mortgagee
-- (endorsement_order 2), one check_billing_events row of the new event type
-- 'mortgage_ops_second_mortgagee' at a flat 500 cents (not a per-tenant rate), billed_at =
-- accepted_at, for the check, its claim and that request. The 1st company's $10 / $5 is unchanged.
-- The API records nothing of the new type until this file is applied (it looks for the index of
-- 2) below), so the Lambda and this file may go live in either order.
--
-- 1) check_billing_events.event_type admits 'mortgage_ops_second_mortgagee'. The repository
--    defines no CHECK on that column (Supabase 20260605162924 added it as plain text with a
--    default; SQL 120, 149, 151 and the open SQL 152 add event types without touching any CHECK),
--    so on a database shaped like the repository this step changes nothing. If the live table
--    carries a single-column CHECK on event_type of the form
--      CHECK ((event_type = ANY (ARRAY['a'::text, ...])))      (how PostgreSQL prints IN (...))
--    the step reads the values IN THAT LIVE CONSTRAINT at apply time and replaces it, same name,
--    same validity, with exactly those values plus 'mortgage_ops_second_mortgagee' appended. It
--    never writes a list of its own, so whatever SQL 149, 151, 152 or anything else applied before
--    it added stays allowed, in any apply order; a value already present is a no-op. Values are
--    parsed and the parse is proved by rebuilding the constraint text and comparing it with
--    PostgreSQL's own (pg_get_constraintdef); any other shape (a CHECK that also names another
--    column, a single comparison, a cast, a NULL test) is refused, nothing changed:
--    55000 sql153_event_type_check_unrecognized: <name>: <definition>. A later file that changes
--    such a CHECK must likewise add to the live list, never rewrite it from a copy.
-- 2) Unique index check_billing_events_one_second_mortgagee_per_check on (check_intake_item_id)
--    WHERE event_type = 'mortgage_ops_second_mortgagee' AND status IS DISTINCT FROM 'voided' AND
--    check_intake_item_id IS NOT NULL: at most one live 2nd-company charge per check, whoever
--    writes it, so a repeated accept (or a Return to Queue and a new accept) cannot charge twice.
--    The API's insert is ON CONFLICT DO NOTHING. Created after refusing (23505
--    sql153_duplicate_second_mortgagee_events, listing the checks) if duplicates already exist,
--    then proved valid and matching (55000 sql153_index_invalid otherwise, as SQL 84 does).
-- 3) public.tenant_maintenance_payments gains mortgage_ops_second_mortgagee_count and
--    mortgage_ops_second_mortgagee_amount_cents (integer NOT NULL DEFAULT 0), the monthly
--    invoice's breakdown of the new fee beside mortgage_ops_initial_* / mortgage_ops_additional_*
--    and SQL 149's invoice_fee_* / failed_deposit_*. Needed because the booked row is the record
--    the fee invoice email lists (tenant-fee-invoice-email.mjs occurrenceInvoiceLines reads its
--    columns; the row has no line-item JSON), so without them the email's lines would not add up
--    to its total. usage_total_cents and amount_cents already carry the fee.
--
-- Not changed: no existing row, function, trigger, policy or grant; SQL 84's and SQL 98's indexes
-- and the 1st company's $10 / $5 rates. The live-only trigger tr_accrue_mortgage_ops_billing on
-- mortgage_handling_requests (no CREATE in the repository) is not touched. get_tenant_check_usage
-- (SQL 126) lists the new events on Settings -> Usage as it is (every non-voided event).
--
-- Refuses to run (55000 sql153_prerequisite_missing) without check_billing_events (with
-- event_type, status, check_intake_item_id, claim_id, mortgage_request_id),
-- mortgage_handling_requests.endorsement_order and tenant_maintenance_payments. Idempotent.
-- No BEGIN/COMMIT: the guarded SQL executor runs it in one transaction. Not applied by this
-- change.

DO $sql153_prerequisites$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.check_billing_events') IS NULL THEN v_missing := array_append(v_missing, 'public.check_billing_events'); END IF;
  IF to_regclass('public.mortgage_handling_requests') IS NULL THEN v_missing := array_append(v_missing, 'public.mortgage_handling_requests'); END IF;
  IF to_regclass('public.tenant_maintenance_payments') IS NULL THEN v_missing := array_append(v_missing, 'public.tenant_maintenance_payments'); END IF;
  IF to_regclass('public.check_billing_events') IS NOT NULL AND (
       SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'check_billing_events'
          AND column_name IN ('event_type', 'status', 'check_intake_item_id', 'claim_id', 'mortgage_request_id')) <> 5 THEN
    v_missing := array_append(v_missing, 'check_billing_events.event_type/status/check_intake_item_id/claim_id/mortgage_request_id');
  END IF;
  IF to_regclass('public.mortgage_handling_requests') IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'mortgage_handling_requests'
          AND column_name = 'endorsement_order') THEN
    v_missing := array_append(v_missing, 'mortgage_handling_requests.endorsement_order');
  END IF;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'sql153_prerequisite_missing: %', array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;
END
$sql153_prerequisites$;

-- 1) event_type CHECK, if the live table has one: add the new value to the live list -------
DO $sql153_event_type_check$
DECLARE
  v_new constant text := 'mortgage_ops_second_mortgagee';
  v_attnum smallint;
  r record;
  v_inner text;
  v_values text[];
  v_rebuilt text;
BEGIN
  SELECT a.attnum INTO v_attnum
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = 'public.check_billing_events'::regclass
     AND a.attname = 'event_type' AND NOT a.attisdropped;

  FOR r IN
    SELECT c.oid, c.conname, c.conkey, c.convalidated, pg_catalog.pg_get_constraintdef(c.oid) AS def
      FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = 'public.check_billing_events'::regclass
       AND c.contype = 'c'
       AND v_attnum = ANY (c.conkey)
     ORDER BY c.conname
  LOOP
    IF r.conkey <> ARRAY[v_attnum] THEN
      RAISE EXCEPTION 'sql153_event_type_check_unrecognized: %: %', r.conname, r.def
        USING ERRCODE = '55000';
    END IF;
    v_inner := substring(r.def FROM '^CHECK \(\(event_type = ANY \(ARRAY\[(.*)\]\)\)\)( NOT VALID)?$');
    IF v_inner IS NULL THEN
      RAISE EXCEPTION 'sql153_event_type_check_unrecognized: %: %', r.conname, r.def
        USING ERRCODE = '55000';
    END IF;
    SELECT array_agg(replace(m[1], '''''', '''') ORDER BY ord)
      INTO v_values
      FROM regexp_matches(v_inner, '''((?:[^'']|'''')*)''::text', 'g') WITH ORDINALITY AS t(m, ord);
    SELECT string_agg(quote_literal(v) || '::text', ', ' ORDER BY ord)
      INTO v_rebuilt
      FROM unnest(v_values) WITH ORDINALITY AS u(v, ord);
    IF v_values IS NULL OR v_rebuilt IS DISTINCT FROM v_inner THEN
      RAISE EXCEPTION 'sql153_event_type_check_unrecognized: %: %', r.conname, r.def
        USING ERRCODE = '55000';
    END IF;
    IF v_new = ANY (v_values) THEN
      RAISE NOTICE 'SQL 153: % already admits %', r.conname, v_new;
      CONTINUE;
    END IF;
    v_values := array_append(v_values, v_new);
    EXECUTE format('ALTER TABLE public.check_billing_events DROP CONSTRAINT %I', r.conname);
    EXECUTE format(
      'ALTER TABLE public.check_billing_events ADD CONSTRAINT %I CHECK (event_type = ANY (ARRAY[%s]))%s',
      r.conname,
      (SELECT string_agg(quote_literal(v) || '::text', ', ' ORDER BY ord) FROM unnest(v_values) WITH ORDINALITY AS u(v, ord)),
      CASE WHEN r.convalidated THEN '' ELSE ' NOT VALID' END);
    RAISE NOTICE 'SQL 153: % now admits % (% values kept)', r.conname, v_new, cardinality(v_values) - 1;
  END LOOP;
END
$sql153_event_type_check$;

-- 2) one live 2nd-company charge per check -------------------------------------------------
DO $sql153_index$
DECLARE
  v_pred constant text :=
    '((event_type = ''mortgage_ops_second_mortgagee''::text) AND (status IS DISTINCT FROM ''voided''::text) AND (check_intake_item_id IS NOT NULL))';
  v_dupes text;
BEGIN
  SELECT string_agg(d.check_intake_item_id::text || ' (' || d.n || ')', ', ' ORDER BY d.check_intake_item_id)
    INTO v_dupes
    FROM (
      SELECT e.check_intake_item_id, count(*) AS n
        FROM public.check_billing_events e
       WHERE e.event_type = 'mortgage_ops_second_mortgagee'
         AND e.status IS DISTINCT FROM 'voided'
         AND e.check_intake_item_id IS NOT NULL
       GROUP BY e.check_intake_item_id
      HAVING count(*) > 1
    ) d;
  IF v_dupes IS NOT NULL THEN
    RAISE EXCEPTION 'sql153_duplicate_second_mortgagee_events: check_intake_item_id (events): %', v_dupes
      USING ERRCODE = '23505';
  END IF;

  CREATE UNIQUE INDEX IF NOT EXISTS check_billing_events_one_second_mortgagee_per_check
    ON public.check_billing_events (check_intake_item_id)
    WHERE event_type = 'mortgage_ops_second_mortgagee'
      AND status IS DISTINCT FROM 'voided'
      AND check_intake_item_id IS NOT NULL;

  -- CREATE ... IF NOT EXISTS skips an existing (possibly different or invalid) index of this
  -- name, so prove the one there now is the valid unique index above.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE i.indexrelid = to_regclass('public.check_billing_events_one_second_mortgagee_per_check')
       AND i.indrelid = 'public.check_billing_events'::regclass
       AND i.indisunique
       AND i.indisvalid
       AND i.indnkeyatts = 1
       AND i.indexprs IS NULL
       AND a.attname = 'check_intake_item_id'
       AND pg_catalog.pg_get_expr(i.indpred, i.indrelid) = v_pred
  ) THEN
    RAISE EXCEPTION 'sql153_index_invalid: check_billing_events_one_second_mortgagee_per_check exists but is not the valid unique index this file defines; drop it and rerun'
      USING ERRCODE = '55000';
  END IF;
END
$sql153_index$;
COMMENT ON INDEX public.check_billing_events_one_second_mortgagee_per_check IS
  'SQL 153: at most one non-voided mortgage_ops_second_mortgagee ($5, the 2nd mortgage company) event per check.';

-- 3) monthly invoice breakdown --------------------------------------------------------------
ALTER TABLE public.tenant_maintenance_payments
  ADD COLUMN IF NOT EXISTS mortgage_ops_second_mortgagee_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mortgage_ops_second_mortgagee_amount_cents integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.tenant_maintenance_payments.mortgage_ops_second_mortgagee_count IS
  'SQL 153: 2nd mortgage company charges in the period (mortgage_ops_second_mortgagee usage events).';
COMMENT ON COLUMN public.tenant_maintenance_payments.mortgage_ops_second_mortgagee_amount_cents IS
  'SQL 153: the total of those charges, in cents.';
