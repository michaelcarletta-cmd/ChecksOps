-- Read-only inventory of existing ChecksOps application identities.
-- Do not INSERT/UPDATE/DELETE. Do not invent UUIDs.

WITH sources AS (
  SELECT id AS application_user_id, 'profiles'::text AS source FROM public.profiles
  UNION ALL
  SELECT user_id, 'tenant_users' FROM public.tenant_users
  UNION ALL
  SELECT user_id, 'user_roles' FROM public.user_roles
  UNION ALL
  SELECT user_id, 'contractor_profiles' FROM public.contractor_profiles
),
distinct_ids AS (
  SELECT application_user_id,
         array_agg(DISTINCT source ORDER BY source) AS sources
  FROM sources
  GROUP BY application_user_id
)
SELECT d.application_user_id,
       p.email AS profile_email,
       p.full_name,
       p.approval_status,
       (p.id IS NOT NULL) AS has_profile,
       d.sources,
       (SELECT count(*) FROM public.tenant_users tu WHERE tu.user_id = d.application_user_id) AS tenant_memberships,
       (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'tenant_id', tu.tenant_id,
          'role', tu.role,
          'tenant_name', t.name,
          'tenant_slug', t.slug
        ) ORDER BY t.slug), '[]'::jsonb)
        FROM public.tenant_users tu
        LEFT JOIN public.tenants t ON t.id = tu.tenant_id
        WHERE tu.user_id = d.application_user_id) AS tenants,
       (SELECT coalesce(jsonb_agg(ur.role ORDER BY ur.role), '[]'::jsonb)
        FROM public.user_roles ur
        WHERE ur.user_id = d.application_user_id) AS app_roles
FROM distinct_ids d
LEFT JOIN public.profiles p ON p.id = d.application_user_id
ORDER BY has_profile DESC, p.email NULLS LAST, d.application_user_id;
