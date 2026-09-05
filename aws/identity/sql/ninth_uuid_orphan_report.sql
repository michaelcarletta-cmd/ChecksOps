-- Read-only ninth UUID orphan report. Do not invent email. Do not mint Cognito.
-- UUID: dd24eea5-5d12-47d1-999e-d5930c278b7d

SELECT 'dd24eea5-5d12-47d1-999e-d5930c278b7d'::uuid AS application_user_id;

SELECT
  (SELECT count(*) FROM public.profiles WHERE id = 'dd24eea5-5d12-47d1-999e-d5930c278b7d') AS profiles,
  (SELECT count(*) FROM public.tenant_users WHERE user_id = 'dd24eea5-5d12-47d1-999e-d5930c278b7d') AS tenant_users,
  (SELECT count(*) FROM public.user_roles WHERE user_id = 'dd24eea5-5d12-47d1-999e-d5930c278b7d') AS user_roles,
  (SELECT count(*) FROM public.identity_accounts WHERE application_user_id = 'dd24eea5-5d12-47d1-999e-d5930c278b7d' AND cognito_sub IS NOT NULL) AS cognito_linked,
  (SELECT count(*) FROM public.identity_accounts WHERE application_user_id = 'dd24eea5-5d12-47d1-999e-d5930c278b7d' AND email IS NOT NULL) AS email_present;

-- Classification (operator-facing, no PII): not_found on live production. Fail-closed. Do not invite.
