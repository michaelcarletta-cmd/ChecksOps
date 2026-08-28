REVOKE EXECUTE ON FUNCTION public.list_partner_payout_options(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.add_partner_stakeholder_to_check(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_partner_payout_options(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_partner_stakeholder_to_check(uuid, uuid) TO authenticated;