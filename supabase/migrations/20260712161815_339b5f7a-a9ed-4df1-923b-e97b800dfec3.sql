
CREATE OR REPLACE FUNCTION public.autoattach_homeowner_bank_on_verify()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  link RECORD;
  check_row RECORD;
BEGIN
  -- Only act when the account just became verified and came from a homeowner link
  IF NEW.origin <> 'homeowner_link' THEN RETURN NEW; END IF;
  IF NEW.verification_status NOT IN ('verified','admin_override') THEN RETURN NEW; END IF;
  IF OLD.verification_status = NEW.verification_status THEN RETURN NEW; END IF;
  IF NEW.homeowner_link_token_id IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO link
  FROM public.homeowner_bank_link_tokens
  WHERE id = NEW.homeowner_link_token_id;

  IF link.id IS NULL THEN RETURN NEW; END IF;

  UPDATE public.homeowner_bank_link_tokens
  SET status = 'verified', verified_at = now(), stakeholder_account_id = NEW.id
  WHERE id = link.id;

  IF link.scope = 'check' AND link.check_intake_item_id IS NOT NULL THEN
    INSERT INTO public.check_stakeholders (
      check_intake_item_id, stakeholder_account_id, tenant_id, added_via, added_by
    ) VALUES (
      link.check_intake_item_id, NEW.id, link.tenant_id, 'homeowner_link', link.sent_by_user_id
    ) ON CONFLICT DO NOTHING;
  ELSIF link.scope = 'claim' AND link.claim_id IS NOT NULL THEN
    FOR check_row IN
      SELECT id FROM public.check_intake_items WHERE claim_id = link.claim_id
    LOOP
      INSERT INTO public.check_stakeholders (
        check_intake_item_id, stakeholder_account_id, tenant_id, added_via, added_by
      ) VALUES (
        check_row.id, NEW.id, link.tenant_id, 'homeowner_link', link.sent_by_user_id
      ) ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_autoattach_homeowner_bank ON public.stakeholder_accounts;
CREATE TRIGGER trg_autoattach_homeowner_bank
  AFTER UPDATE OF verification_status ON public.stakeholder_accounts
  FOR EACH ROW EXECUTE FUNCTION public.autoattach_homeowner_bank_on_verify();

-- Also allow 'homeowner_link' as an added_via value on check_stakeholders
DO $$ BEGIN
  ALTER TABLE public.check_stakeholders DROP CONSTRAINT IF EXISTS check_stakeholders_added_via_check;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

ALTER TABLE public.check_stakeholders
  ADD CONSTRAINT check_stakeholders_added_via_check
  CHECK (added_via IN ('manual','partner_share','homeowner_link','auto'));
