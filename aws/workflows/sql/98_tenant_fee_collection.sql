-- SQL 98: manual tenant fee collection by the platform owner (stamped per-check
-- price, one charge per tenant period, the ChecksOps fee destination, an
-- append-only pull audit).
--
-- Owner decision (2026-10-17): the platform owner (public.is_platform_owner(),
-- by email) collects tenant fees manually from Tenant Management. The amount
-- comes only from the tenant's Billing tab rates (SQL 96) and recorded usage,
-- and is pulled by ACH from the bank account the tenant authorized into the
-- ChecksOps platform's own account. There is no scheduled billing.
--
-- What this file does:
-- 1) public.record_check_billing_event() + trg_record_check_billing_event on
--    check_intake_items (port of the Supabase-era trigger, last defined in
--    supabase/migrations/20260610182209_*.sql; no AWS-side definition existed
--    in aws/rls/sql, aws/workflows/sql or aws/write-path/sql). When a check
--    first reaches status 'deposited' it records one check_processing
--    billing event, priced at
--      - tenants.per_check_rate_cents when tenants.per_check_billing_enabled
--        is true and a rate is set (0 allowed), otherwise
--      - the active public.check_billing_config row's price_per_check_cents
--        (public.aws_check_billing_default_price_cents()).
--    Per-check billing off still bills that default unless owner question
--    (b) is answered otherwise: public.aws_check_billing_charges_when_per_check_off()
--    is the one switch (true, the Supabase behavior, until then).
--    check_billing_config is the ONE per-check default (the Supabase seed is
--    $3.00 = 300); the API reads the same row (tenant-billing-engine.mjs
--    CHECK_BILLING_DEFAULT_PRICE_SQL) and has no constant of its own.
--    Changes from the Supabase body, both fail-safe:
--      - per-check billing on with a NULL rate falls back to the config price
--        (Supabase inserted NULL and the deposit UPDATE failed);
--      - with no active config row the event is skipped with a WARNING
--        instead of failing the deposit (Supabase fell back to a literal 300,
--        a second default).
--    One event per (check, check_processing): the insert is guarded by
--    NOT EXISTS and ON CONFLICT DO NOTHING; the unique index below is added
--    when no equivalent exists and the data has no duplicates.
--    A seed config row (300, usd, active) is inserted only when
--    check_billing_config has no row at all.
-- 2) One charge per tenant period: the unique index
--    tenant_maintenance_payments_tenant_period_uidx (tenant_id, billing_period)
--    WHERE billing_period IS NOT NULL (the index createOrGetOccurrence's
--    ON CONFLICT names). Refuses (23505 sql98_duplicate_billing_periods) when
--    the data already holds two rows for one tenant period; reconcile first.
--    The API also takes pg_advisory_xact_lock on billing:<tenant>:<period>.
-- 3) public.platform_billing_destination: where fees land, one row per
--    environment (created when missing, same shape as the earlier billing
--    SQL). SELECT and writes: the platform owner only (the old
--    aws_monthly_billing_job() read path is dropped: nothing sets that GUC
--    any more). Every other policy on the table is dropped and checksops'
--    privileges are reset to SELECT, INSERT, UPDATE, whatever the live table
--    had. Every change is audited (event destination_set).
--    Wallet or bank destination: owner question (a),
--    tenant-collection-v2.mjs PRODUCTION_FEE_DESTINATION.
-- 4) public.platform_billing_audit (new, append-only): one row per pull /
--    verification debit attempt and outcome (who = auth.uid(), tenant,
--    period, amount, Moov transfer ids, outcome) and per destination change.
--    Written only by SECURITY DEFINER functions:
--      public.aws_platform_owner_record_billing_audit(jsonb) (platform owner
--      only, 42501 otherwise; the actor is auth.uid(), never a payload field)
--      and the platform_billing_destination trigger. No role may INSERT,
--    UPDATE or DELETE it directly; the platform owner reads it.
--
-- Refuses to run (55000 sql98_prerequisite_missing) without the tables and
-- helpers it builds on, SQL 96's aws_platform_owner_set_tenant_pricing among
-- them (apply SQL 96 first). Idempotent. No BEGIN/COMMIT: the guarded SQL executor
-- runs it in one transaction. Not applied by this change.
--
-- Deploy order: SQL 98 BEFORE tenant-billing-engine.mjs /
-- tenant-billing-handlers.mjs (the pull refuses with billing_audit_unavailable
-- until aws_platform_owner_record_billing_audit exists; nothing is charged).

DO $sql98_prereq$
BEGIN
  IF to_regclass('public.tenants') IS NULL
     OR to_regclass('public.check_intake_items') IS NULL
     OR to_regclass('public.check_billing_events') IS NULL
     OR to_regclass('public.check_billing_config') IS NULL
     OR to_regclass('public.tenant_maintenance_payments') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL
     OR to_regprocedure('public.is_platform_owner()') IS NULL
     OR to_regprocedure('public.aws_is_authenticated()') IS NULL
     -- SQL 96 first: fees are priced only from its platform-owner pricing, and
     -- the overlay plan holds the billing Lambdas on SQL 98 alone.
     OR to_regprocedure('public.aws_platform_owner_set_tenant_pricing(uuid, jsonb)') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tenant_maintenance_payments'
          AND column_name = 'billing_period')
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'check_billing_events'
          AND column_name = 'event_type')
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tenants'
          AND column_name = 'per_check_billing_enabled')
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tenants'
          AND column_name = 'per_check_rate_cents')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'checksops')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated')
  THEN
    RAISE EXCEPTION 'sql98_prerequisite_missing' USING ERRCODE = '55000';
  END IF;
END
$sql98_prereq$;

-- 1) per-check price stamping ------------------------------------------------
INSERT INTO public.check_billing_config (price_per_check_cents, currency, active)
SELECT 300, 'usd', true
 WHERE NOT EXISTS (SELECT 1 FROM public.check_billing_config);

CREATE OR REPLACE FUNCTION public.aws_check_billing_default_price_cents()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT c.price_per_check_cents
    FROM public.check_billing_config c
   WHERE c.active = true
   ORDER BY c.created_at DESC
   LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.aws_check_billing_default_price_cents() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_check_billing_default_price_cents() TO checksops, authenticated;
COMMENT ON FUNCTION public.aws_check_billing_default_price_cents() IS
  'SQL 98: the one per-check default price (active check_billing_config row); NULL when none is active.';

-- OWNER QUESTION (b), OPEN: does per-check billing "off" mean no per-check fee?
-- This function is the one database switch. true (the default, the Supabase
-- trigger's behavior): a tenant with per-check billing off is still billed the
-- check_billing_config default per deposited check. false: no check_processing
-- event is recorded for such a tenant. The API mirrors it with
-- tenant-billing-engine.mjs PER_CHECK_OFF_BILLS_DEFAULT_PRICE; change both
-- together, in a reviewed change.
CREATE OR REPLACE FUNCTION public.aws_check_billing_charges_when_per_check_off()
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION public.aws_check_billing_charges_when_per_check_off() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_check_billing_charges_when_per_check_off() TO checksops, authenticated;
COMMENT ON FUNCTION public.aws_check_billing_charges_when_per_check_off() IS
  'SQL 98, owner question (b): whether per-check billing off still bills the check_billing_config default (true, the default) or nothing (false).';

DO $sql98_event_unique$
DECLARE
  v_has_unique boolean;
  v_dupes integer;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND t.relname = 'check_billing_events'
       AND i.indisunique
       AND (
         SELECT array_agg(a.attname::text ORDER BY a.attname)
           FROM unnest(i.indkey) AS k(attnum)
           JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       ) <@ ARRAY['check_intake_item_id', 'event_type', 'tenant_id']::text[]
       AND (
         SELECT array_agg(a.attname::text)
           FROM unnest(i.indkey) AS k(attnum)
           JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       ) @> ARRAY['check_intake_item_id', 'event_type']::text[]
  ) INTO v_has_unique;
  IF v_has_unique THEN
    RETURN;
  END IF;
  SELECT count(*) INTO v_dupes FROM (
    SELECT 1 FROM public.check_billing_events
     WHERE check_intake_item_id IS NOT NULL
     GROUP BY check_intake_item_id, event_type
    HAVING count(*) > 1) d;
  IF v_dupes > 0 THEN
    RAISE WARNING 'sql98: check_billing_events has % duplicated (check, event_type) pairs; unique index not added (the trigger still records one event per check)', v_dupes;
    RETURN;
  END IF;
  EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS check_billing_events_check_event_uidx
             ON public.check_billing_events (check_intake_item_id, event_type)
             WHERE check_intake_item_id IS NOT NULL';
END
$sql98_event_unique$;

CREATE OR REPLACE FUNCTION public.record_check_billing_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_enabled boolean;
  v_rate integer;
  v_price integer;
BEGIN
  IF NEW.status = 'deposited'
     AND OLD.status IS DISTINCT FROM 'deposited'
     AND NEW.tenant_id IS NOT NULL THEN

    SELECT t.per_check_billing_enabled, t.per_check_rate_cents
      INTO v_enabled, v_rate
      FROM public.tenants t
     WHERE t.id = NEW.tenant_id;

    IF v_enabled IS TRUE AND v_rate IS NOT NULL THEN
      v_price := v_rate;
    ELSIF v_enabled IS NOT TRUE AND NOT public.aws_check_billing_charges_when_per_check_off() THEN
      -- Owner question (b) answered "off means no per-check fee".
      RETURN NEW;
    ELSE
      v_price := public.aws_check_billing_default_price_cents();
    END IF;

    IF v_price IS NULL THEN
      RAISE WARNING 'record_check_billing_event: no active check_billing_config row; check % not billed', NEW.id;
      RETURN NEW;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.check_billing_events e
       WHERE e.check_intake_item_id = NEW.id
         AND e.event_type = 'check_processing'
    ) THEN
      INSERT INTO public.check_billing_events (
        tenant_id, check_intake_item_id, unit_price_cents, currency, status, event_type
      ) VALUES (
        NEW.tenant_id, NEW.id, v_price, 'usd', 'recorded', 'check_processing'
      )
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.record_check_billing_event() FROM PUBLIC;
COMMENT ON FUNCTION public.record_check_billing_event() IS
  'SQL 98 (port of the Supabase trigger): first deposit of a check records one check_processing event priced at the tenant per-check rate (per-check billing on) or the check_billing_config default.';

DROP TRIGGER IF EXISTS trg_record_check_billing_event ON public.check_intake_items;
CREATE TRIGGER trg_record_check_billing_event
  AFTER UPDATE OF status ON public.check_intake_items
  FOR EACH ROW
  EXECUTE FUNCTION public.record_check_billing_event();

-- 2) one charge per tenant period --------------------------------------------
DO $sql98_period_unique$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.tenant_maintenance_payments
     WHERE billing_period IS NOT NULL
     GROUP BY tenant_id, billing_period
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'sql98_duplicate_billing_periods: reconcile tenant_maintenance_payments before applying'
      USING ERRCODE = '23505';
  END IF;
END
$sql98_period_unique$;

CREATE UNIQUE INDEX IF NOT EXISTS tenant_maintenance_payments_tenant_period_uidx
  ON public.tenant_maintenance_payments (tenant_id, billing_period)
  WHERE billing_period IS NOT NULL;

-- 4) audit (before 3, whose trigger writes it) -------------------------------
CREATE TABLE IF NOT EXISTS public.platform_billing_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event text NOT NULL CHECK (event IN ('pull', 'verify_debit', 'destination_set')),
  actor_id uuid,
  tenant_id uuid,
  billing_period text,
  amount_cents bigint,
  occurrence_id uuid,
  provider_transfer_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  outcome text NOT NULL,
  preview_hash text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_billing_audit_tenant_idx
  ON public.platform_billing_audit (tenant_id, created_at DESC);
COMMENT ON TABLE public.platform_billing_audit IS
  'SQL 98: append-only audit of tenant fee pulls, verification debits and fee-destination changes (who, tenant, period, amount, Moov transfer ids, outcome).';

ALTER TABLE public.platform_billing_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_billing_audit FROM PUBLIC;
REVOKE ALL ON TABLE public.platform_billing_audit FROM authenticated;
REVOKE ALL ON TABLE public.platform_billing_audit FROM checksops;
GRANT SELECT ON TABLE public.platform_billing_audit TO checksops, authenticated;
DROP POLICY IF EXISTS aws_select_platform_billing_audit ON public.platform_billing_audit;
CREATE POLICY aws_select_platform_billing_audit ON public.platform_billing_audit
  FOR SELECT TO authenticated
  USING (public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false));

CREATE OR REPLACE FUNCTION public.aws_platform_owner_record_billing_audit(_entry jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $body$
DECLARE
  v_id uuid;
  v_event text := _entry ->> 'event';
  v_ids text[];
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'not_authorized: platform owner required' USING ERRCODE = '42501';
  END IF;
  IF _entry IS NULL OR jsonb_typeof(_entry) <> 'object'
     OR v_event IS NULL OR v_event NOT IN ('pull', 'verify_debit')
     OR COALESCE(_entry ->> 'outcome', '') = ''
     OR COALESCE(_entry ->> 'tenant_id', '') = '' THEN
    RAISE EXCEPTION 'invalid_audit_entry' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(array_agg(x), ARRAY[]::text[]) INTO v_ids
    FROM jsonb_array_elements_text(COALESCE(_entry -> 'provider_transfer_ids', '[]'::jsonb)) AS x;
  INSERT INTO public.platform_billing_audit (
    event, actor_id, tenant_id, billing_period, amount_cents, occurrence_id,
    provider_transfer_ids, outcome, preview_hash, details
  ) VALUES (
    v_event,
    auth.uid(),
    (_entry ->> 'tenant_id')::uuid,
    NULLIF(_entry ->> 'billing_period', ''),
    (_entry ->> 'amount_cents')::bigint,
    NULLIF(_entry ->> 'occurrence_id', '')::uuid,
    v_ids,
    left(_entry ->> 'outcome', 200),
    NULLIF(_entry ->> 'preview_hash', ''),
    COALESCE(_entry -> 'details', '{}'::jsonb)
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END
$body$;
REVOKE ALL ON FUNCTION public.aws_platform_owner_record_billing_audit(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_platform_owner_record_billing_audit(jsonb) TO checksops, authenticated;
COMMENT ON FUNCTION public.aws_platform_owner_record_billing_audit(jsonb) IS
  'SQL 98: the platform owner''s billing API records a pull / verification debit (actor = auth.uid()). Everyone else is refused (42501).';

-- 3) fee destination -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_billing_destination (
  environment text PRIMARY KEY CHECK (environment IN ('sandbox', 'production')),
  moov_account_id text NOT NULL,
  moov_payment_method_id text NOT NULL,
  label text NOT NULL DEFAULT 'ChecksOps merchant',
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.platform_billing_destination IS
  'Where tenant fees land: the ChecksOps platform Moov account and payment method, one row per environment. Platform owner only (SQL 98).';

ALTER TABLE public.platform_billing_destination ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_billing_destination FROM PUBLIC;
REVOKE ALL ON TABLE public.platform_billing_destination FROM authenticated;
REVOKE ALL ON TABLE public.platform_billing_destination FROM checksops;
GRANT SELECT ON TABLE public.platform_billing_destination TO checksops, authenticated;

-- Fail closed on whatever policies the table already had: no repository SQL
-- created it, so the live policy names are unknown and any other permissive
-- policy would be OR'ed with the platform-owner-only ones below. Only these
-- two may remain.
DO $sql98_destination_policies$
DECLARE
  v_policy text;
BEGIN
  FOR v_policy IN
    SELECT policyname FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'platform_billing_destination'
       AND policyname NOT IN ('aws_select_platform_billing_destination', 'aws_write_platform_billing_destination')
  LOOP
    RAISE NOTICE 'sql98: dropping policy % on public.platform_billing_destination', v_policy;
    EXECUTE format('DROP POLICY %I ON public.platform_billing_destination', v_policy);
  END LOOP;
END
$sql98_destination_policies$;
GRANT INSERT, UPDATE ON TABLE public.platform_billing_destination TO checksops;
DROP POLICY IF EXISTS aws_select_platform_billing_destination ON public.platform_billing_destination;
CREATE POLICY aws_select_platform_billing_destination ON public.platform_billing_destination
  FOR SELECT TO authenticated
  USING (public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false));
DROP POLICY IF EXISTS aws_write_platform_billing_destination ON public.platform_billing_destination;
CREATE POLICY aws_write_platform_billing_destination ON public.platform_billing_destination
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))
  WITH CHECK (public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false));

CREATE OR REPLACE FUNCTION public.aws_platform_billing_destination_audit_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  INSERT INTO public.platform_billing_audit (event, actor_id, outcome, details)
  VALUES (
    'destination_set',
    auth.uid(),
    lower(TG_OP),
    jsonb_build_object(
      'environment', COALESCE(NEW.environment, OLD.environment),
      'old', CASE WHEN TG_OP = 'INSERT' THEN NULL
                  ELSE jsonb_build_object('moov_account_id', OLD.moov_account_id, 'moov_payment_method_id', OLD.moov_payment_method_id) END,
      'new', CASE WHEN TG_OP = 'DELETE' THEN NULL
                  ELSE jsonb_build_object('moov_account_id', NEW.moov_account_id, 'moov_payment_method_id', NEW.moov_payment_method_id, 'label', NEW.label) END
    )
  );
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.aws_platform_billing_destination_audit_row() FROM PUBLIC;

DROP TRIGGER IF EXISTS aws_platform_billing_destination_audit ON public.platform_billing_destination;
CREATE TRIGGER aws_platform_billing_destination_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.platform_billing_destination
  FOR EACH ROW
  EXECUTE FUNCTION public.aws_platform_billing_destination_audit_row();
