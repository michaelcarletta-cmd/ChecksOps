-- Partner-safe READ projections for an active shared_checks target.
-- Omit bearer/capability columns. Views are SELECT-only.
-- Owners continue to SELECT base tables (including tokens) unchanged.
-- Do not grant partners base-table SELECT * on these tables.

DROP VIEW IF EXISTS public.aws_partner_check_endorsements;
CREATE VIEW public.aws_partner_check_endorsements
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  e.id,
  e.check_id,
  e.payee_id,
  e.payee_name,
  e.payee_type,
  e.status,
  e.signature_method,
  e.signed_at,
  e.request_sent_at,
  e.last_reminder_at,
  e.reminder_count,
  e.contact_email,
  e.contact_phone,
  e.notes,
  e.loss_draft_task_created,
  e.signature_image_url,
  e.created_at,
  e.updated_at
FROM public.check_endorsements e
WHERE public.aws_is_active_shared_check_target(e.check_id);

COMMENT ON VIEW public.aws_partner_check_endorsements IS
  'Active shared-check partner display of endorsement status. Omits token / token_expires_at.';

DROP VIEW IF EXISTS public.aws_partner_check_payees;
CREATE VIEW public.aws_partner_check_payees
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  p.id,
  p.check_id,
  p.payee_name,
  p.payee_type,
  p.endorsement_status,
  p.endorsed_at,
  p.contact_email,
  p.contact_phone,
  p.notification_sent_via,
  p.notification_sent_at,
  p.created_at,
  p.updated_at
FROM public.check_payees p
WHERE public.aws_is_active_shared_check_target(p.check_id);

COMMENT ON VIEW public.aws_partner_check_payees IS
  'Active shared-check partner display of payee identity/status. Omits endorsement_token / endorsement_token_expires_at.';

DROP VIEW IF EXISTS public.aws_partner_signature_signers;
CREATE VIEW public.aws_partner_signature_signers
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  s.id,
  s.signature_request_id,
  s.signer_name,
  s.signer_email,
  s.signer_type,
  s.signing_order,
  s.status,
  s.signed_at,
  s.viewed_at,
  s.expires_at,
  s.delivery_status,
  s.delivery_error,
  s.email_sent_at,
  s.created_at
FROM public.signature_signers s
JOIN public.signature_requests r ON r.id = s.signature_request_id
WHERE public.aws_is_active_shared_check_target(r.check_intake_item_id);

COMMENT ON VIEW public.aws_partner_signature_signers IS
  'Active shared-check partner display of signer status. Omits access_token / token_hash / signature_data.';

REVOKE ALL ON TABLE public.aws_partner_check_endorsements FROM PUBLIC;
REVOKE ALL ON TABLE public.aws_partner_check_payees FROM PUBLIC;
REVOKE ALL ON TABLE public.aws_partner_signature_signers FROM PUBLIC;
GRANT SELECT ON TABLE public.aws_partner_check_endorsements TO checksops, authenticated;
GRANT SELECT ON TABLE public.aws_partner_check_payees TO checksops, authenticated;
GRANT SELECT ON TABLE public.aws_partner_signature_signers TO checksops, authenticated;
