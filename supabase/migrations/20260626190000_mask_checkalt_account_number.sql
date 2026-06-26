-- checkalt_tenant_accounts.deposit_account_number is the full bank account
-- number FinCapture requires for registration — more sensitive than the
-- last-4-only pattern used elsewhere (tenant_bank_accounts). The previous
-- RLS policy let tenant/platform admins SELECT the raw column directly via
-- the Supabase API, even though the UI only ever displayed the last 4
-- digits. This locks the table itself to service_role only and exposes a
-- masked, last-4 view through a SECURITY DEFINER function instead.

DROP POLICY IF EXISTS "Tenant and platform admins can view checkalt tenant accounts"
  ON public.checkalt_tenant_accounts;

CREATE OR REPLACE FUNCTION public.get_checkalt_tenant_account(_tenant_id uuid)
RETURNS TABLE (
  sso_user_id text,
  deposit_account_last4 text,
  first_name text,
  last_name text,
  email text,
  enabled boolean,
  registered_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    a.sso_user_id,
    right(a.deposit_account_number, 4) AS deposit_account_last4,
    a.first_name,
    a.last_name,
    a.email,
    a.enabled,
    a.registered_at
  FROM public.checkalt_tenant_accounts a
  WHERE a.tenant_id = _tenant_id
    AND (public.is_tenant_admin(auth.uid(), _tenant_id) OR public.has_role(auth.uid(), 'admin'));
$$;

GRANT EXECUTE ON FUNCTION public.get_checkalt_tenant_account(uuid) TO authenticated;
