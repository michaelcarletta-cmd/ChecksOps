-- 1. Schema: provider-backed stakeholder accounts
ALTER TABLE public.stakeholder_accounts
  ALTER COLUMN chk_aba DROP NOT NULL,
  ALTER COLUMN chk_acct DROP NOT NULL;

ALTER TABLE public.stakeholder_accounts
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS provider_environment text,
  ADD COLUMN IF NOT EXISTS provider_account_id text,
  ADD COLUMN IF NOT EXISTS provider_bank_account_id text,
  ADD COLUMN IF NOT EXISTS provider_bank_name text,
  ADD COLUMN IF NOT EXISTS provider_last_four text;

ALTER TABLE public.stakeholder_accounts
  DROP CONSTRAINT IF EXISTS stakeholder_accounts_verification_source_check;
ALTER TABLE public.stakeholder_accounts
  ADD CONSTRAINT stakeholder_accounts_verification_source_check
  CHECK (verification_source = ANY (ARRAY['authentecheck'::text,'plaid'::text,'manual'::text,'moov'::text]));

ALTER TABLE public.stakeholder_accounts
  DROP CONSTRAINT IF EXISTS stakeholder_accounts_origin_check;
ALTER TABLE public.stakeholder_accounts
  ADD CONSTRAINT stakeholder_accounts_origin_check
  CHECK (origin = ANY (ARRAY['tenant_owned'::text,'partner_shared'::text,'homeowner_link'::text,'provider_connected'::text]));

CREATE UNIQUE INDEX IF NOT EXISTS stakeholder_accounts_provider_account_uniq
  ON public.stakeholder_accounts (tenant_id, provider, provider_environment)
  WHERE origin = 'provider_connected';

-- 2. Sync a tenant's connected payment account into a payout stakeholder account
CREATE OR REPLACE FUNCTION public.sync_provider_stakeholder_account(_tenant_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  acct         public.payment_provider_accounts%ROWTYPE;
  bank         public.payment_provider_methods%ROWTYPE;
  owner_id     uuid;
  tenant_name  text;
  existing_id  uuid;
BEGIN
  IF _tenant_id IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO acct
  FROM public.payment_provider_accounts
  WHERE tenant_id = _tenant_id
    AND can_receive_payments = true
    AND COALESCE(disabled, false) = false
  ORDER BY updated_at DESC NULLS LAST
  LIMIT 1;

  IF acct.id IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO bank
  FROM public.payment_provider_methods
  WHERE tenant_id = _tenant_id
    AND provider = acct.provider
    AND environment = acct.environment
    AND external_recipient_id IS NULL
    AND COALESCE(can_receive, true) = true
  ORDER BY is_default DESC NULLS LAST, connected_at DESC NULLS LAST
  LIMIT 1;

  SELECT name INTO tenant_name FROM public.tenants WHERE id = _tenant_id;

  SELECT user_id INTO owner_id
  FROM public.tenant_users
  WHERE tenant_id = _tenant_id
  ORDER BY created_at ASC
  LIMIT 1;

  IF owner_id IS NULL THEN RETURN NULL; END IF;

  SELECT id INTO existing_id
  FROM public.stakeholder_accounts
  WHERE tenant_id = _tenant_id
    AND origin = 'provider_connected'
    AND provider = acct.provider
    AND provider_environment = acct.environment
  LIMIT 1;

  IF existing_id IS NULL THEN
    INSERT INTO public.stakeholder_accounts (
      tenant_id, created_by, nickname, account_type, custname,
      origin, is_partner_payout, is_active,
      verification_status, verification_source, verified_at,
      provider, provider_environment, provider_account_id,
      provider_bank_account_id, provider_bank_name, provider_last_four
    ) VALUES (
      _tenant_id, owner_id,
      COALESCE(tenant_name, 'Partner') || ' (payment account)',
      'contractor', COALESCE(acct.display_name, tenant_name, 'Partner'),
      'provider_connected', true, true,
      'verified', 'moov', now(),
      acct.provider, acct.environment, acct.provider_account_id,
      bank.provider_bank_account_id, bank.bank_name, bank.last_four
    )
    RETURNING id INTO existing_id;
  ELSE
    UPDATE public.stakeholder_accounts
    SET provider_account_id      = acct.provider_account_id,
        provider_bank_account_id = bank.provider_bank_account_id,
        provider_bank_name       = bank.bank_name,
        provider_last_four       = bank.last_four,
        custname                 = COALESCE(acct.display_name, tenant_name, custname),
        is_active                = true,
        verification_status      = 'verified',
        updated_at               = now()
    WHERE id = existing_id;
  END IF;

  RETURN existing_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_sync_provider_stakeholder_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.sync_provider_stakeholder_account(NEW.tenant_id);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_sync_provider_stakeholder_acct ON public.payment_provider_accounts;
CREATE TRIGGER trg_sync_provider_stakeholder_acct
AFTER INSERT OR UPDATE ON public.payment_provider_accounts
FOR EACH ROW EXECUTE FUNCTION public.trg_sync_provider_stakeholder_account();

DROP TRIGGER IF EXISTS trg_sync_provider_stakeholder_bank ON public.payment_provider_methods;
CREATE TRIGGER trg_sync_provider_stakeholder_bank
AFTER INSERT OR UPDATE ON public.payment_provider_methods
FOR EACH ROW EXECUTE FUNCTION public.trg_sync_provider_stakeholder_account();

-- 3. Partner share now prefers the partner's connected payment account
CREATE OR REPLACE FUNCTION public.autoadd_partner_stakeholder_on_share()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  payout_account_id uuid;
BEGIN
  -- Make sure the partner's connected payment account is mirrored first.
  payout_account_id := public.sync_provider_stakeholder_account(NEW.target_tenant_id);

  IF payout_account_id IS NULL THEN
    SELECT id INTO payout_account_id
    FROM public.stakeholder_accounts
    WHERE tenant_id = NEW.target_tenant_id
      AND is_active = true
      AND verification_status IN ('verified','admin_override')
      AND is_partner_payout = true
    LIMIT 1;
  END IF;

  IF payout_account_id IS NULL THEN
    SELECT id INTO payout_account_id
    FROM public.stakeholder_accounts
    WHERE tenant_id = NEW.target_tenant_id
      AND is_active = true
      AND verification_status IN ('verified','admin_override')
    ORDER BY is_primary DESC, created_at ASC
    LIMIT 1;
  END IF;

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

-- 4. Backfill existing connected accounts
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN
    SELECT DISTINCT tenant_id FROM public.payment_provider_accounts
    WHERE can_receive_payments = true AND COALESCE(disabled,false) = false
  LOOP
    PERFORM public.sync_provider_stakeholder_account(t);
  END LOOP;
END $$;