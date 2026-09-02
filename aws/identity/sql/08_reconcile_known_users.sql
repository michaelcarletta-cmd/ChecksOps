-- Read-only reconciliation of restored identities eligible for Cognito onboarding.
-- Do not INSERT/UPDATE/DELETE. Do not invent emails or UUIDs.

WITH profile_emails AS (
  SELECT id AS application_user_id,
         email,
         full_name,
         approval_status,
         count(*) OVER (PARTITION BY lower(email)) AS email_dupes
  FROM public.profiles
  WHERE email IS NOT NULL AND btrim(email) <> ''
),
identity_rows AS (
  SELECT application_user_id,
         email AS identity_email,
         cognito_sub,
         status,
         linked_at
  FROM public.identity_accounts
)
SELECT p.application_user_id::text AS application_user_id,
       p.email,
       p.full_name,
       p.approval_status,
       p.email_dupes,
       i.status AS identity_status,
       i.cognito_sub,
       i.identity_email,
       (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'tenant_id', tu.tenant_id,
          'role', tu.role,
          'tenant_name', t.name,
          'tenant_slug', t.slug
        ) ORDER BY t.slug), '[]'::jsonb)
        FROM public.tenant_users tu
        LEFT JOIN public.tenants t ON t.id = tu.tenant_id
        WHERE tu.user_id = p.application_user_id) AS tenants,
       (SELECT coalesce(jsonb_agg(ur.role::text ORDER BY ur.role), '[]'::jsonb)
        FROM public.user_roles ur
        WHERE ur.user_id = p.application_user_id) AS app_roles
FROM profile_emails p
LEFT JOIN identity_rows i ON i.application_user_id = p.application_user_id
ORDER BY p.email;
