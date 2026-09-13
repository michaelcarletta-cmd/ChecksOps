-- SQL 72: public endorsement GET lookup for the coherent Class A Endorse CTA.
--
-- Why this exists (do not blindly reapply aws/storage/sql/01_public_token_lookup.sql):
--   SQL 01 also creates aws_public_signature_by_token_hash (e-sign Sign page),
--   returns tenant_id/claim_id, and does not trim the bearer token. SQL 71
--   already owns public submit/reject + aws_mark_endorsement_request_sent.
--   The coherent Lambda GET path calls aws_public_endorsement_by_token first;
--   the table SELECT fallback is RLS-denied for the unauthenticated checksops
--   connection, so a missing RPC is reported as token_consumed.
--
-- Contract:
--   Exact unused token → jsonb row used by POST /public/endorsement get_endorsement_data.
--   Missing / whitespace token → NULL.
--   Expired token → NULL (SQL 71 submit already denies expired).
--   Signed/rejected/waived rows are still returned so Lambda can emit token_consumed
--   after SQL 71 rotates the public token, GET on the emailed token is NULL.
--
-- Security: SECURITY DEFINER, row_security=off, search_path pinned.
-- EXECUTE: checksops only. No PUBLIC. No authenticated.
-- No DML. Does not change SQL 71 consume/rotate/mark-sent behavior.

CREATE OR REPLACE FUNCTION public.aws_public_endorsement_by_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
  rec jsonb;
  tok text;
BEGIN
  tok := nullif(trim(p_token), '');
  IF tok IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object(
    'id', e.id,
    'payee_name', e.payee_name,
    'status', e.status,
    'token', e.token,
    'token_expires_at', e.token_expires_at,
    'check_id', e.check_id,
    'carrier_name', ci.carrier_name,
    'check_number', ci.check_number,
    'amount', ci.amount
  )
  INTO rec
  FROM public.check_endorsements e
  LEFT JOIN public.check_intake_items ci ON ci.id = e.check_id
  WHERE e.token = tok
    AND (e.token_expires_at IS NULL OR e.token_expires_at >= now())
  LIMIT 1;

  RETURN rec;
END;
$$;

COMMENT ON FUNCTION public.aws_public_endorsement_by_token(text) IS
  'SQL 72 read-only public Endorse CTA lookup. Exact bearer token only. checksops EXECUTE. No PUBLIC.';

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.aws_public_endorsement_by_token(text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.aws_public_endorsement_by_token(text) TO checksops;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.aws_public_endorsement_by_token(text) FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.aws_public_endorsement_by_token(text) FROM anon';
  END IF;
END
$$;
