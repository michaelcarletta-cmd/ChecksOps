ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS stakeholder_cap integer DEFAULT 5;

CREATE OR REPLACE FUNCTION public.check_team_member_cap(_tenant_id uuid, _role text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    current_count integer;
    max_cap integer;
BEGIN
    IF _role NOT IN ('vendor','sales_rep','subcontractor') THEN
        RETURN true;
    END IF;

    SELECT count(*) INTO current_count
    FROM public.tenant_users
    WHERE tenant_id = _tenant_id
      AND role IN ('vendor','sales_rep','subcontractor');

    SELECT stakeholder_cap INTO max_cap FROM public.tenants WHERE id = _tenant_id;

    RETURN current_count < COALESCE(max_cap, 5);
END;
$$;