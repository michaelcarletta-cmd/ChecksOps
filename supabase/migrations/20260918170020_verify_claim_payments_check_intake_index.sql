-- UNAPPLIED. Repo artifact only. Do not apply from this PR.
--
-- Verifies idx_claim_payments_check_intake by live catalog definition.
-- Index name existence is not proof.
-- Required invariant:
--   UNIQUE on public.claim_payments(check_intake_item_id)
--   WHERE check_intake_item_id IS NOT NULL
-- If the name exists but the definition does not match: STOP.
-- Duplicate historical payments: STOP. No data repair.

CREATE OR REPLACE FUNCTION public.claim_payments_check_intake_index_matches(p_indexdef text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    p_indexdef IS NOT NULL
    AND lower(p_indexdef) ~ 'unique'
    AND lower(p_indexdef) ~ 'on (public\.)?claim_payments'
    AND COALESCE(
      (regexp_match(
        lower(regexp_replace(p_indexdef, '\s+', ' ', 'g')),
        'on (?:public\.)?claim_payments(?: using [\w.]+)? \(([^)]+)\)'
      ))[1],
      ''
    ) = 'check_intake_item_id'
    AND regexp_replace(
      COALESCE(
        (regexp_match(
          lower(regexp_replace(p_indexdef, '\s+', ' ', 'g')),
          'where (.+)$'
        ))[1],
        ''
      ),
      '[() ]+',
      ' ',
      'g'
    ) ~ '^ ?check_intake_item_id is not null ?$';
$$;

CREATE OR REPLACE FUNCTION public.verify_claim_payments_check_intake_index()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_dupes integer := 0;
  v_indexdef text;
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

  SELECT indexdef INTO v_indexdef
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname = 'idx_claim_payments_check_intake'
  LIMIT 1;

  v_exists := v_indexdef IS NOT NULL;

  IF v_dupes > 0 THEN
    RAISE EXCEPTION
      'claim_payments_index_guard: % duplicate claim_payments.check_intake_item_id group(s) exist; stop before apply — no data deleted',
      v_dupes;
  END IF;

  IF v_exists AND NOT public.claim_payments_check_intake_index_matches(v_indexdef) THEN
    RAISE EXCEPTION
      'claim_payments_index_guard: idx_claim_payments_check_intake exists but definition does not match UNIQUE(public.claim_payments.check_intake_item_id) WHERE check_intake_item_id IS NOT NULL; live indexdef=%',
      v_indexdef;
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
    'reason', 'definition_matches',
    'indexdef', v_indexdef,
    'duplicate_groups', v_dupes
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_payments_check_intake_index_matches(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_claim_payments_check_intake_index() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_claim_payments_check_intake_index() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_payments_check_intake_index_matches(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.verify_claim_payments_check_intake_index() TO service_role;

SELECT public.verify_claim_payments_check_intake_index();
