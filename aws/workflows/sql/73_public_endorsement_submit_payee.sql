-- SQL 73: atomic public endorsement submit (endorsement + matching payee).
--
-- Why this exists (do not rewrite historical SQL 71 in place):
--   SQL 71 aws_public_submit_endorsement signs check_endorsements and rotates
--   the bearer token, but does not UPDATE check_payees. The Lambda then
--   issues a second public-path UPDATE public.check_payees on the request
--   connection. That UPDATE is RLS-denied (0 rows) and its result is ignored,
--   so CTA submit can return HTTP 200 with endorsement signed / token
--   consumed while check_payees.endorsement_status stays pending.
--
-- Contract (same signature as SQL 71):
--   aws_public_submit_endorsement(text, text, text, text, text, text, uuid, uuid)
--   One SECURITY DEFINER transaction, bearer token only:
--     1. validate unused token (FOR UPDATE)
--     2. identify the exact endorsement/check/payee
--     3. reject wrong check/payee, consumed/invalid/expired token
--     4. sign the intended check_endorsements row
--     5. update ONLY the corresponding check_payees row to signed
--        (endorsement_status, endorsed_at, signature image, rotated token)
--     6. consume/rotate the public token (SQL 71 sibling-rotate preserved)
--     7. return the completed result including payee_status
--
-- Payee targeting:
--   payee_id set → UPDATE WHERE id = rec.payee_id AND check_id = rec.check_id
--     must affect exactly 1 row or the whole submit raises and rolls back.
--   payee_id null → at most one check_id + payee_name match; 0 rows skips
--     payee DML (legacy); >1 rows fail closed. Never updates another payee.
--
-- Security: SECURITY DEFINER, row_security=off, search_path pinned.
-- EXECUTE: checksops only. No PUBLIC. No authenticated. No anon.
-- Does not GRANT table UPDATE. Does not expose a public claim identifier.
-- tenant_id remains in the RPC jsonb for Lambda audit only (HTTP does not return it).
-- Does not change SQL 71 reject / mark-sent / email_send_log RPCs.
-- Does not change SQL 72 GET lookup.
--
-- Idempotency: CREATE OR REPLACE + GRANT/REVOKE. Safe to reapply.
--
-- Expected function fingerprint (stable across reapply; see local PG test):
--   proname     aws_public_submit_endorsement
--   signature   (text, text, text, text, text, text, uuid, uuid)
--   prosecdef   true
--   prokind     f
--   proconfig   search_path=public, pg_temp; row_security=off
--   prosrc      contains UPDATE public.check_payees and endorsement_status
--   md5(pg_get_functiondef)  d388bb4ec4a9cd6ee83d7e02e193b47c  (PG16 local)
--   SQL 71 rollback md5    89d7c65888ee551fc2488fefdf6d287c
--   EXECUTE     checksops only

CREATE OR REPLACE FUNCTION public.aws_public_submit_endorsement(
  p_token text,
  p_signature_image_url text,
  p_consent_text text,
  p_ip text,
  p_user_agent text,
  p_new_token text,
  p_check_id uuid DEFAULT NULL,
  p_payee_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
  rec public.check_endorsements%ROWTYPE;
  payee_rec public.check_payees%ROWTYPE;
  payee_rows integer := 0;
  name_matches integer := 0;
  rotated text;
  tok text;
BEGIN
  tok := nullif(trim(p_token), '');
  IF tok IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'token_required', 'statusCode', 400);
  END IF;

  PERFORM 1
  FROM public.check_endorsements
  WHERE token = tok
  FOR UPDATE;

  SELECT * INTO rec
  FROM public.check_endorsements
  WHERE token = tok
  ORDER BY CASE WHEN status IN ('pending', 'sent') THEN 0 WHEN status = 'signed' THEN 1 ELSE 2 END,
           updated_at DESC NULLS LAST
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_or_used_token', 'statusCode', 404);
  END IF;

  IF p_check_id IS NOT NULL AND rec.check_id IS DISTINCT FROM p_check_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'check_mismatch', 'statusCode', 403);
  END IF;
  IF p_payee_id IS NOT NULL AND rec.payee_id IS DISTINCT FROM p_payee_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'payee_mismatch', 'statusCode', 403);
  END IF;

  -- Identify and lock the single corresponding payee before any sign DML.
  IF rec.payee_id IS NOT NULL THEN
    SELECT * INTO payee_rec
    FROM public.check_payees
    WHERE id = rec.payee_id
      AND check_id = rec.check_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'payee_mismatch', 'statusCode', 409);
    END IF;
  ELSIF rec.check_id IS NOT NULL AND rec.payee_name IS NOT NULL THEN
    SELECT count(*) INTO name_matches
    FROM public.check_payees
    WHERE check_id = rec.check_id
      AND payee_name = rec.payee_name;
    IF name_matches > 1 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'payee_ambiguous', 'statusCode', 409);
    ELSIF name_matches = 1 THEN
      SELECT * INTO payee_rec
      FROM public.check_payees
      WHERE check_id = rec.check_id
        AND payee_name = rec.payee_name
      FOR UPDATE;
    END IF;
  END IF;

  rotated := nullif(trim(p_new_token), '');

  IF rec.status = 'signed' THEN
    IF rotated IS NOT NULL THEN
      UPDATE public.check_endorsements
      SET token = CASE
            WHEN id = rec.id THEN rotated
            ELSE gen_random_uuid()::text
          END,
          token_expires_at = NULL,
          updated_at = now()
      WHERE token = tok;
      rec.token := rotated;
    END IF;
    IF payee_rec.id IS NOT NULL THEN
      UPDATE public.check_payees
      SET endorsement_status = 'signed',
          endorsed_at = COALESCE(endorsed_at, now()),
          endorsement_image_path = COALESCE(NULLIF(p_signature_image_url, ''), endorsement_image_path),
          endorsement_token = COALESCE(rotated, endorsement_token),
          endorsement_token_expires_at = NULL,
          updated_at = now()
      WHERE id = payee_rec.id
        AND check_id = rec.check_id
      RETURNING * INTO payee_rec;
      GET DIAGNOSTICS payee_rows = ROW_COUNT;
      IF payee_rows <> 1 THEN
        RAISE EXCEPTION 'sql73_payee_persist_failed'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'already_signed', true,
      'id', rec.id,
      'check_id', rec.check_id,
      'tenant_id', rec.tenant_id,
      'payee_id', rec.payee_id,
      'payee_name', rec.payee_name,
      'contact_email', rec.contact_email,
      'status', rec.status,
      'token', rec.token,
      'payee_status', payee_rec.endorsement_status,
      'payee_endorsed_at', payee_rec.endorsed_at
    );
  END IF;

  IF rec.status IN ('rejected', 'waived', 'expired') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_or_used_token', 'statusCode', 404);
  END IF;

  IF rec.token_expires_at IS NOT NULL AND rec.token_expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_or_used_token', 'statusCode', 404);
  END IF;

  IF rotated IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_rotated_token');
  END IF;

  UPDATE public.check_endorsements
  SET status = 'signed',
      signed_at = now(),
      signature_image_url = p_signature_image_url,
      signature_method = 'portal',
      ip_address = p_ip,
      user_agent = p_user_agent,
      consent_text = p_consent_text,
      token = rotated,
      token_expires_at = NULL,
      updated_at = now()
  WHERE id = rec.id
    AND token = tok
    AND status IN ('pending', 'sent')
  RETURNING * INTO rec;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_or_used_token', 'statusCode', 404);
  END IF;

  IF payee_rec.id IS NOT NULL THEN
    UPDATE public.check_payees
    SET endorsement_status = 'signed',
        endorsed_at = COALESCE(endorsed_at, now()),
        endorsement_image_path = COALESCE(NULLIF(p_signature_image_url, ''), endorsement_image_path),
        endorsement_token = rotated,
        endorsement_token_expires_at = NULL,
        updated_at = now()
    WHERE id = payee_rec.id
      AND check_id = rec.check_id
    RETURNING * INTO payee_rec;
    GET DIAGNOSTICS payee_rows = ROW_COUNT;
    IF payee_rows <> 1 THEN
      RAISE EXCEPTION 'sql73_payee_persist_failed'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF rec.payee_id IS NOT NULL THEN
    RAISE EXCEPTION 'sql73_payee_persist_failed'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.check_endorsements
  SET token = gen_random_uuid()::text,
      token_expires_at = NULL,
      updated_at = now()
  WHERE token = tok
    AND id <> rec.id;

  RETURN jsonb_build_object(
    'ok', true,
    'already_signed', false,
    'id', rec.id,
    'check_id', rec.check_id,
    'tenant_id', rec.tenant_id,
    'payee_id', rec.payee_id,
    'payee_name', rec.payee_name,
    'contact_email', rec.contact_email,
    'status', rec.status,
    'token', rec.token,
    'payee_status', payee_rec.endorsement_status,
    'payee_endorsed_at', payee_rec.endorsed_at
  );
END;
$$;

COMMENT ON FUNCTION public.aws_public_submit_endorsement(text, text, text, text, text, text, uuid, uuid) IS
  'SQL 73 public unused-token endorsement submit. Signs endorsement and the matching payee in one transaction. SECURITY DEFINER. checksops EXECUTE only.';

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.aws_public_submit_endorsement(text, text, text, text, text, text, uuid, uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.aws_public_submit_endorsement(text, text, text, text, text, text, uuid, uuid) TO checksops;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.aws_public_submit_endorsement(text, text, text, text, text, text, uuid, uuid) FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.aws_public_submit_endorsement(text, text, text, text, text, text, uuid, uuid) FROM anon';
  END IF;
END
$$;
