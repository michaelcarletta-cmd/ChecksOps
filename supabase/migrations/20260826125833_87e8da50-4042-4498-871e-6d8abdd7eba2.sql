REVOKE ALL ON FUNCTION public.tg_check_intake_assign_case() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_loss_draft_assign_case() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_claim_id_assign_case() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_check_case(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_check_case(uuid, uuid, uuid, text, text, text, text) TO authenticated, service_role;