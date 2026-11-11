-- SQL 155: adopt the claim owner stamp production already runs (claims.trg_aws_stamp_claim_org_id).
-- AWS only: nothing under supabase/migrations changes.
--
-- Why: on 2026-11-11, after SQL 76, production's /db-readonly-validate still answered 503 for one public trigger that
-- no file on main defines: claims.trg_aws_stamp_claim_org_id. Its source is aws/rls/sql/39_claim_owner_org.sql on the
-- unmerged branch cursor/claim-ownership-invariant-7084 (PR #429, commit 6a05191a3, 2026-09-22), whose PR records it as
-- applied to production directly ("Isolated production SQL: trg_aws_stamp_claim_org_id applied"), before the guarded
-- path existed. Owner 2026-11-11: "Keep it, adopt it through the guarded path".
--
-- What this file does: everything after the prerequisite check below is that file's text from
-- "CREATE OR REPLACE FUNCTION public.aws_claim_owner_tenant_id()" to its end, byte for byte:
--   * public.aws_claim_owner_tenant_id() (plpgsql, STABLE, SECURITY DEFINER, search_path public, row_security off,
--     RETURNS uuid): the owning tenant for a new claim from auth.uid(): the tenant named by request.active_tenant_slug
--     when the user is a member of it (a UUID or malformed slug is ignored), else the user's one tenant_users row; more
--     than one membership and no usable slug is 22023 claim_owner_tenant_required; no user or no membership is NULL;
--   * public.aws_stamp_claim_org_id() (plpgsql, VOLATILE, SECURITY DEFINER, search_path public, row_security off,
--     RETURNS trigger): on UPDATE a non-null org_id is kept as it was; otherwise org_id is set from
--     aws_claim_owner_tenant_id(); with no owner a NULL org_id is 23502 claim_org_id_required, and a signed-in user who
--     is not a cross-tenant reader (aws_is_cross_tenant_reader) is 42501 claim_owner_tenant_required;
--   * the trigger trg_aws_stamp_claim_org_id BEFORE INSERT OR UPDATE ON public.claims FOR EACH ROW (DROP IF EXISTS,
--     then CREATE);
--   * EXECUTE: REVOKE ALL FROM PUBLIC on both functions, GRANT EXECUTE TO checksops, authenticated (as production has
--     it; a trigger function needs no EXECUTE grant to fire).
--
-- Not changed: no table, column, index, policy, RLS setting, table grant or existing row; no other function. Where
-- production already matches this file, applying it changes nothing.
--
-- Refuses to run (55000 sql155_prerequisite_missing) without public.claims.org_id, public.tenants (id, slug),
-- public.tenant_users (tenant_id, user_id), auth.uid(), public.aws_is_cross_tenant_reader() and the roles checksops and
-- authenticated, and (55000 sql155_definer_cannot_read) unless the applying login owns public.tenants and
-- public.tenant_users without FORCE ROW LEVEL SECURITY, or is a superuser or BYPASSRLS (the functions run with
-- row_security off, which refuses a query that row security would filter).
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL executor runs it
-- inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change: staging first, then production, through the
-- guarded SQL path (AGENTS.md).

DO $sql155_prerequisites$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_rel text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = to_regclass('public.claims') AND a.attname = 'org_id' AND NOT a.attisdropped) THEN
    v_missing := array_append(v_missing, 'public.claims.org_id');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = to_regclass('public.tenants') AND a.attname = 'slug' AND NOT a.attisdropped) THEN
    v_missing := array_append(v_missing, 'public.tenants.slug');
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_attribute a WHERE a.attrelid = to_regclass('public.tenant_users') AND a.attname IN ('tenant_id', 'user_id') AND NOT a.attisdropped) <> 2 THEN
    v_missing := array_append(v_missing, 'public.tenant_users(tenant_id, user_id)');
  END IF;
  IF to_regprocedure('auth.uid()') IS NULL THEN
    v_missing := array_append(v_missing, 'auth.uid()');
  END IF;
  IF to_regprocedure('public.aws_is_cross_tenant_reader()') IS NULL THEN
    v_missing := array_append(v_missing, 'public.aws_is_cross_tenant_reader()');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops') THEN
    v_missing := array_append(v_missing, 'role checksops');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'authenticated') THEN
    v_missing := array_append(v_missing, 'role authenticated');
  END IF;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'sql155_prerequisite_missing: %', array_to_string(v_missing, ', ') USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    FOREACH v_rel IN ARRAY ARRAY['public.tenants', 'public.tenant_users'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c
        WHERE c.oid = to_regclass(v_rel)
          AND c.relowner = (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)
          AND NOT c.relforcerowsecurity
      ) THEN
        RAISE EXCEPTION 'sql155_definer_cannot_read: %', v_rel USING ERRCODE = '55000';
      END IF;
    END LOOP;
  END IF;
END
$sql155_prerequisites$;

CREATE OR REPLACE FUNCTION public.aws_claim_owner_tenant_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  _uid uuid;
  _slug text;
  _tenant uuid;
  _memberships int;
BEGIN
  _uid := auth.uid();
  IF _uid IS NULL THEN
    RETURN NULL;
  END IF;

  _slug := nullif(btrim(lower(coalesce(current_setting('request.active_tenant_slug', true), ''))), '');
  -- Never treat a client UUID as a tenant selector.
  IF _slug IS NOT NULL AND _slug ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    _slug := NULL;
  END IF;
  IF _slug IS NOT NULL AND _slug !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' THEN
    _slug := NULL;
  END IF;

  IF _slug IS NOT NULL THEN
    SELECT t.id INTO _tenant
    FROM public.tenants t
    JOIN public.tenant_users tu ON tu.tenant_id = t.id
    WHERE tu.user_id = _uid
      AND lower(t.slug) = _slug
    LIMIT 1;
    IF _tenant IS NOT NULL THEN
      RETURN _tenant;
    END IF;
  END IF;

  SELECT COUNT(DISTINCT tu.tenant_id)
    INTO _memberships
  FROM public.tenant_users tu
  WHERE tu.user_id = _uid;

  IF coalesce(_memberships, 0) = 1 THEN
    SELECT tu.tenant_id INTO _tenant
    FROM public.tenant_users tu
    WHERE tu.user_id = _uid
    LIMIT 1;
    RETURN _tenant;
  END IF;

  IF coalesce(_memberships, 0) > 1 THEN
    RAISE EXCEPTION 'claim_owner_tenant_required'
      USING ERRCODE = '22023',
            HINT = 'Set request.active_tenant_slug to a tenant the user belongs to.';
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.aws_claim_owner_tenant_id() IS
  'Owning tenant for a new claim: membership-checked request.active_tenant_slug, else the user''s single tenant_users row. Never reads client org_id.';

CREATE OR REPLACE FUNCTION public.aws_stamp_claim_org_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  _owner uuid;
BEGIN
  -- Existing ownership is immutable through this path. Share/revoke must not
  -- change claims.org_id, and client UPDATEs cannot reassign a claim.
  IF TG_OP = 'UPDATE' AND OLD.org_id IS NOT NULL THEN
    NEW.org_id := OLD.org_id;
    RETURN NEW;
  END IF;

  _owner := public.aws_claim_owner_tenant_id();
  IF _owner IS NOT NULL THEN
    NEW.org_id := _owner;
    RETURN NEW;
  END IF;

  -- Admin / unauthenticated / no-membership INSERT: require an explicit owner.
  -- Do not persist NULL through a normal creation path.
  IF NEW.org_id IS NULL THEN
    RAISE EXCEPTION 'claim_org_id_required'
      USING ERRCODE = '23502',
            HINT = 'Authenticated tenant users receive org_id from membership; admin INSERT must supply org_id.';
  END IF;

  IF auth.uid() IS NOT NULL
     AND NOT public.aws_is_cross_tenant_reader() THEN
    RAISE EXCEPTION 'claim_owner_tenant_required'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.aws_stamp_claim_org_id() IS
  'BEFORE INSERT/UPDATE: stamp claims.org_id from aws_claim_owner_tenant_id(); preserve existing org_id on UPDATE; reject NULL for tenant users.';

DROP TRIGGER IF EXISTS trg_aws_stamp_claim_org_id ON public.claims;
CREATE TRIGGER trg_aws_stamp_claim_org_id
  BEFORE INSERT OR UPDATE ON public.claims
  FOR EACH ROW
  EXECUTE FUNCTION public.aws_stamp_claim_org_id();

REVOKE ALL ON FUNCTION public.aws_claim_owner_tenant_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_stamp_claim_org_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_claim_owner_tenant_id() TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_stamp_claim_org_id() TO checksops, authenticated;
