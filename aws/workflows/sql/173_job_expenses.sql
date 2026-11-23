-- SQL 173: job costs paid outside ChecksOps, recorded against an insurance job (a claim) or a cash job, so per-job
-- profit can include them. AWS only: nothing under supabase/migrations changes.
--
-- Why (owner 2026-11-23): "Proceed with the per job build. Make sure it is for insurance jobs and cash jobs". Step 3 of
-- the agreed per-job design: a tenant records what a job cost that was paid outside ChecksOps (materials on a supplier
-- account, card purchases, permits, dumpsters, labor) against the job, an insurance job (a public.claims row) or a cash
-- job (a public.cash_jobs row). Nothing in ChecksOps records such a cost today: disbursement splits (SQL 147) are
-- payments out of a check, not job costs. This file is where the API keeps them; the API route and the website that
-- write and show them are later, separate steps.
--
-- What this file does:
-- 1) A new table public.job_expenses, one row per recorded expense:
--      id uuid PRIMARY KEY DEFAULT gen_random_uuid(); tenant_id uuid NOT NULL (the organization that paid it);
--      claim_id uuid REFERENCES public.claims(id) ON DELETE CASCADE, cash_job_id uuid REFERENCES public.cash_jobs(id)
--      ON DELETE CASCADE, exactly one of the two set (job_expenses_one_job); category text NOT NULL, one of materials,
--      labor, subcontractor, permit, equipment, other; amount_cents bigint NOT NULL, 1 to 100000000000 (one billion
--      dollars); expense_date date NOT NULL; paid_to text (<= 200); paid_by text, NULL or one of company_card,
--      supplier_account, cash, check, ach, other; notes text (<= 2000); receipt_path text (<= 500); created_by uuid;
--      created_at, updated_at timestamptz NOT NULL DEFAULT now(); deleted_at timestamptz, deleted_by uuid (a removed
--      expense is kept, soft-deleted); idempotency_key text (NULL, or 8-100 characters [A-Za-z0-9_:-], SQL 147's rule),
--      unique per tenant (partial unique index job_expenses_tenant_idempotency_key WHERE idempotency_key IS NOT NULL).
--    Two indexes for a job's live expenses: (tenant_id, claim_id) and (tenant_id, cash_job_id), WHERE deleted_at IS
--    NULL. ON DELETE CASCADE as every claim child table in supabase/migrations: deleting a job (the cash job delete of
--    /data/write, a claim) removes its expenses with it instead of failing on the reference.
--    ROW LEVEL SECURITY on. One SELECT policy, aws_select_job_expenses, TO authenticated, exactly the tenant-scoped
--    SELECT policy of aws/rls/sql/12_final_select_policies.sql (aws_is_cross_tenant_reader() OR
--    aws_can_access_tenant(tenant_id): the tenant's members and the platform owner). No INSERT, UPDATE or DELETE
--    policy. Grants: every non-owner grant revoked (the database's default privileges for a new table included, as SQL
--    118 and SQL 141), then SELECT only to checksops and authenticated. Every write goes through the two functions.
-- 2) Two new functions (plpgsql, VOLATILE, SECURITY DEFINER, search_path = public, row_security = off, owned by the
--    applying login like the other aws/workflows/sql DEFINER functions; EXECUTE revoked from PUBLIC, anon,
--    authenticated and service_role where they exist, granted to checksops only). Nothing existing is replaced.
--      a) public.aws_job_expense_add(p_tenant_id uuid, p_claim_id uuid, p_cash_job_id uuid, p_category text,
--         p_amount_cents bigint, p_expense_date date, p_paid_to text, p_paid_by text, p_notes text,
--         p_receipt_path text, p_idempotency_key text, p_user_id uuid) RETURNS jsonb:
--           caller: p_user_id is the signed-in user (auth.uid(), request.app_user_id as the API sets it, as SQL 133
--             and SQL 156 check a passed user id) and a member of p_tenant_id (public.aws_can_write_tenant, SQL 90:
--             membership only, SQL 147's rule; the platform owner, partners and other tenants are refused), else
--             42501 job_expense_forbidden;
--           inputs (22023 job_expense_invalid: <what>): exactly one of the claim and the cash job (job); the category
--             and paid_by (trimmed, lower case) in their lists; amount_cents 1 to 100000000000; expense_date present;
--             paid_to, notes and receipt_path trimmed (blank is NULL) within their lengths; the idempotency key NULL
--             or SQL 147's shape;
--           the job: a cash job whose tenant_id is p_tenant_id, or a claim of p_tenant_id by the API's own rule
--             (aws/functions/api/tenant-library.mjs claimBelongsToTenant: claims.org_id is the tenant, or org_id is
--             NULL and one of the tenant's checks, check_intake_items.tenant_id, carries the claim_id), else P0002
--             job_expense_job_not_found (the same answer for another tenant's job: tenant isolation);
--           idempotency: a key already recorded for the tenant with the same expense returns that row with duplicate
--             true and writes nothing; the key with a different expense is 23505 job_expense_key_reused (a race on
--             the key resolves on the unique index the same way);
--           writes one row (created_by p_user_id) and returns {expense: the row, duplicate}.
--      b) public.aws_job_expense_delete(p_tenant_id uuid, p_expense_id uuid, p_user_id uuid) RETURNS boolean: the
--         same caller check (42501 job_expense_forbidden); soft-deletes the tenant's live expense (deleted_at and
--         updated_at now(), deleted_by p_user_id); returns whether one was removed (false for an unknown id, another
--         tenant's expense or one already removed).
--
-- Not changed: no existing table, column, constraint, index, trigger, policy, grant, function or row; claims,
-- cash_jobs and check_intake_items are only read (the two foreign keys add PostgreSQL's internal referential triggers
-- on claims and cash_jobs, as SQL 141's do on tenants). Nothing reads the table until the API does.
--
-- Refuses (55000):
--   sql173_prerequisite_missing     public.claims, public.cash_jobs, public.check_intake_items, public.tenant_users,
--                                   the columns the functions read, SQL 90's aws_can_write_tenant(uuid),
--                                   aws_can_access_tenant(uuid), aws_is_cross_tenant_reader(), auth.uid(),
--                                   gen_random_uuid() or the role checksops or authenticated is missing;
--   sql173_definer_cannot_read      the applying login does not own claims, cash_jobs and check_intake_items without
--                                   FORCE ROW LEVEL SECURITY and is neither a superuser nor BYPASSRLS (a DEFINER
--                                   filtered by row security could not find the job);
--   sql173_unexpected_table         a public.job_expenses table already exists with other columns than this file
--                                   creates.
-- The release engine (release-sql-specs.mjs) additionally refuses before the file runs when the table or a function
-- already exists other than as intended. When every object is already in place it notices sql173_already_current.
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS, DROP POLICY IF EXISTS before CREATE POLICY, the ACL reset, CREATE OR
-- REPLACE FUNCTION; a REVOKE or GRANT already in place is a no-op.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL executor runs it
-- inside one transaction.
--
-- NOT APPLIED. Apply only through the guarded SQL path (AGENTS.md) after a read-only inspect, staging first.

DO $sql173_prereq$
DECLARE
  v_missing text[];
  v_cols text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.claims', pg_catalog.to_regclass('public.claims')::oid),
      ('public.cash_jobs', pg_catalog.to_regclass('public.cash_jobs')::oid),
      ('public.check_intake_items', pg_catalog.to_regclass('public.check_intake_items')::oid),
      ('public.tenant_users', pg_catalog.to_regclass('public.tenant_users')::oid),
      ('public.aws_can_write_tenant(uuid)', pg_catalog.to_regprocedure('public.aws_can_write_tenant(uuid)')::oid),
      ('public.aws_can_access_tenant(uuid)', pg_catalog.to_regprocedure('public.aws_can_access_tenant(uuid)')::oid),
      ('public.aws_is_cross_tenant_reader()', pg_catalog.to_regprocedure('public.aws_is_cross_tenant_reader()')::oid),
      ('auth.uid()', pg_catalog.to_regprocedure('auth.uid()')::oid),
      ('gen_random_uuid()', pg_catalog.to_regprocedure('gen_random_uuid()')::oid),
      ('role checksops', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops')),
      ('role authenticated', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'authenticated'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    -- pg_attribute, not information_schema.columns: the latter lists only the columns the applying login holds a
    -- privilege on.
    SELECT array_agg('column public.' || want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (VALUES
      ('cash_jobs', 'id'), ('cash_jobs', 'tenant_id'),
      ('check_intake_items', 'claim_id'), ('check_intake_items', 'tenant_id'),
      ('claims', 'id'), ('claims', 'org_id'),
      ('tenant_users', 'tenant_id'), ('tenant_users', 'user_id')) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = pg_catalog.to_regclass('public.' || want.tbl) AND a.attname = want.col AND a.attnum > 0
         AND NOT a.attisdropped
    );
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql173_prerequisite_missing: %', array_to_string(v_missing, ', ') USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class t
    JOIN pg_catalog.pg_roles me ON me.rolname = current_user
    WHERE t.oid IN ('public.claims'::regclass, 'public.cash_jobs'::regclass, 'public.check_intake_items'::regclass)
      AND NOT (me.rolsuper OR me.rolbypassrls
               OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity))
  ) THEN
    RAISE EXCEPTION 'sql173_definer_cannot_read: the applying login must own public.claims, public.cash_jobs and public.check_intake_items (no FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS'
      USING ERRCODE = '55000';
  END IF;

  IF pg_catalog.to_regclass('public.job_expenses') IS NOT NULL THEN
    SELECT array_agg(a.attname::text ORDER BY a.attname) INTO v_cols
    FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.job_expenses'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
    IF v_cols IS DISTINCT FROM ARRAY['amount_cents', 'cash_job_id', 'category', 'claim_id', 'created_at', 'created_by',
                                     'deleted_at', 'deleted_by', 'expense_date', 'id', 'idempotency_key', 'notes',
                                     'paid_by', 'paid_to', 'receipt_path', 'tenant_id', 'updated_at']::text[] THEN
      RAISE EXCEPTION 'sql173_unexpected_table: public.job_expenses has columns %', v_cols USING ERRCODE = '55000';
    END IF;
    IF pg_catalog.to_regprocedure('public.aws_job_expense_add(uuid, uuid, uuid, text, bigint, date, text, text, text, text, text, uuid)') IS NOT NULL
       AND pg_catalog.to_regprocedure('public.aws_job_expense_delete(uuid, uuid, uuid)') IS NOT NULL THEN
      RAISE NOTICE 'sql173_already_current';
    END IF;
  END IF;
END
$sql173_prereq$;

-- 1) Job expenses paid outside ChecksOps.
CREATE TABLE IF NOT EXISTS public.job_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  claim_id uuid REFERENCES public.claims(id) ON DELETE CASCADE,
  cash_job_id uuid REFERENCES public.cash_jobs(id) ON DELETE CASCADE,
  category text NOT NULL,
  amount_cents bigint NOT NULL,
  expense_date date NOT NULL,
  paid_to text,
  paid_by text,
  notes text,
  receipt_path text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  idempotency_key text,
  CONSTRAINT job_expenses_one_job CHECK (num_nonnulls(claim_id, cash_job_id) = 1),
  CONSTRAINT job_expenses_category CHECK (category IN ('materials', 'labor', 'subcontractor', 'permit', 'equipment', 'other')),
  CONSTRAINT job_expenses_amount CHECK (amount_cents > 0 AND amount_cents <= 100000000000),
  CONSTRAINT job_expenses_paid_by CHECK (paid_by IN ('company_card', 'supplier_account', 'cash', 'check', 'ach', 'other')),
  CONSTRAINT job_expenses_text_lengths CHECK (length(paid_to) <= 200 AND length(notes) <= 2000 AND length(receipt_path) <= 500),
  CONSTRAINT job_expenses_idempotency_key_shape CHECK (idempotency_key ~ '^[A-Za-z0-9_:-]{8,100}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS job_expenses_tenant_idempotency_key
  ON public.job_expenses (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS job_expenses_tenant_claim_idx
  ON public.job_expenses (tenant_id, claim_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS job_expenses_tenant_cash_job_idx
  ON public.job_expenses (tenant_id, cash_job_id) WHERE deleted_at IS NULL;
ALTER TABLE public.job_expenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aws_select_job_expenses ON public.job_expenses;
CREATE POLICY aws_select_job_expenses ON public.job_expenses
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader() OR public.aws_can_access_tenant(tenant_id));
-- No grant but the owner's (the default privileges of a new table included), then SELECT for checksops and
-- authenticated.
DO $sql173_table_acl$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT a.grantee
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    WHERE c.oid = 'public.job_expenses'::regclass
      AND a.grantee <> c.relowner
  LOOP
    IF r.grantee = 0 THEN
      EXECUTE 'REVOKE ALL ON TABLE public.job_expenses FROM PUBLIC';
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE public.job_expenses FROM %I', pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END
$sql173_table_acl$;
GRANT SELECT ON TABLE public.job_expenses TO checksops, authenticated;
COMMENT ON TABLE public.job_expenses IS
  'SQL 173: job costs paid outside ChecksOps (materials, labor, subcontractor, permit, equipment, other) against an insurance job (claim_id) or a cash job (cash_job_id), for per-job profit. Soft-deleted (deleted_at). Written only through aws_job_expense_add / aws_job_expense_delete; members read their tenant''s rows.';

-- 2a) A member records an expense against one of the tenant's jobs.
CREATE OR REPLACE FUNCTION public.aws_job_expense_add(
  p_tenant_id uuid,
  p_claim_id uuid,
  p_cash_job_id uuid,
  p_category text,
  p_amount_cents bigint,
  p_expense_date date,
  p_paid_to text,
  p_paid_by text,
  p_notes text,
  p_receipt_path text,
  p_idempotency_key text,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_category text := lower(btrim(COALESCE(p_category, '')));
  v_paid_by text := NULLIF(lower(btrim(COALESCE(p_paid_by, ''))), '');
  v_paid_to text := NULLIF(btrim(COALESCE(p_paid_to, '')), '');
  v_notes text := NULLIF(btrim(COALESCE(p_notes, '')), '');
  v_receipt text := NULLIF(btrim(COALESCE(p_receipt_path, '')), '');
  v_row public.job_expenses%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_user_id IS DISTINCT FROM auth.uid() OR p_tenant_id IS NULL
     OR NOT COALESCE(public.aws_can_write_tenant(p_tenant_id), false) THEN
    RAISE EXCEPTION 'job_expense_forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_idempotency_key IS NOT NULL AND p_idempotency_key !~ '^[A-Za-z0-9_:-]{8,100}$' THEN
    RAISE EXCEPTION 'job_expense_invalid: idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF num_nonnulls(p_claim_id, p_cash_job_id) <> 1 THEN
    RAISE EXCEPTION 'job_expense_invalid: job' USING ERRCODE = '22023';
  END IF;
  IF v_category NOT IN ('materials', 'labor', 'subcontractor', 'permit', 'equipment', 'other') THEN
    RAISE EXCEPTION 'job_expense_invalid: category' USING ERRCODE = '22023';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_amount_cents > 100000000000 THEN
    RAISE EXCEPTION 'job_expense_invalid: amount_cents' USING ERRCODE = '22023';
  END IF;
  IF p_expense_date IS NULL THEN
    RAISE EXCEPTION 'job_expense_invalid: expense_date' USING ERRCODE = '22023';
  END IF;
  IF v_paid_by IS NOT NULL AND v_paid_by NOT IN ('company_card', 'supplier_account', 'cash', 'check', 'ach', 'other') THEN
    RAISE EXCEPTION 'job_expense_invalid: paid_by' USING ERRCODE = '22023';
  END IF;
  IF length(COALESCE(v_paid_to, '')) > 200 THEN
    RAISE EXCEPTION 'job_expense_invalid: paid_to' USING ERRCODE = '22023';
  END IF;
  IF length(COALESCE(v_notes, '')) > 2000 THEN
    RAISE EXCEPTION 'job_expense_invalid: notes' USING ERRCODE = '22023';
  END IF;
  IF length(COALESCE(v_receipt, '')) > 500 THEN
    RAISE EXCEPTION 'job_expense_invalid: receipt_path' USING ERRCODE = '22023';
  END IF;

  -- The job belongs to the tenant: a cash job by its tenant_id; a claim by claimBelongsToTenant's rule (org_id, or no
  -- org_id and one of the tenant's checks carries it).
  IF p_cash_job_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.cash_jobs j WHERE j.id = p_cash_job_id AND j.tenant_id = p_tenant_id) THEN
      RAISE EXCEPTION 'job_expense_job_not_found' USING ERRCODE = 'P0002';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.claims c
     WHERE c.id = p_claim_id
       AND (c.org_id = p_tenant_id
            OR (c.org_id IS NULL AND EXISTS (
                  SELECT 1 FROM public.check_intake_items i
                   WHERE i.claim_id = c.id AND i.tenant_id = p_tenant_id)))
  ) THEN
    RAISE EXCEPTION 'job_expense_job_not_found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.job_expenses AS e
    (tenant_id, claim_id, cash_job_id, category, amount_cents, expense_date, paid_to, paid_by, notes, receipt_path,
     created_by, idempotency_key)
  VALUES (p_tenant_id, p_claim_id, p_cash_job_id, v_category, p_amount_cents, p_expense_date, v_paid_to, v_paid_by,
          v_notes, v_receipt, p_user_id, p_idempotency_key)
  ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
  RETURNING e.* INTO v_row;
  IF FOUND THEN
    RETURN jsonb_build_object('expense', to_jsonb(v_row), 'duplicate', false);
  END IF;

  -- The key is already recorded for the tenant: the same expense is a repeat, anything else a reused key.
  SELECT * INTO v_row FROM public.job_expenses e
   WHERE e.tenant_id = p_tenant_id AND e.idempotency_key = p_idempotency_key;
  IF v_row.claim_id IS DISTINCT FROM p_claim_id
     OR v_row.cash_job_id IS DISTINCT FROM p_cash_job_id
     OR v_row.category IS DISTINCT FROM v_category
     OR v_row.amount_cents IS DISTINCT FROM p_amount_cents
     OR v_row.expense_date IS DISTINCT FROM p_expense_date
     OR v_row.paid_to IS DISTINCT FROM v_paid_to
     OR v_row.paid_by IS DISTINCT FROM v_paid_by
     OR v_row.notes IS DISTINCT FROM v_notes
     OR v_row.receipt_path IS DISTINCT FROM v_receipt THEN
    RAISE EXCEPTION 'job_expense_key_reused' USING ERRCODE = '23505';
  END IF;
  RETURN jsonb_build_object('expense', to_jsonb(v_row), 'duplicate', true);
END
$$;

-- 2b) A member removes (soft-deletes) one of the tenant's expenses.
CREATE OR REPLACE FUNCTION public.aws_job_expense_delete(p_tenant_id uuid, p_expense_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_user_id IS NULL OR p_user_id IS DISTINCT FROM auth.uid() OR p_tenant_id IS NULL
     OR NOT COALESCE(public.aws_can_write_tenant(p_tenant_id), false) THEN
    RAISE EXCEPTION 'job_expense_forbidden' USING ERRCODE = '42501';
  END IF;
  UPDATE public.job_expenses e
     SET deleted_at = now(), deleted_by = p_user_id, updated_at = now()
   WHERE e.id = p_expense_id AND e.tenant_id = p_tenant_id AND e.deleted_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END
$$;

REVOKE ALL ON FUNCTION public.aws_job_expense_add(uuid, uuid, uuid, text, bigint, date, text, text, text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_job_expense_delete(uuid, uuid, uuid) FROM PUBLIC;

DO $sql173_revoke$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.aws_job_expense_add(uuid, uuid, uuid, text, bigint, date, text, text, text, text, text, uuid) FROM %I', v_role);
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.aws_job_expense_delete(uuid, uuid, uuid) FROM %I', v_role);
    END IF;
  END LOOP;
END
$sql173_revoke$;

GRANT EXECUTE ON FUNCTION public.aws_job_expense_add(uuid, uuid, uuid, text, bigint, date, text, text, text, text, text, uuid) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_job_expense_delete(uuid, uuid, uuid) TO checksops;
COMMENT ON FUNCTION public.aws_job_expense_add(uuid, uuid, uuid, text, bigint, date, text, text, text, text, text, uuid) IS
  'SQL 173: a tenant member (p_user_id = auth.uid(), aws_can_write_tenant) records a job cost paid outside ChecksOps against one of the tenant''s claims or cash jobs; idempotent on the key. checksops only.';
COMMENT ON FUNCTION public.aws_job_expense_delete(uuid, uuid, uuid) IS
  'SQL 173: a tenant member soft-deletes one of the tenant''s job expenses. checksops only.';
