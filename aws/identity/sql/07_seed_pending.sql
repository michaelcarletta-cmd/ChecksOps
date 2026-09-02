-- Seed pending identity_accounts from restored public identities.
-- cognito_sub stays NULL until a later invite. Do not create duplicate UUIDs.

INSERT INTO public.identity_accounts (application_user_id, email, status)
SELECT DISTINCT ON (ids.application_user_id)
  ids.application_user_id,
  p.email,
  'pending'
FROM (
  SELECT id AS application_user_id FROM public.profiles
  UNION
  SELECT user_id FROM public.tenant_users
  UNION
  SELECT user_id FROM public.user_roles
) ids
LEFT JOIN public.profiles p ON p.id = ids.application_user_id
ON CONFLICT (application_user_id) DO NOTHING;
