CREATE OR REPLACE FUNCTION public.list_partner_payout_options(_check_intake_item_id uuid)
RETURNS TABLE (
  partner_tenant_id uuid,
  partner_name text,
  payout_ready boolean,
  bank_name text,
  last_four text,
  already_added boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _tenant_id uuid;
BEGIN
  SELECT c.tenant_id INTO _tenant_id
  FROM public.check_intake_items c
  WHERE c.id = _check_intake_item_id;

  IF _tenant_id IS NULL THEN RETURN; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.user_id = auth.uid() AND tu.tenant_id = _tenant_id
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH partners AS (
    SELECT CASE WHEN p.inviter_tenant_id = _tenant_id
                THEN p.invitee_tenant_id ELSE p.inviter_tenant_id END AS pid
    FROM public.tenant_partnerships p
    WHERE p.status = 'active'
      AND p.revoked_at IS NULL
      AND (p.inviter_tenant_id = _tenant_id OR p.invitee_tenant_id = _tenant_id)
  )
  SELECT
    t.id,
    t.name,
    COALESCE(ppa.can_receive_payments, false) AND COALESCE(ppa.disabled, false) = false AS payout_ready,
    ppm.bank_name,
    ppm.last_four,
    EXISTS (
      SELECT 1 FROM public.check_stakeholders cs
      WHERE cs.check_intake_item_id = _check_intake_item_id
        AND cs.partner_tenant_id = t.id
    ) AS already_added
  FROM partners pr
  JOIN public.tenants t ON t.id = pr.pid
  LEFT JOIN LATERAL (
    SELECT a.can_receive_payments, a.disabled, a.provider, a.environment
    FROM public.payment_provider_accounts a
    WHERE a.tenant_id = t.id
    ORDER BY a.can_receive_payments DESC NULLS LAST, a.updated_at DESC NULLS LAST
    LIMIT 1
  ) ppa ON true
  LEFT JOIN LATERAL (
    SELECT m.bank_name, m.last_four
    FROM public.payment_provider_methods m
    WHERE m.tenant_id = t.id
      AND m.external_recipient_id IS NULL
    ORDER BY m.is_default DESC NULLS LAST, m.connected_at DESC NULLS LAST
    LIMIT 1
  ) ppm ON true
  WHERE t.id IS NOT NULL
  ORDER BY t.name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_partner_payout_options(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.add_partner_stakeholder_to_check(
  _check_intake_item_id uuid,
  _partner_tenant_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _tenant_id uuid;
  _account_id uuid;
  _row_id uuid;
BEGIN
  SELECT c.tenant_id INTO _tenant_id
  FROM public.check_intake_items c
  WHERE c.id = _check_intake_item_id;

  IF _tenant_id IS NULL THEN
    RAISE EXCEPTION 'Check not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.user_id = auth.uid() AND tu.tenant_id = _tenant_id
  ) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_partnerships p
    WHERE p.status = 'active'
      AND p.revoked_at IS NULL
      AND (
        (p.inviter_tenant_id = _tenant_id AND p.invitee_tenant_id = _partner_tenant_id)
        OR (p.invitee_tenant_id = _tenant_id AND p.inviter_tenant_id = _partner_tenant_id)
      )
  ) THEN
    RAISE EXCEPTION 'No active partnership with this organization';
  END IF;

  _account_id := public.sync_provider_stakeholder_account(_partner_tenant_id);

  IF _account_id IS NULL THEN
    SELECT s.id INTO _account_id
    FROM public.stakeholder_accounts s
    WHERE s.tenant_id = _partner_tenant_id
      AND s.is_active = true
      AND s.verification_status IN ('verified','admin_override')
    ORDER BY s.is_partner_payout DESC NULLS LAST, s.is_primary DESC NULLS LAST, s.created_at ASC
    LIMIT 1;
  END IF;

  IF _account_id IS NULL THEN
    RAISE EXCEPTION 'This partner has not finished payment setup yet';
  END IF;

  INSERT INTO public.check_stakeholders (
    check_intake_item_id, stakeholder_account_id, tenant_id,
    added_via, partner_tenant_id, added_by
  ) VALUES (
    _check_intake_item_id, _account_id, _tenant_id,
    'partner_share', _partner_tenant_id, auth.uid()
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO _row_id;

  IF _row_id IS NULL THEN
    SELECT cs.id INTO _row_id
    FROM public.check_stakeholders cs
    WHERE cs.check_intake_item_id = _check_intake_item_id
      AND cs.stakeholder_account_id = _account_id
    LIMIT 1;
  END IF;

  RETURN _row_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.add_partner_stakeholder_to_check(uuid, uuid) TO authenticated;