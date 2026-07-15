CREATE OR REPLACE FUNCTION public.autoadd_partner_stakeholder_on_share()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  payout_account_id uuid;
BEGIN
  SELECT id INTO payout_account_id
  FROM public.stakeholder_accounts
  WHERE tenant_id = NEW.target_tenant_id
    AND is_active = true
    AND verification_status IN ('verified','admin_override')
    AND is_partner_payout = true
  LIMIT 1;

  IF payout_account_id IS NULL THEN
    SELECT id INTO payout_account_id
    FROM public.stakeholder_accounts
    WHERE tenant_id = NEW.target_tenant_id
      AND is_active = true
      AND verification_status IN ('verified','admin_override')
    ORDER BY is_primary DESC, created_at ASC
    LIMIT 1;
  END IF;

  -- If the partner has no eligible account yet, skip auto-add (share still succeeds).
  IF payout_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.check_stakeholders (
    check_intake_item_id, stakeholder_account_id, tenant_id,
    added_via, partner_tenant_id, added_by
  ) VALUES (
    NEW.check_id, payout_account_id, NEW.source_tenant_id,
    'partner_share', NEW.target_tenant_id, NEW.shared_by
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$function$;