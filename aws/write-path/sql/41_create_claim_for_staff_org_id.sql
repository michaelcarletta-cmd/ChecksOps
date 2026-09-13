-- Future staff claim creation must populate claims.org_id.
-- Uses the caller's unique tenant_users membership. Ambiguous or missing
-- membership fails closed instead of inserting a NULL-org claim.
-- Does not backfill existing rows.

CREATE OR REPLACE FUNCTION public.create_claim_for_staff(
  p_claim_number text,
  p_policy_number text,
  p_policyholder_name text,
  p_policyholder_phone text,
  p_policyholder_email text,
  p_policyholder_address text,
  p_insurance_company_id uuid,
  p_insurance_phone text,
  p_insurance_email text,
  p_loss_type_id uuid,
  p_loss_date date,
  p_loss_description text,
  p_referrer_id uuid,
  p_client_id uuid,
  p_mortgage_company_id uuid DEFAULT NULL
)
RETURNS public.claims
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_claim public.claims;
  caller_org uuid;
  membership_n int;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin')) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;

  SELECT count(DISTINCT tenant_id), min(tenant_id)
    INTO membership_n, caller_org
  FROM public.tenant_users
  WHERE user_id = auth.uid();

  IF membership_n IS DISTINCT FROM 1 OR caller_org IS NULL THEN
    RAISE EXCEPTION 'claim org_id requires exactly one tenant membership'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.claims (
    claim_number,
    policy_number,
    policyholder_name,
    policyholder_phone,
    policyholder_email,
    policyholder_address,
    insurance_company_id,
    insurance_phone,
    insurance_email,
    loss_type_id,
    loss_date,
    loss_description,
    referrer_id,
    client_id,
    mortgage_company_id,
    status,
    org_id
  ) VALUES (
    p_claim_number,
    p_policy_number,
    p_policyholder_name,
    p_policyholder_phone,
    p_policyholder_email,
    p_policyholder_address,
    p_insurance_company_id,
    p_insurance_phone,
    p_insurance_email,
    p_loss_type_id,
    p_loss_date,
    p_loss_description,
    p_referrer_id,
    p_client_id,
    p_mortgage_company_id,
    'open',
    caller_org
  )
  RETURNING * INTO new_claim;

  RETURN new_claim;
END;
$$;
