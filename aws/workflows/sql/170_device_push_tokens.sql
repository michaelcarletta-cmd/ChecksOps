-- SQL 170: the phones a signed-in user receives ChecksOps push notifications on (iOS and Android app).
-- AWS only: nothing under supabase/migrations changes.
--
-- Why (owner 2026-11-19): app notifications when signatures are received, funds are disbursed or received, the wallet
-- changes, or a message arrives. The app side (PR 2016, src/lib/nativePush.ts) asks permission after sign-in, gets the
-- phone's push token from Apple or Google and sends it to the API (push-register-device). This file is where the API
-- keeps it. Sending notifications, and reading the tokens to send to, is a later, separate step; nothing here sends
-- anything or is read by anything yet.
--
-- What this file does:
--   1) A new table public.device_push_tokens: one row per phone token (platform ios or android), the user it belongs
--      to, when it was first registered and last seen. A token is unique: when another user signs in on the same
--      phone, the token moves to them, so a phone never gets the previous user's notifications. ROW LEVEL SECURITY on,
--      no policy, no table grant: only the functions below, which run as the table owner, read or write it.
--   2) Two new functions, SECURITY DEFINER, search_path public, row_security off, owned by the applying login,
--      EXECUTE for checksops (the API login) and the owner only. Nothing existing is replaced.
--      a) aws_push_register_device(_platform text, _token text): the signed-in user (auth.uid()) registers this phone.
--         Inserts the token, or moves an existing one to this user and refreshes it. A user keeps at most 20 tokens;
--         beyond that the least recently seen are removed. Returns the row id.
--      b) aws_push_unregister_device(_token text): the signed-in user removes this phone (sign-out, notifications
--         turned off). Only the caller's own token is removed. Returns whether a row was removed.
--
-- Refuses to run (55000 sql170_prerequisite_missing) without auth.uid(), gen_random_uuid() and the checksops role, and
-- (55000 sql170_unexpected_table) when a public.device_push_tokens table already exists with other columns than this
-- file creates.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL executor runs it
-- inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change: staging first, then production, through the
-- guarded SQL path (AGENTS.md).

DO $sql170_prerequisites$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_cols text[];
BEGIN
  IF to_regprocedure('auth.uid()') IS NULL THEN
    v_missing := array_append(v_missing, 'auth.uid()');
  END IF;
  IF to_regprocedure('gen_random_uuid()') IS NULL THEN
    v_missing := array_append(v_missing, 'gen_random_uuid()');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops') THEN
    v_missing := array_append(v_missing, 'role checksops');
  END IF;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'sql170_prerequisite_missing: %', array_to_string(v_missing, ', ') USING ERRCODE = '55000';
  END IF;

  IF to_regclass('public.device_push_tokens') IS NOT NULL THEN
    SELECT array_agg(a.attname::text ORDER BY a.attname) INTO v_cols
    FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.device_push_tokens'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
    IF v_cols IS DISTINCT FROM ARRAY['created_at', 'id', 'last_seen_at', 'platform', 'token', 'user_id']::text[] THEN
      RAISE EXCEPTION 'sql170_unexpected_table: public.device_push_tokens has columns %', v_cols USING ERRCODE = '55000';
    END IF;
  END IF;
END
$sql170_prerequisites$;

-- 1) Phone push tokens. No policy and no grant: only the SECURITY DEFINER functions below touch it.
CREATE TABLE IF NOT EXISTS public.device_push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  platform text NOT NULL CONSTRAINT device_push_tokens_platform CHECK (platform IN ('ios', 'android')),
  token text NOT NULL CONSTRAINT device_push_tokens_token_shape CHECK (length(token) BETWEEN 1 AND 4096 AND token !~ '\s'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_push_tokens_token_key UNIQUE (token)
);
CREATE INDEX IF NOT EXISTS device_push_tokens_user_idx
  ON public.device_push_tokens (user_id, last_seen_at DESC);
ALTER TABLE public.device_push_tokens ENABLE ROW LEVEL SECURITY;
-- No grant to anyone but the owner, whatever the database's default privileges gave the new table (SQL 118, SQL 158).
DO $sql170_table_acl$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT a.grantee
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    WHERE c.oid = 'public.device_push_tokens'::regclass
      AND a.grantee <> c.relowner
  LOOP
    IF r.grantee = 0 THEN
      EXECUTE 'REVOKE ALL ON TABLE public.device_push_tokens FROM PUBLIC';
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE public.device_push_tokens FROM %I', pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END
$sql170_table_acl$;
COMMENT ON TABLE public.device_push_tokens IS
  'SQL 170: the phones (iOS/Android push tokens) a user receives ChecksOps notifications on. One row per token; a token belongs to the user who last registered it. Written only through aws_push_register_device / aws_push_unregister_device. RLS on, no policy, no grant.';

-- a) The signed-in user registers this phone.
CREATE OR REPLACE FUNCTION public.aws_push_register_device(_platform text, _token text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF _platform IS NULL OR _platform NOT IN ('ios', 'android') THEN
    RAISE EXCEPTION 'invalid_platform' USING ERRCODE = '22023';
  END IF;
  IF _token IS NULL OR length(_token) NOT BETWEEN 1 AND 4096 OR _token ~ '\s' THEN
    RAISE EXCEPTION 'invalid_token' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.device_push_tokens AS t (user_id, platform, token)
  VALUES (v_uid, _platform, _token)
  ON CONFLICT ON CONSTRAINT device_push_tokens_token_key DO UPDATE
    SET user_id = EXCLUDED.user_id,
        platform = EXCLUDED.platform,
        last_seen_at = now(),
        created_at = CASE WHEN t.user_id = EXCLUDED.user_id THEN t.created_at ELSE now() END
  RETURNING t.id INTO v_id;

  -- At most 20 phones per user: drop the least recently seen beyond that.
  DELETE FROM public.device_push_tokens d
   WHERE d.user_id = v_uid
     AND d.id IN (
       SELECT x.id FROM public.device_push_tokens x
        WHERE x.user_id = v_uid
        ORDER BY x.last_seen_at DESC, x.id
        OFFSET 20
     );

  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION public.aws_push_register_device(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_push_register_device(text, text) TO checksops;
COMMENT ON FUNCTION public.aws_push_register_device(text, text) IS
  'SQL 170: the signed-in user registers this phone''s push token (ios or android); a token registered by another user moves to the caller. At most 20 per user. checksops only.';

-- b) The signed-in user removes this phone.
CREATE OR REPLACE FUNCTION public.aws_push_unregister_device(_token text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF _token IS NULL THEN
    RETURN false;
  END IF;
  DELETE FROM public.device_push_tokens d WHERE d.token = _token AND d.user_id = v_uid;
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION public.aws_push_unregister_device(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_push_unregister_device(text) TO checksops;
COMMENT ON FUNCTION public.aws_push_unregister_device(text) IS
  'SQL 170: the signed-in user removes their own phone''s push token. checksops only.';
