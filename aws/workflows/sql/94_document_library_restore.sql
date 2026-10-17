-- AWS: Document Library restore (SQL 94).
-- Forward, idempotent migration. Do not apply from this branch; guarded tooling
-- for SQL 94 is a follow-up (SQL 29 and SQL 30 have theirs). Apply order:
--   aws/rls/sql/29_mortgage_ops_library_parity.sql
--   aws/rls/sql/30_tenant_documents_mortgage_doc_type.sql (optional: this file
--     accepts either SQL 30's CHECK or the 3/6-value Supabase predecessors)
--   aws/workflows/sql/90_users_only_tenant_roles.sql
--   aws/workflows/sql/94_document_library_restore.sql (this file)
-- Refuses (55000 sql94_prerequisite_missing) when an object it reads is absent.
--
-- Owner policy: every member of a tenant (any tenant_users row) is an equal
-- user; tenant_users.role is ignored. Partners and other tenants get nothing.
-- The platform owner does not write tenants' libraries or shares.
--
-- 1) tenant_documents.doc_type CHECK. The Document Library stores
--    doc_type = library:<category>:<slug>. The live CHECK (Supabase migration
--    20260709153833, 6 legacy values; SQL 30 adds the 7 canonical Mortgage
--    Ops values) refused template, shingle, siding, catalog and letterhead,
--    so no library upload ever saved on AWS. The new CHECK calls
--    public.aws_tenant_document_doc_type_ok(text) (IMMUTABLE, pure):
--      - the 6 legacy values (w9, license, insurance, saas_agreement,
--        terms_of_service, privacy_policy);
--      - the 7 canonical library:mortgage:* values (exactly SQL 30's set; no
--        free mortgage suffix);
--      - library:(template|shingle|siding|catalog|letterhead):<slug> where
--        slug matches ^[a-z0-9]+(-[a-z0-9]+)*$ and is at most 60 characters.
--    Mirrors aws/functions/api/mortgage-library-doc-types.mjs
--    (isAllowedTenantDocumentDocType). Accepted predecessors: the 3-value and
--    6-value IN lists and SQL 30's 13-value list; anything else refuses
--    (sql94_unsupported_doc_type_check). Rows that would violate the new
--    CHECK refuse (sql94_invalid_rows); no row is rewritten.
--
-- 2) public.homeowner_shared_documents: per-claim sharing of one library
--    document with that claim's homeowner (HomeownerOps link). Replaces the
--    old tenant-wide tenant_documents.shared_with_homeowners exposure (the
--    Supabase view listed every flagged tenant document on every ledger link
--    with 24h URLs). That column is left as it is and is no longer read or
--    written by the application. A guard trigger keeps every row inside one
--    tenant: the document is the row tenant's own non-mortgage library
--    document, the claim belongs to that tenant (claims.org_id = tenant, or
--    org_id IS NULL and one of the tenant's checks references the claim:
--    the SQL 87/88 rule), and an UPDATE may only set revoked_at / revoked_by
--    once. RLS: members of the row's tenant read and write; nobody deletes.
--
-- 3) public.aws_public_homeowner_shared_documents(token) and
--    public.aws_public_homeowner_shared_document(token, shared_id): SECURITY
--    DEFINER readers for the public ledger. Token rules are SQL 82/83's:
--    invalid / revoked / expired / unbound claim fail closed, and claim_ok is
--    copied from SQL 82. They return metadata (file name, MIME type, size,
--    category) for the token's own claim and tenant only, never another
--    claim's share, a revoked share, or a document of another tenant. The
--    second returns the stored path so the Lambda can mint a <=5 minute GET
--    URL; the ledger view itself never carries a URL or path. EXECUTE for
--    checksops only. SQL 82 is not rewritten: the Lambda attaches the list
--    to shared_documents, as it does for SQL 83's pending_signatures.

DO $sql94_prereq$
BEGIN
  IF to_regclass('public.tenant_documents') IS NULL
     OR to_regclass('public.tenant_users') IS NULL
     OR to_regclass('public.claims') IS NULL
     OR to_regclass('public.check_intake_items') IS NULL
     OR to_regclass('public.homeowner_ledger_tokens') IS NULL
     OR to_regclass('public.homeowner_ledger_events') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'checksops')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'sql94_prerequisite_missing' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tenant_documents'
      AND column_name = 'doc_type' AND udt_name = 'text' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'sql94_prerequisite_missing: tenant_documents.doc_type text NOT NULL' USING ERRCODE = '55000';
  END IF;
END
$sql94_prereq$;

-- 1) doc_type rule ---------------------------------------------------------

CREATE OR REPLACE FUNCTION public.aws_tenant_document_doc_type_ok(_doc_type text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT _doc_type IS NOT NULL
     AND (
       _doc_type = ANY (ARRAY[
         'w9',
         'license',
         'insurance',
         'saas_agreement',
         'terms_of_service',
         'privacy_policy',
         'library:mortgage:w-9',
         'library:mortgage:contractor-license',
         'library:mortgage:general-liability-insurance',
         'library:mortgage:workers-comp-insurance',
         'library:mortgage:certificate-of-insurance',
         'library:mortgage:signed-contract',
         'library:mortgage:adjuster-tpa-letter'
       ]::text[])
       OR (
         _doc_type ~ '^library:(template|shingle|siding|catalog|letterhead):[a-z0-9]+(-[a-z0-9]+)*$'
         AND char_length(regexp_replace(_doc_type, '^library:[a-z]+:', '')) <= 60
       )
     );
$$;
REVOKE ALL ON FUNCTION public.aws_tenant_document_doc_type_ok(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_tenant_document_doc_type_ok(text) TO checksops, authenticated;

COMMENT ON FUNCTION public.aws_tenant_document_doc_type_ok(text) IS
  'SQL 94: tenant_documents.doc_type rule. Legacy 6 values, the 7 canonical library:mortgage:* values, and library:(template|shingle|siding|catalog|letterhead):<slug> with slug ^[a-z0-9]+(-[a-z0-9]+)*$, at most 60 characters. Mirrors isAllowedTenantDocumentDocType.';

DO $sql94_check$
DECLARE
  def text;
  def_md5 text;
  vals text[];
  pred3 constant text[] := ARRAY['insurance', 'license', 'w9']::text[];
  pred6 constant text[] := ARRAY['insurance', 'license', 'privacy_policy', 'saas_agreement', 'terms_of_service', 'w9']::text[];
  sql30 constant text[] := ARRAY[
    'insurance',
    'library:mortgage:adjuster-tpa-letter',
    'library:mortgage:certificate-of-insurance',
    'library:mortgage:contractor-license',
    'library:mortgage:general-liability-insurance',
    'library:mortgage:signed-contract',
    'library:mortgage:w-9',
    'library:mortgage:workers-comp-insurance',
    'license',
    'privacy_policy',
    'saas_agreement',
    'terms_of_service',
    'w9'
  ]::text[];
  invalid_n bigint;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(c.oid)
    INTO def
  FROM pg_catalog.pg_constraint c
  JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'tenant_documents'
    AND c.conname = 'tenant_documents_doc_type_check'
    AND c.contype = 'c';

  IF def IS NULL THEN
    RAISE EXCEPTION 'sql94_unsupported_doc_type_check: constraint tenant_documents_doc_type_check not found' USING ERRCODE = '55000';
  END IF;
  def_md5 := md5(def);

  IF def ~ '^CHECK \(+(public\.)?aws_tenant_document_doc_type_ok\(doc_type\)\)+$' THEN
    RAISE NOTICE 'sql94_doc_type_check_already_current md5=%', def_md5;
    RETURN;
  END IF;

  IF def ~* 'like' OR def ~ '~' OR (def !~* 'IN\s*\(' AND def !~* '= ANY') THEN
    RAISE EXCEPTION 'sql94_unsupported_doc_type_check md5=%', def_md5 USING ERRCODE = '55000';
  END IF;

  SELECT coalesce(array_agg(m[1] ORDER BY m[1]), ARRAY[]::text[])
    INTO vals
  FROM regexp_matches(def, $re$'([^']+)'$re$, 'g') AS m;

  IF vals IS DISTINCT FROM pred3 AND vals IS DISTINCT FROM pred6 AND vals IS DISTINCT FROM sql30 THEN
    RAISE EXCEPTION 'sql94_unsupported_doc_type_check md5=% n=%', def_md5, coalesce(array_length(vals, 1), 0)
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*)::bigint INTO invalid_n
  FROM public.tenant_documents
  WHERE NOT public.aws_tenant_document_doc_type_ok(doc_type);
  IF invalid_n > 0 THEN
    RAISE EXCEPTION 'sql94_invalid_rows: % existing rows would violate the new doc_type rule', invalid_n
      USING ERRCODE = '55000';
  END IF;

  ALTER TABLE public.tenant_documents DROP CONSTRAINT tenant_documents_doc_type_check;
  ALTER TABLE public.tenant_documents
    ADD CONSTRAINT tenant_documents_doc_type_check
    CHECK (public.aws_tenant_document_doc_type_ok(doc_type));

  RAISE NOTICE 'sql94_doc_type_check_applied predecessor_md5=%', def_md5;
END
$sql94_check$;

-- 2) per-claim homeowner sharing --------------------------------------------

CREATE OR REPLACE FUNCTION public.aws_homeowner_share_member(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT auth.uid() IS NOT NULL
     AND _tenant_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.tenant_users tu
       WHERE tu.user_id = auth.uid()
         AND tu.tenant_id = _tenant_id
     );
$$;
REVOKE ALL ON FUNCTION public.aws_homeowner_share_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_homeowner_share_member(uuid) TO checksops, authenticated;

COMMENT ON FUNCTION public.aws_homeowner_share_member(uuid) IS
  'SQL 94: auth.uid() has a tenant_users row for the tenant (any role value). No platform-owner or user_roles branch.';

CREATE TABLE IF NOT EXISTS public.homeowner_shared_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  tenant_document_id uuid NOT NULL REFERENCES public.tenant_documents(id) ON DELETE CASCADE,
  shared_by uuid,
  shared_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  CONSTRAINT homeowner_shared_documents_revoked_by_check CHECK (revoked_at IS NOT NULL OR revoked_by IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS homeowner_shared_documents_active_uniq
  ON public.homeowner_shared_documents (claim_id, tenant_document_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS homeowner_shared_documents_tenant_claim_idx
  ON public.homeowner_shared_documents (tenant_id, claim_id);

COMMENT ON TABLE public.homeowner_shared_documents IS
  'SQL 94: one tenant library document shared with one claim''s homeowner (HomeownerOps link). Revoke sets revoked_at; rows are never deleted by the API.';

CREATE OR REPLACE FUNCTION public.aws_homeowner_shared_documents_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  doc_tenant uuid;
  doc_type text;
  doc_path text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
       OR NEW.tenant_document_id IS DISTINCT FROM OLD.tenant_document_id
       OR NEW.shared_by IS DISTINCT FROM OLD.shared_by
       OR NEW.shared_at IS DISTINCT FROM OLD.shared_at THEN
      RAISE EXCEPTION 'sql94_share_immutable' USING ERRCODE = '42501';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
      RAISE EXCEPTION 'sql94_share_already_revoked' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'sql94_share_insert_revoked' USING ERRCODE = '42501';
  END IF;

  SELECT td.tenant_id, td.doc_type, td.file_path
    INTO doc_tenant, doc_type, doc_path
  FROM public.tenant_documents td
  WHERE td.id = NEW.tenant_document_id;
  IF NOT FOUND
     OR doc_tenant IS DISTINCT FROM NEW.tenant_id
     OR doc_type IS NULL
     OR doc_type NOT LIKE 'library:%'
     OR doc_type LIKE 'library:mortgage:%'
     OR lower(coalesce(doc_path, '')) NOT LIKE lower(NEW.tenant_id::text) || '/library/%' THEN
    RAISE EXCEPTION 'sql94_share_document_not_allowed' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.claims c
    WHERE c.id = NEW.claim_id
      AND (
        c.org_id = NEW.tenant_id
        OR (
          c.org_id IS NULL
          AND EXISTS (
            SELECT 1 FROM public.check_intake_items i
            WHERE i.claim_id = c.id AND i.tenant_id = NEW.tenant_id
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'sql94_share_claim_not_allowed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.aws_homeowner_shared_documents_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS homeowner_shared_documents_guard ON public.homeowner_shared_documents;
CREATE TRIGGER homeowner_shared_documents_guard
  BEFORE INSERT OR UPDATE ON public.homeowner_shared_documents
  FOR EACH ROW EXECUTE FUNCTION public.aws_homeowner_shared_documents_guard();

ALTER TABLE public.homeowner_shared_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aws_select_homeowner_shared_documents ON public.homeowner_shared_documents;
CREATE POLICY aws_select_homeowner_shared_documents ON public.homeowner_shared_documents
  FOR SELECT TO authenticated
  USING (public.aws_homeowner_share_member(tenant_id));

DROP POLICY IF EXISTS aws_insert_homeowner_shared_documents ON public.homeowner_shared_documents;
CREATE POLICY aws_insert_homeowner_shared_documents ON public.homeowner_shared_documents
  FOR INSERT TO authenticated
  WITH CHECK (public.aws_homeowner_share_member(tenant_id) AND shared_by = auth.uid());

DROP POLICY IF EXISTS aws_update_homeowner_shared_documents ON public.homeowner_shared_documents;
CREATE POLICY aws_update_homeowner_shared_documents ON public.homeowner_shared_documents
  FOR UPDATE TO authenticated
  USING (public.aws_homeowner_share_member(tenant_id))
  WITH CHECK (public.aws_homeowner_share_member(tenant_id));

REVOKE ALL ON TABLE public.homeowner_shared_documents FROM PUBLIC;
REVOKE ALL ON TABLE public.homeowner_shared_documents FROM authenticated;
REVOKE ALL ON TABLE public.homeowner_shared_documents FROM checksops;
GRANT SELECT, INSERT ON TABLE public.homeowner_shared_documents TO authenticated, checksops;
GRANT UPDATE (revoked_at, revoked_by) ON TABLE public.homeowner_shared_documents TO authenticated, checksops;

-- 3) public ledger readers ---------------------------------------------------

CREATE OR REPLACE FUNCTION public.aws_public_homeowner_shared_documents(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  tok public.homeowner_ledger_tokens%ROWTYPE;
  claim_ok boolean := false;
  docs_json jsonb;
BEGIN
  IF p_token IS NULL OR length(trim(p_token)) < 8 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_fields');
  END IF;

  SELECT * INTO tok
  FROM public.homeowner_ledger_tokens
  WHERE token = trim(p_token)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF tok.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'revoked');
  END IF;
  IF tok.expires_at IS NOT NULL AND tok.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'expired');
  END IF;
  IF tok.claim_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'documents', '[]'::jsonb);
  END IF;

  -- claim_ok copied from SQL 82.
  SELECT EXISTS (
    SELECT 1
    FROM public.claims c
    WHERE c.id = tok.claim_id
      AND (
        c.org_id = tok.tenant_id
        OR EXISTS (
          SELECT 1
          FROM public.check_intake_items i
          WHERE i.claim_id = tok.claim_id
            AND i.tenant_id = tok.tenant_id
        )
        OR EXISTS (
          SELECT 1
          FROM public.homeowner_ledger_events e
          WHERE e.claim_id = tok.claim_id
            AND e.tenant_id = tok.tenant_id
        )
      )
  ) INTO claim_ok;

  IF NOT claim_ok THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', s.id,
           'file_name', td.file_name,
           'mime_type', td.mime_type,
           'file_size', td.file_size,
           'category', split_part(td.doc_type, ':', 2),
           'shared_at', s.shared_at
         ) ORDER BY s.shared_at DESC, s.id), '[]'::jsonb)
    INTO docs_json
  FROM public.homeowner_shared_documents s
  JOIN public.tenant_documents td
    ON td.id = s.tenant_document_id
   AND td.tenant_id = s.tenant_id
  WHERE s.tenant_id = tok.tenant_id
    AND s.claim_id = tok.claim_id
    AND s.revoked_at IS NULL
    AND td.doc_type LIKE 'library:%'
    AND td.doc_type NOT LIKE 'library:mortgage:%';

  RETURN jsonb_build_object('ok', true, 'documents', docs_json);
END;
$$;
REVOKE ALL ON FUNCTION public.aws_public_homeowner_shared_documents(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_public_homeowner_shared_documents(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_shared_documents(text) TO checksops;

CREATE OR REPLACE FUNCTION public.aws_public_homeowner_shared_document(p_token text, p_shared_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  listed jsonb;
  row_out jsonb;
BEGIN
  IF p_shared_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_fields');
  END IF;
  -- Same token, tenant, claim and revocation rules as the list.
  listed := public.aws_public_homeowner_shared_documents(p_token);
  IF coalesce((listed->>'ok')::boolean, false) IS NOT TRUE THEN
    RETURN listed;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(listed->'documents') d WHERE (d->>'id')::uuid = p_shared_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  SELECT jsonb_build_object(
           'ok', true,
           'id', s.id,
           'tenant_id', s.tenant_id,
           'file_path', td.file_path,
           'file_name', td.file_name,
           'mime_type', td.mime_type
         )
    INTO row_out
  FROM public.homeowner_shared_documents s
  JOIN public.tenant_documents td
    ON td.id = s.tenant_document_id
   AND td.tenant_id = s.tenant_id
  WHERE s.id = p_shared_id
    AND s.revoked_at IS NULL;

  RETURN COALESCE(row_out, jsonb_build_object('ok', false, 'error', 'not_found'));
END;
$$;
REVOKE ALL ON FUNCTION public.aws_public_homeowner_shared_document(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_public_homeowner_shared_document(text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_shared_document(text, uuid) TO checksops;
