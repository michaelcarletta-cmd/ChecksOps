-- Partner Codes Phase 3/3B: share/revoke lifecycle.
-- Drop globally UNIQUE tenant_partnerships.invite_code so many source
-- tenants can redeem the same target Partner Code.
-- Pair uniqueness (inviter, invitee) makes reconnect an UPDATE.
-- Dedicated SECURITY DEFINER ops; do not grant generic table writes.
-- Phase 3B: tenant_partnerships row is the serialization point (FOR UPDATE).
-- Partner Code lookup is Settings-only (connect). Share verifies an
-- already-established active pair and never looks up a Partner Code.

ALTER TABLE public.tenant_partnerships
  DROP CONSTRAINT IF EXISTS tenant_partnerships_invite_code_key;

DROP INDEX IF EXISTS public.tenant_partnerships_invite_code_key;

CREATE UNIQUE INDEX IF NOT EXISTS tenant_partnerships_unique_pair
  ON public.tenant_partnerships (inviter_tenant_id, invitee_tenant_id)
  WHERE invitee_tenant_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.aws_connect_partner_by_code(_code text, _source_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  _normalized text;
  _target uuid;
  _target_name text;
  _existing public.tenant_partnerships%ROWTYPE;
BEGIN
  IF NOT public.aws_can_write_tenant(_source_tenant_id) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  _normalized := regexp_replace(upper(coalesce(_code, '')), '[^A-Z0-9]', '', 'g');
  IF length(_normalized) <> 8 THEN
    RAISE EXCEPTION 'invalid_partner_code' USING ERRCODE = '22023';
  END IF;
  SELECT t.id, t.name INTO _target, _target_name
  FROM public.lookup_tenant_by_partner_code(_normalized) AS t
  LIMIT 1;
  IF _target IS NULL THEN
    RAISE EXCEPTION 'partner_code_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF _target = _source_tenant_id THEN
    RAISE EXCEPTION 'self_partnership_denied' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.tenant_partnerships
  WHERE (inviter_tenant_id = _source_tenant_id AND invitee_tenant_id = _target)
     OR (inviter_tenant_id = _target AND invitee_tenant_id = _source_tenant_id)
  FOR UPDATE;

  SELECT * INTO _existing
  FROM public.tenant_partnerships
  WHERE (inviter_tenant_id = _source_tenant_id AND invitee_tenant_id = _target)
     OR (inviter_tenant_id = _target AND invitee_tenant_id = _source_tenant_id)
  ORDER BY CASE WHEN inviter_tenant_id = _source_tenant_id THEN 0 ELSE 1 END, created_at
  LIMIT 1;

  IF _existing.id IS NOT NULL THEN
    IF _existing.status = 'active' AND _existing.revoked_at IS NULL THEN
      RETURN jsonb_build_object(
        'ok', true,
        'created', false,
        'reactivated', false,
        'partnership_id', _existing.id,
        'partner_tenant_id', _target,
        'partner_name', _target_name
      );
    END IF;
    UPDATE public.tenant_partnerships
    SET status = 'active',
        revoked_at = NULL,
        accepted_at = now(),
        invite_code = _normalized
    WHERE id = _existing.id
    RETURNING * INTO _existing;
    RETURN jsonb_build_object(
      'ok', true,
      'created', false,
      'reactivated', true,
      'partnership_id', _existing.id,
      'partner_tenant_id', _target,
      'partner_name', _target_name
    );
  END IF;

  BEGIN
    INSERT INTO public.tenant_partnerships (
      inviter_tenant_id,
      invitee_tenant_id,
      invite_code,
      status,
      created_by,
      accepted_at
    ) VALUES (
      _source_tenant_id,
      _target,
      _normalized,
      'active',
      auth.uid(),
      now()
    ) RETURNING * INTO _existing;
    RETURN jsonb_build_object(
      'ok', true,
      'created', true,
      'reactivated', false,
      'partnership_id', _existing.id,
      'partner_tenant_id', _target,
      'partner_name', _target_name
    );
  EXCEPTION
    WHEN unique_violation THEN
      PERFORM 1
      FROM public.tenant_partnerships
      WHERE (inviter_tenant_id = _source_tenant_id AND invitee_tenant_id = _target)
         OR (inviter_tenant_id = _target AND invitee_tenant_id = _source_tenant_id)
      FOR UPDATE;
      SELECT * INTO _existing
      FROM public.tenant_partnerships
      WHERE (inviter_tenant_id = _source_tenant_id AND invitee_tenant_id = _target)
         OR (inviter_tenant_id = _target AND invitee_tenant_id = _source_tenant_id)
      ORDER BY CASE WHEN inviter_tenant_id = _source_tenant_id THEN 0 ELSE 1 END, created_at
      LIMIT 1;
      IF _existing.id IS NULL THEN
        RAISE;
      END IF;
      IF _existing.status = 'active' AND _existing.revoked_at IS NULL THEN
        RETURN jsonb_build_object(
          'ok', true,
          'created', false,
          'reactivated', false,
          'partnership_id', _existing.id,
          'partner_tenant_id', _target,
          'partner_name', _target_name
        );
      END IF;
      UPDATE public.tenant_partnerships
      SET status = 'active',
          revoked_at = NULL,
          accepted_at = now(),
          invite_code = _normalized
      WHERE id = _existing.id
      RETURNING * INTO _existing;
      RETURN jsonb_build_object(
        'ok', true,
        'created', false,
        'reactivated', true,
        'partnership_id', _existing.id,
        'partner_tenant_id', _target,
        'partner_name', _target_name
      );
  END;
END;
$$;

COMMENT ON FUNCTION public.aws_connect_partner_by_code(text, uuid) IS
  'Settings-only Partner Code redeem. Locks the tenant pair. Concurrent same-pair connect is idempotent. Target id is never taken from the client.';

CREATE OR REPLACE FUNCTION public.aws_share_check_with_partner(_check_id uuid, _target_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  _source uuid;
  _share public.shared_checks%ROWTYPE;
BEGIN
  IF _check_id IS NULL OR _target_tenant_id IS NULL THEN
    RAISE EXCEPTION 'missing_required_field' USING ERRCODE = '22023';
  END IF;
  IF NOT public.aws_can_write_check(_check_id) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  SELECT ci.tenant_id INTO _source
  FROM public.check_intake_items ci
  WHERE ci.id = _check_id;
  IF _source IS NULL THEN
    RAISE EXCEPTION 'check_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF _source = _target_tenant_id THEN
    RAISE EXCEPTION 'self_share_denied' USING ERRCODE = '22023';
  END IF;

  -- Lock the established Settings partnership. Do not look up a Partner Code.
  -- A revoked pair fails here; sharing cannot silently reactivate it.
  PERFORM 1
  FROM public.tenant_partnerships p
  WHERE p.status = 'active'
    AND p.revoked_at IS NULL
    AND (
      (p.inviter_tenant_id = _source AND p.invitee_tenant_id = _target_tenant_id)
      OR (p.inviter_tenant_id = _target_tenant_id AND p.invitee_tenant_id = _source)
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_a_partner' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _share
  FROM public.shared_checks
  WHERE check_id = _check_id
    AND source_tenant_id = _source
    AND target_tenant_id = _target_tenant_id
  FOR UPDATE;

  IF _share.id IS NOT NULL THEN
    IF _share.revoked_at IS NULL THEN
      RETURN jsonb_build_object('ok', true, 'created', false, 'reactivated', false, 'share_id', _share.id);
    END IF;
    UPDATE public.shared_checks
    SET revoked_at = NULL,
        shared_by = auth.uid()
    WHERE id = _share.id
    RETURNING * INTO _share;
    RETURN jsonb_build_object('ok', true, 'created', false, 'reactivated', true, 'share_id', _share.id);
  END IF;

  INSERT INTO public.shared_checks (
    check_id,
    source_tenant_id,
    target_tenant_id,
    shared_by
  ) VALUES (
    _check_id,
    _source,
    _target_tenant_id,
    auth.uid()
  ) RETURNING * INTO _share;

  RETURN jsonb_build_object('ok', true, 'created', true, 'reactivated', false, 'share_id', _share.id);
END;
$$;

COMMENT ON FUNCTION public.aws_share_check_with_partner(uuid, uuid) IS
  'Owner-write share of a check to an already-established active partner. Locks the partnership row. source_tenant_id is the check owner. No Partner Code lookup.';

CREATE OR REPLACE FUNCTION public.aws_revoke_shared_check(_share_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  _share public.shared_checks%ROWTYPE;
BEGIN
  IF _share_id IS NULL THEN
    RAISE EXCEPTION 'missing_required_field' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO _share FROM public.shared_checks WHERE id = _share_id;
  IF _share.id IS NULL THEN
    RAISE EXCEPTION 'share_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.aws_can_write_check(_share.check_id) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF _share.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'revoked', false, 'share_id', _share.id);
  END IF;
  UPDATE public.shared_checks
  SET revoked_at = now()
  WHERE id = _share.id
    AND revoked_at IS NULL
  RETURNING * INTO _share;
  RETURN jsonb_build_object('ok', true, 'revoked', true, 'share_id', _share.id);
END;
$$;

COMMENT ON FUNCTION public.aws_revoke_shared_check(uuid) IS
  'Owner-write soft-revoke of a shared_checks row. Does not revoke the Settings partnership. Target partners cannot revoke.';

CREATE OR REPLACE FUNCTION public.aws_revoke_tenant_partnership(_partnership_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  _p public.tenant_partnerships%ROWTYPE;
  _n int := 0;
BEGIN
  IF _partnership_id IS NULL THEN
    RAISE EXCEPTION 'missing_required_field' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO _p
  FROM public.tenant_partnerships
  WHERE id = _partnership_id
  FOR UPDATE;
  IF _p.id IS NULL THEN
    RAISE EXCEPTION 'partnership_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT (
    public.aws_can_write_tenant(_p.inviter_tenant_id)
    OR public.aws_can_write_tenant(_p.invitee_tenant_id)
  ) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM public.tenant_partnerships
  WHERE (
    (inviter_tenant_id = _p.inviter_tenant_id AND invitee_tenant_id = _p.invitee_tenant_id)
    OR (inviter_tenant_id = _p.invitee_tenant_id AND invitee_tenant_id = _p.inviter_tenant_id)
  )
  FOR UPDATE;

  UPDATE public.tenant_partnerships
  SET status = 'revoked',
      revoked_at = coalesce(revoked_at, now())
  WHERE id = _p.id;

  UPDATE public.shared_checks
  SET revoked_at = now()
  WHERE revoked_at IS NULL
    AND (
      (source_tenant_id = _p.inviter_tenant_id AND target_tenant_id = _p.invitee_tenant_id)
      OR (source_tenant_id = _p.invitee_tenant_id AND target_tenant_id = _p.inviter_tenant_id)
    );
  GET DIAGNOSTICS _n = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'partnership_id', _p.id,
    'shares_revoked', _n
  );
END;
$$;

COMMENT ON FUNCTION public.aws_revoke_tenant_partnership(uuid) IS
  'Settings revoke: lock the partnership pair, then soft-revoke all active shared_checks between that tenant pair in one transaction.';

REVOKE ALL ON FUNCTION public.aws_connect_partner_by_code(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_share_check_with_partner(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_revoke_shared_check(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_revoke_tenant_partnership(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_connect_partner_by_code(text, uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_share_check_with_partner(uuid, uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_revoke_shared_check(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_revoke_tenant_partnership(uuid) TO checksops, authenticated;
