-- AWS: the optional Starter Package (SQL 150).
-- Forward migration on top of SQL 102 (the tenants column guard), SQL 120 and SQL 149 (the usage
-- events). AWS only: nothing under supabase/migrations changes.
--
-- Owner decisions (2026-11-10): the Starter Package is optional and named on the order form. Its
-- one-time $3,500.00 covers the setup fee, 12 months of Monthly Maintenance and 250 included Checks.
-- "Unused check can roll over" (included Checks do not expire). "A failed deposit uses one of the
-- 250." "Other fees are still charged" (payment, invoice, Mortgage Ops). "Have a toggle switch or
-- date start to date end to show which tenants are on it."
--
-- 1) public.tenants gains
--      starter_package_enabled boolean NOT NULL DEFAULT false (the toggle: every tenant starts off),
--      starter_package_starts_on date, starter_package_maintenance_ends_on date (inclusive),
--      starter_package_included_checks integer NOT NULL DEFAULT 250 (>= 0),
--    with a check that an enabled package has both dates and ends on or after it starts.
-- 2) check_billing_events.package_included boolean NOT NULL DEFAULT false: the event used one of the
--    package's included Checks (and is priced 0).
-- 3) public.aws_starter_package_checks_used(uuid) (new, STABLE, SECURITY DEFINER, owner only): the
--    tenant's events with package_included that are not voided.
-- 4) public.aws_apply_starter_package_to_event() (new trigger function, SECURITY DEFINER) and trigger
--    aws_check_billing_event_starter_package, BEFORE INSERT OR UPDATE OF status ON
--    public.check_billing_events, for check_processing and failed_deposit events only:
--      a. on insert, when the tenant's package is enabled, started (starts_on <= the event's billed
--         date) and has included Checks left, the event is package_included and its price 0;
--      b. when a voided event is recorded again (SQL 120 re-records the check fee when the check is
--         approved again), the same test is made again: still room -> included at 0; no room and it
--         was included -> its normal price (aws_check_processing_price_cents, or
--         aws_failed_deposit_fee_cents) and no longer included.
--    Voiding an included event frees its Check (it no longer counts): a deposit that fails after
--    approval swaps the check fee's Check for the failed deposit's, so it "uses one". One transaction
--    per tenant at a time (pg_advisory_xact_lock), so two events cannot share the last Check.
--    Every other event, mortgage, payment and invoice fees included, is untouched.
-- 5) public.aws_platform_owner_set_tenant_starter_package(uuid, boolean, date, date, integer) (new,
--    SECURITY DEFINER): the platform owner's write path (as SQL 98's deposits switch). Refuses anyone
--    else (42501), a missing tenant (P0002), and bad values (22023 invalid_value: starts_on required
--    to enable, ends before it starts, negative included Checks). Defaults when enabling: ends_on =
--    starts_on + 12 months - 1 day, included Checks 250. Turning it off keeps the dates. Returns the
--    package and the Checks used.
-- 6) public.aws_tenant_starter_package_audit_row() + trigger aws_tenant_starter_package_audit (AFTER
--    UPDATE on tenants): one tenant_pricing_audit row per changed package column, by any path.
-- 7) The tenants column guard (SQL 102's, replaced here): SQL 102's body unchanged except that the
--    platform owner may also change the four package columns. Members still cannot. Re-running SQL
--    102 after this file puts back SQL 102's guard (fail closed: the package could no longer be
--    changed; nothing else changes) until SQL 150 is re-run.
--
-- Maintenance: the API (tenant-billing-engine.mjs) charges no Monthly Maintenance for a billing month
-- that lies wholly inside starts_on .. maintenance_ends_on while the package is enabled.
--
-- Not changed: no grant to checksops beyond EXECUTE on the setter (the platform owner's path, as SQL
-- 98's) and on aws_starter_package_checks_used for the usage page; no existing event is repriced. No
-- BEGIN/COMMIT: the guarded SQL executor runs it in one transaction. Refuses to run (55000
-- sql150_prerequisite_missing) without SQL 102's guard, SQL 120's and SQL 149's price functions and
-- tenant_pricing_audit. Idempotent. Not applied by this change.

DO $sql150_prerequisites$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.tenants') IS NULL THEN v_missing := array_append(v_missing, 'public.tenants'); END IF;
  IF to_regclass('public.check_billing_events') IS NULL THEN v_missing := array_append(v_missing, 'public.check_billing_events'); END IF;
  IF to_regclass('public.tenant_pricing_audit') IS NULL THEN v_missing := array_append(v_missing, 'public.tenant_pricing_audit (SQL 96)'); END IF;
  IF to_regprocedure('public.aws_tenants_member_column_guard()') IS NULL THEN
    v_missing := array_append(v_missing, 'public.aws_tenants_member_column_guard() (SQL 102)');
  END IF;
  IF to_regprocedure('public.aws_tenant_profile_columns()') IS NULL THEN
    v_missing := array_append(v_missing, 'public.aws_tenant_profile_columns() (SQL 102)');
  END IF;
  IF to_regprocedure('public.aws_tenant_has_moov_account(uuid)') IS NULL THEN
    v_missing := array_append(v_missing, 'public.aws_tenant_has_moov_account(uuid) (SQL 102)');
  END IF;
  IF to_regprocedure('public.aws_tenant_pricing_columns()') IS NULL THEN
    v_missing := array_append(v_missing, 'public.aws_tenant_pricing_columns() (SQL 96)');
  END IF;
  IF to_regprocedure('public.aws_check_processing_price_cents(uuid)') IS NULL THEN
    v_missing := array_append(v_missing, 'public.aws_check_processing_price_cents(uuid) (SQL 120)');
  END IF;
  IF to_regprocedure('public.aws_failed_deposit_fee_cents()') IS NULL THEN
    v_missing := array_append(v_missing, 'public.aws_failed_deposit_fee_cents() (SQL 149)');
  END IF;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'sql150_prerequisite_missing: %', array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;
END
$sql150_prerequisites$;

-- 1) the package on the tenant ------------------------------------------------------
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS starter_package_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS starter_package_starts_on date,
  ADD COLUMN IF NOT EXISTS starter_package_maintenance_ends_on date,
  ADD COLUMN IF NOT EXISTS starter_package_included_checks integer NOT NULL DEFAULT 250;
DO $sql150_package_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.tenants'::regclass AND conname = 'tenants_starter_package_valid') THEN
    ALTER TABLE public.tenants ADD CONSTRAINT tenants_starter_package_valid CHECK (
      starter_package_included_checks >= 0
      AND (NOT starter_package_enabled
           OR (starter_package_starts_on IS NOT NULL
               AND starter_package_maintenance_ends_on IS NOT NULL
               AND starter_package_maintenance_ends_on >= starter_package_starts_on)));
  END IF;
END
$sql150_package_check$;
COMMENT ON COLUMN public.tenants.starter_package_enabled IS
  'SQL 150: the tenant is on the optional Starter Package (platform owner only; audited in tenant_pricing_audit).';
COMMENT ON COLUMN public.tenants.starter_package_maintenance_ends_on IS
  'SQL 150: the last day of Monthly Maintenance the Starter Package covers (inclusive).';
COMMENT ON COLUMN public.tenants.starter_package_included_checks IS
  'SQL 150: Checks the Starter Package includes (each check fee or failed deposit fee uses one; they do not expire).';

-- 2) the event used an included Check -----------------------------------------------
ALTER TABLE public.check_billing_events
  ADD COLUMN IF NOT EXISTS package_included boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.check_billing_events.package_included IS
  'SQL 150: this check fee or failed deposit fee used one of the Starter Package''s included Checks (priced 0).';

-- 3) Checks used ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_starter_package_checks_used(p_tenant_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT count(*)::integer
    FROM public.check_billing_events e
   WHERE e.tenant_id = p_tenant_id
     AND e.package_included
     AND e.status IS DISTINCT FROM 'voided'
$$;
REVOKE ALL ON FUNCTION public.aws_starter_package_checks_used(uuid) FROM PUBLIC;
COMMENT ON FUNCTION public.aws_starter_package_checks_used(uuid) IS
  'SQL 150: the Starter Package Checks a tenant has used (its package_included events that are not voided).';

-- 4) price new events against the package ---------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_apply_starter_package_to_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_pkg record;
  v_used integer;
  v_room boolean := false;
BEGIN
  IF NEW.event_type IS NULL OR NEW.event_type NOT IN ('check_processing', 'failed_deposit') OR NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Only a voided event recorded again is looked at again.
    IF NOT (OLD.status = 'voided' AND NEW.status IS DISTINCT FROM 'voided') THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.status = 'voided' THEN
    RETURN NEW;
  END IF;

  SELECT t.starter_package_enabled AS enabled, t.starter_package_starts_on AS starts_on,
         t.starter_package_included_checks AS included
    INTO v_pkg
    FROM public.tenants t
   WHERE t.id = NEW.tenant_id;

  IF v_pkg.enabled IS TRUE AND v_pkg.starts_on IS NOT NULL
     AND v_pkg.starts_on <= (COALESCE(NEW.billed_at, now()) AT TIME ZONE 'UTC')::date THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sql150_starter_package:' || NEW.tenant_id::text, 0));
    SELECT count(*)::integer INTO v_used
      FROM public.check_billing_events e
     WHERE e.tenant_id = NEW.tenant_id
       AND e.package_included
       AND e.status IS DISTINCT FROM 'voided'
       AND (TG_OP = 'INSERT' OR e.id <> NEW.id);
    v_room := v_used < COALESCE(v_pkg.included, 0);
  END IF;

  IF v_room THEN
    NEW.package_included := true;
    NEW.unit_price_cents := 0;
  ELSIF TG_OP = 'UPDATE' AND NEW.package_included THEN
    NEW.package_included := false;
    NEW.unit_price_cents := CASE NEW.event_type
      WHEN 'failed_deposit' THEN public.aws_failed_deposit_fee_cents()
      ELSE COALESCE(public.aws_check_processing_price_cents(NEW.tenant_id), 0)
    END;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.aws_apply_starter_package_to_event() FROM PUBLIC;
COMMENT ON FUNCTION public.aws_apply_starter_package_to_event() IS
  'SQL 150: a check fee or failed deposit fee uses one of the Starter Package''s included Checks (priced 0) while the package is on, started and has Checks left.';

DROP TRIGGER IF EXISTS aws_check_billing_event_starter_package ON public.check_billing_events;
CREATE TRIGGER aws_check_billing_event_starter_package
  BEFORE INSERT OR UPDATE OF status ON public.check_billing_events
  FOR EACH ROW
  EXECUTE FUNCTION public.aws_apply_starter_package_to_event();

-- 5) the platform owner's setter --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_platform_owner_set_tenant_starter_package(
  _tenant_id uuid,
  _enabled boolean,
  _starts_on date,
  _maintenance_ends_on date,
  _included_checks integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $body$
DECLARE
  v_row record;
  v_starts date;
  v_ends date;
  v_included integer;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(public.is_platform_owner(), false) THEN
    RAISE EXCEPTION 'not_authorized: platform owner required' USING ERRCODE = '42501';
  END IF;
  IF _tenant_id IS NULL OR _enabled IS NULL THEN
    RAISE EXCEPTION 'missing_required_field' USING ERRCODE = '22023';
  END IF;
  SELECT t.starter_package_starts_on, t.starter_package_maintenance_ends_on, t.starter_package_included_checks
    INTO v_row
    FROM public.tenants t WHERE t.id = _tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_not_found' USING ERRCODE = 'P0002';
  END IF;
  v_starts := COALESCE(_starts_on, v_row.starter_package_starts_on);
  v_included := COALESCE(_included_checks, v_row.starter_package_included_checks, 250);
  v_ends := COALESCE(_maintenance_ends_on,
    CASE WHEN _starts_on IS NOT NULL THEN (_starts_on + interval '12 months' - interval '1 day')::date END,
    v_row.starter_package_maintenance_ends_on,
    CASE WHEN v_starts IS NOT NULL THEN (v_starts + interval '12 months' - interval '1 day')::date END);
  IF _enabled AND v_starts IS NULL THEN
    RAISE EXCEPTION 'invalid_value: a start date is required' USING ERRCODE = '22023', DETAIL = 'starter_package_starts_on';
  END IF;
  IF v_starts IS NOT NULL AND v_ends IS NOT NULL AND v_ends < v_starts THEN
    RAISE EXCEPTION 'invalid_value: the end date is before the start date' USING ERRCODE = '22023', DETAIL = 'starter_package_maintenance_ends_on';
  END IF;
  IF v_included < 0 THEN
    RAISE EXCEPTION 'invalid_value: included checks cannot be negative' USING ERRCODE = '22023', DETAIL = 'starter_package_included_checks';
  END IF;
  UPDATE public.tenants
     SET starter_package_enabled = _enabled,
         starter_package_starts_on = v_starts,
         starter_package_maintenance_ends_on = v_ends,
         starter_package_included_checks = v_included
   WHERE id = _tenant_id;
  RETURN jsonb_build_object(
    'ok', true, 'tenant_id', _tenant_id,
    'starter_package_enabled', _enabled,
    'starter_package_starts_on', v_starts,
    'starter_package_maintenance_ends_on', v_ends,
    'starter_package_included_checks', v_included,
    'starter_package_checks_used', public.aws_starter_package_checks_used(_tenant_id));
END
$body$;
REVOKE ALL ON FUNCTION public.aws_platform_owner_set_tenant_starter_package(uuid, boolean, date, date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_platform_owner_set_tenant_starter_package(uuid, boolean, date, date, integer) TO checksops;
COMMENT ON FUNCTION public.aws_platform_owner_set_tenant_starter_package(uuid, boolean, date, date, integer) IS
  'SQL 150: the platform owner turns a tenant''s Starter Package on or off and sets its dates and included Checks. Everyone else is refused (42501). Audited in tenant_pricing_audit.';

-- 6) audit ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_tenant_starter_package_audit_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_field text;
  v_old jsonb := to_jsonb(OLD);
  v_new jsonb := to_jsonb(NEW);
BEGIN
  FOREACH v_field IN ARRAY ARRAY['starter_package_enabled', 'starter_package_starts_on',
                                 'starter_package_maintenance_ends_on', 'starter_package_included_checks'] LOOP
    IF (v_new -> v_field) IS DISTINCT FROM (v_old -> v_field) THEN
      INSERT INTO public.tenant_pricing_audit (tenant_id, actor_id, field, old_value, new_value)
      VALUES (NEW.id, auth.uid(), v_field, v_old -> v_field, v_new -> v_field);
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.aws_tenant_starter_package_audit_row() FROM PUBLIC;
DROP TRIGGER IF EXISTS aws_tenant_starter_package_audit ON public.tenants;
CREATE TRIGGER aws_tenant_starter_package_audit
  AFTER UPDATE ON public.tenants
  FOR EACH ROW
  EXECUTE FUNCTION public.aws_tenant_starter_package_audit_row();

-- 7) column guard (SQL 102's, plus the package columns for the platform owner) ----------
CREATE OR REPLACE FUNCTION public.aws_tenants_member_column_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_member_columns CONSTANT text[] := ARRAY[
    'name', 'logo_url', 'primary_color', 'secondary_color',
    'invoice_letterhead_url', 'invoice_footer_note', 'invoice_default_terms',
    'invoice_accent_color', 'invoice_theme',
    'company_address', 'company_phone', 'company_email', 'letterhead_url'
  ];
  v_allowed text[] := ARRAY['updated_at'];
  v_old jsonb := to_jsonb(OLD);
  v_changed text[];
BEGIN
  -- Only end-user requests are limited; RLS already refuses requests with no caller.
  IF NOT COALESCE(public.aws_is_authenticated(), false) THEN
    RETURN NEW;
  END IF;
  IF COALESCE(public.aws_is_tenant_member(OLD.id), false) THEN
    v_allowed := v_allowed || v_member_columns;
  END IF;
  IF COALESCE(public.is_platform_owner(), false) THEN
    v_allowed := v_allowed || public.aws_tenant_pricing_columns() || ARRAY['deposits_enabled']
      || public.aws_tenant_profile_columns() || ARRAY['moov_environment']
      || ARRAY['starter_package_enabled', 'starter_package_starts_on',
               'starter_package_maintenance_ends_on', 'starter_package_included_checks'];
    -- Test mode moves the ledger: moov_environment changes only together with
    -- is_test_account, and neither once the tenant has a Moov account (every path).
    IF (to_jsonb(NEW) -> 'moov_environment') IS DISTINCT FROM (v_old -> 'moov_environment')
       OR (to_jsonb(NEW) -> 'is_test_account') IS DISTINCT FROM (v_old -> 'is_test_account') THEN
      IF (to_jsonb(NEW) -> 'is_test_account') IS NOT DISTINCT FROM (v_old -> 'is_test_account') THEN
        RAISE EXCEPTION 'tenant_column_not_member_writable: moov_environment' USING ERRCODE = '42501';
      END IF;
      IF public.aws_tenant_has_moov_account(OLD.id) THEN
        RAISE EXCEPTION 'moov_environment_locked' USING ERRCODE = '55000', DETAIL = 'is_test_account';
      END IF;
    END IF;
  END IF;
  SELECT array_agg(n.key ORDER BY n.key) INTO v_changed
    FROM jsonb_each(to_jsonb(NEW)) AS n
   WHERE NOT (n.key = ANY (v_allowed))
     AND n.value IS DISTINCT FROM (v_old -> n.key);
  IF v_changed IS NOT NULL THEN
    RAISE EXCEPTION 'tenant_column_not_member_writable: %', array_to_string(v_changed, ', ')
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION public.aws_tenants_member_column_guard() IS
  'SQL 150 (replaces SQL 102): members change only display/branding/company-info columns; the platform owner only pricing columns, deposits_enabled, the profile fields (aws_tenant_profile_columns()), moov_environment and the Starter Package columns; everything else, slug and partner_code included, is refused (42501).';
