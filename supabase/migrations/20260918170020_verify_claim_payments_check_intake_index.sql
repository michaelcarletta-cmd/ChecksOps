-- UNAPPLIED. Repo artifact only. Do not apply from this PR.
--
-- Catalog-level verification of the historical Lovable unique partial index
-- idx_claim_payments_check_intake (20260308154243).
-- Name existence and pg_indexes.indexdef text are not proof.
-- Does not delete or consolidate payment rows.

CREATE OR REPLACE FUNCTION public.claim_payments_check_intake_index_catalog_matches(
  p_indisunique boolean,
  p_relname text,
  p_nspname text,
  p_columns text[],
  p_indpred text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    COALESCE(p_indisunique, false)
    AND lower(COALESCE(p_relname, '')) = 'claim_payments'
    AND lower(COALESCE(p_nspname, 'public')) = 'public'
    AND p_columns = ARRAY['check_intake_item_id']::text[]
    AND regexp_replace(lower(COALESCE(p_indpred, '')), '[() ]+', ' ', 'g')
      ~ '^ ?check_intake_item_id is not null ?$';
$$;

CREATE OR REPLACE FUNCTION public.verify_claim_payments_check_intake_index()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  v_dupes integer := 0;
  v_indisunique boolean;
  v_relname text;
  v_nspname text;
  v_columns text[];
  v_indpred text;
  v_exists boolean := false;
BEGIN
  SELECT COUNT(*) INTO v_dupes
  FROM (
    SELECT check_intake_item_id
    FROM public.claim_payments
    WHERE check_intake_item_id IS NOT NULL
    GROUP BY check_intake_item_id
    HAVING COUNT(*) > 1
  ) d;

  SELECT
    i.indisunique,
    c.relname,
    n.nspname,
    ARRAY(
      SELECT a.attname
      FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a
        ON a.attrelid = i.indrelid
       AND a.attnum = k.attnum
      ORDER BY k.ord
    ),
    pg_get_expr(i.indpred, i.indrelid)
  INTO v_indisunique, v_relname, v_nspname, v_columns, v_indpred
  FROM pg_class idx
  JOIN pg_namespace ns ON ns.oid = idx.relnamespace
  JOIN pg_index i ON i.indexrelid = idx.oid
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE ns.nspname = 'public'
    AND idx.relname = 'idx_claim_payments_check_intake'
  LIMIT 1;

  v_exists := v_relname IS NOT NULL;

  IF v_dupes > 0 THEN
    RAISE EXCEPTION
      'claim_payments_index_guard: % duplicate claim_payments.check_intake_item_id group(s) exist; stop before apply — no data deleted',
      v_dupes;
  END IF;

  IF v_exists AND NOT public.claim_payments_check_intake_index_catalog_matches(
    v_indisunique, v_relname, v_nspname, v_columns, v_indpred
  ) THEN
    RAISE EXCEPTION
      'claim_payments_index_guard: idx_claim_payments_check_intake exists but catalog shape is not UNIQUE(public.claim_payments.check_intake_item_id) WHERE check_intake_item_id IS NOT NULL; rel=% nsp=% unique=% cols=% pred=%',
      v_relname, v_nspname, v_indisunique, v_columns, v_indpred;
  END IF;

  IF NOT v_exists THEN
    EXECUTE $idx$
      CREATE UNIQUE INDEX idx_claim_payments_check_intake
        ON public.claim_payments(check_intake_item_id)
        WHERE check_intake_item_id IS NOT NULL
    $idx$;
    RETURN jsonb_build_object(
      'ok', true,
      'action', 'create',
      'reason', 'missing_index',
      'duplicate_groups', v_dupes
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'pass',
    'reason', 'catalog_matches',
    'relation', v_relname,
    'columns', to_jsonb(v_columns),
    'indisunique', v_indisunique,
    'indpred', v_indpred,
    'duplicate_groups', v_dupes
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_payments_check_intake_index_catalog_matches(boolean, text, text, text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_claim_payments_check_intake_index() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_claim_payments_check_intake_index() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_payments_check_intake_index_catalog_matches(boolean, text, text, text[], text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.verify_claim_payments_check_intake_index() TO service_role;

SELECT public.verify_claim_payments_check_intake_index();
