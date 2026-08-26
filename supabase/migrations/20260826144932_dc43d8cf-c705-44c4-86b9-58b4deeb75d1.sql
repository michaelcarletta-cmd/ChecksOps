CREATE OR REPLACE FUNCTION public.user_can_access_claim(_user_id uuid, _claim_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT _user_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.claims cl
    WHERE cl.id = _claim_id
      AND (
        public.is_tenant_member(_user_id, cl.org_id)
        OR (public.has_role(_user_id, 'mortgage_agent'::public.app_role) AND public.mortgage_agent_can_view_claim(cl.id))
        OR public.current_tenant_is_claim_funds_recipient(cl.id)
      )
  );
$function$;

DROP FUNCTION IF EXISTS public.get_portfolio_intelligence() CASCADE;
DROP FUNCTION IF EXISTS public.refresh_portfolio_views() CASCADE;
DROP FUNCTION IF EXISTS public.match_knowledge_chunks(extensions.vector, double precision, integer, uuid) CASCADE;
DROP MATERIALIZED VIEW IF EXISTS public.portfolio_intelligence CASCADE;

DROP FUNCTION IF EXISTS public.encrypt_pii(text, text) CASCADE;
DROP FUNCTION IF EXISTS public.decrypt_pii(text, text) CASCADE;

DROP TABLE IF EXISTS public.ai_knowledge_chunks CASCADE;
DROP TABLE IF EXISTS public.ai_knowledge_documents CASCADE;
DROP TABLE IF EXISTS public.autopilot_action_feedback CASCADE;
DROP TABLE IF EXISTS public.autopilot_model_snapshot CASCADE;
DROP TABLE IF EXISTS public.clawdbot_message_log CASCADE;
DROP TABLE IF EXISTS public.clawdbot_config CASCADE;
DROP TABLE IF EXISTS public.bank_balance CASCADE;
DROP TABLE IF EXISTS public.cash_flow_forecast CASCADE;
DROP TABLE IF EXISTS public.outstanding_checks CASCADE;
DROP TABLE IF EXISTS public.increase_settings CASCADE;
DROP TABLE IF EXISTS public.claim_contractors CASCADE;
DROP TABLE IF EXISTS public.user_phone_links CASCADE;
DROP TABLE IF EXISTS public.encryption_keys CASCADE;