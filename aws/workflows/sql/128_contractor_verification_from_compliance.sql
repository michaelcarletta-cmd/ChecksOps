-- SQL 128: contractor verification reads the Compliance & Docs uploads instead of the
-- dropped contractor_documents table.
--
-- Why: public.contractor_verification_status(uuid) was restored onto the AWS databases
-- from supabase migration 20260709105400. It reads public.contractor_documents, which
-- supabase migration 20260826140740 dropped on purpose (contractors upload their W-9 and
-- insurance on Settings > Compliance & Docs instead). Every call now fails with "relation
-- public.contractor_documents does not exist", and so does everything that calls it: the
-- Find-a-Pro "Verification status" card, the OPS Badge dialog, the OPS approve/revoke
-- route (aws/functions/api/workflow-rpc.mjs reads the status back), and every
-- contractor_reviews insert, update or delete (trigger recompute_tier_on_reviews ->
-- recompute_contractor_tier -> contractor_verification_status). Owner decision
-- 2026-10-30: read the Compliance & Docs uploads ("B").
--
-- 1) contractor_verification_status(uuid) replaced with the same name, argument, result
--    (jsonb, the same keys), language, volatility (STABLE), SECURITY DEFINER and
--    search_path (public). The body is the supabase body with only the two document
--    checks changed. The contractor's tenants are the tenant_users rows of the profile's
--    user_id (contractor_profiles has no tenant_id); a document counts when one of those
--    tenants uploaded it on Compliance & Docs:
--      w9_on_file:  a moov_compliance_documents row with purpose 'w9' and status
--                   'stored' or 'sent' (verified and kept; 'pending_upload' and
--                   'rejected' do not count), or a tenant_documents row with doc_type
--                   'library:mortgage:w-9' or the legacy 'w9';
--      coi_current: the same with purpose 'insurance', or a tenant_documents row with
--                   doc_type 'library:mortgage:certificate-of-insurance',
--                   'library:mortgage:general-liability-insurance',
--                   'library:mortgage:workers-comp-insurance' or the legacy 'insurance'
--                   whose expires_at is empty or not past.
--    moov_compliance_documents has no expiry date, so a stored insurance upload counts
--    as current. Its environment (sandbox or production) is not filtered: each database
--    serves one runtime, and a document is on file whichever Moov environment it was
--    uploaded for. The supabase W-9 check matched any contractor's 'w9%' row (its OR was
--    not inside the contractor filter); every check here is scoped to the contractor's
--    own tenants.
-- 2) EXECUTE on contractor_verification_status: revoked from PUBLIC and from anon,
--    authenticated and service_role where those roles exist; granted to checksops (the
--    API login). The owner keeps its own (recompute_contractor_tier and
--    admin_set_contractor_pro run as the owner). The function has no caller gate: the
--    API gates it (aws/functions/api/data.mjs RPC_ACCESS_GATES, the profile's own user or
--    a cross-tenant reader), and the review and profile triggers call it for whoever
--    wrote the row.
-- 3) public._trg_recompute_contractor_tier_from_docs() dropped if present: its trigger
--    went with contractor_documents, nothing calls it.
--
-- Not changed: recompute_contractor_tier, admin_set_contractor_pro, the review and
-- profile trigger functions and triggers, contractor_profiles, contractor_reviews,
-- moov_compliance_documents, tenant_documents (no table, column, policy, trigger, grant
-- on a table, or row), and the Compliance & Docs upload routes.
-- Refuses to run (55000 sql128_prerequisite_missing) without the function, the tables
-- and columns it reads, and role checksops.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the
-- guarded SQL executor runs it inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change.

DO $sql128_prereq$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.contractor_verification_status(uuid)', to_regprocedure('public.contractor_verification_status(uuid)')::oid),
      ('public.contractor_profiles', to_regclass('public.contractor_profiles')::oid),
      ('public.contractor_reviews', to_regclass('public.contractor_reviews')::oid),
      ('public.tenant_users', to_regclass('public.tenant_users')::oid),
      ('public.moov_compliance_documents', to_regclass('public.moov_compliance_documents')::oid),
      ('public.tenant_documents', to_regclass('public.tenant_documents')::oid)
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg(n.name ORDER BY n.name) INTO v_missing
    FROM (
      VALUES
        ('contractor_profiles', 'id'), ('contractor_profiles', 'user_id'),
        ('contractor_profiles', 'tier'), ('contractor_profiles', 'license_number'),
        ('contractor_profiles', 'admin_disbursed_verified'), ('contractor_profiles', 'has_open_disputes'),
        ('contractor_profiles', 'created_at'), ('contractor_profiles', 'verified_at'),
        ('contractor_profiles', 'pro_approved_at'),
        ('contractor_reviews', 'contractor_id'), ('contractor_reviews', 'rating'),
        ('tenant_users', 'user_id'), ('tenant_users', 'tenant_id'),
        ('moov_compliance_documents', 'tenant_id'), ('moov_compliance_documents', 'purpose'),
        ('moov_compliance_documents', 'status'),
        ('tenant_documents', 'tenant_id'), ('tenant_documents', 'doc_type'),
        ('tenant_documents', 'expires_at')
    ) AS req(tbl, col)
    CROSS JOIN LATERAL (SELECT 'column public.' || req.tbl || '.' || req.col AS name) n
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = req.tbl AND c.column_name = req.col
    );
  END IF;
  IF v_missing IS NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'checksops') THEN
    v_missing := ARRAY['role checksops'];
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql128_prerequisite_missing: SQL 128 needs %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;
END
$sql128_prereq$;

-- 1) contractor_verification_status, as supabase 20260709105400 defines it but for the
--    two document checks.
CREATE OR REPLACE FUNCTION public.contractor_verification_status(p_contractor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile      public.contractor_profiles;
  v_w9           boolean := false;
  v_coi_ok       boolean := false;
  v_license_ok   boolean := false;
  v_review_count int := 0;
  v_avg_rating   numeric := 0;
  v_days         int := 0;
  v_eligible_verified boolean := false;
  v_eligible_pro      boolean := false;
BEGIN
  SELECT * INTO v_profile FROM public.contractor_profiles WHERE id = p_contractor_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- SQL 128: the W-9 and insurance the contractor's tenants uploaded on Compliance & Docs.
  SELECT EXISTS (
    SELECT 1 FROM public.moov_compliance_documents d
    WHERE d.tenant_id IN (SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = v_profile.user_id)
      AND d.purpose = 'w9'
      AND d.status IN ('stored', 'sent')
  ) OR EXISTS (
    SELECT 1 FROM public.tenant_documents t
    WHERE t.tenant_id IN (SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = v_profile.user_id)
      AND t.doc_type IN ('library:mortgage:w-9', 'w9')
  ) INTO v_w9;

  SELECT EXISTS (
    SELECT 1 FROM public.moov_compliance_documents d
    WHERE d.tenant_id IN (SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = v_profile.user_id)
      AND d.purpose = 'insurance'
      AND d.status IN ('stored', 'sent')
  ) OR EXISTS (
    SELECT 1 FROM public.tenant_documents t
    WHERE t.tenant_id IN (SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = v_profile.user_id)
      AND t.doc_type IN (
        'library:mortgage:certificate-of-insurance',
        'library:mortgage:general-liability-insurance',
        'library:mortgage:workers-comp-insurance',
        'insurance'
      )
      AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
  ) INTO v_coi_ok;

  v_license_ok := v_profile.license_number IS NOT NULL AND length(trim(v_profile.license_number)) > 0;

  SELECT count(*), COALESCE(avg(rating), 0)
    INTO v_review_count, v_avg_rating
  FROM public.contractor_reviews
  WHERE contractor_id = p_contractor_id;

  v_days := GREATEST(0, EXTRACT(day FROM (now() - v_profile.created_at))::int);

  v_eligible_verified := v_w9 AND v_coi_ok AND v_license_ok;
  v_eligible_pro := v_eligible_verified
    AND v_profile.admin_disbursed_verified
    AND NOT v_profile.has_open_disputes
    AND v_review_count >= 5
    AND v_avg_rating >= 4.5
    AND v_days >= 90;

  RETURN jsonb_build_object(
    'found', true,
    'current_tier', v_profile.tier,
    'checks', jsonb_build_object(
      'w9_on_file', v_w9,
      'coi_current', v_coi_ok,
      'license_on_file', v_license_ok,
      'admin_payment_attested', v_profile.admin_disbursed_verified,
      'no_open_disputes', NOT v_profile.has_open_disputes,
      'review_count', v_review_count,
      'review_count_ok', v_review_count >= 5,
      'avg_rating', v_avg_rating,
      'avg_rating_ok', v_avg_rating >= 4.5,
      'days_on_platform', v_days,
      'days_on_platform_ok', v_days >= 90
    ),
    'eligible_verified', v_eligible_verified,
    'eligible_pro', v_eligible_pro,
    'verified_at', v_profile.verified_at,
    'pro_approved_at', v_profile.pro_approved_at
  );
END;
$$;

-- 2) EXECUTE for checksops and the owner only.
REVOKE ALL ON FUNCTION public.contractor_verification_status(uuid) FROM PUBLIC;

DO $sql128_acl$
DECLARE
  grantee text;
BEGIN
  FOREACH grantee IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = grantee) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.contractor_verification_status(uuid) FROM %I', grantee);
    END IF;
  END LOOP;
END
$sql128_acl$;

GRANT EXECUTE ON FUNCTION public.contractor_verification_status(uuid) TO checksops;

-- 3) The orphaned contractor_documents trigger function.
DROP FUNCTION IF EXISTS public._trg_recompute_contractor_tier_from_docs();
