-- Read-only verification of Cognito login-phase identity mappings.
-- Do not INSERT/UPDATE/DELETE. Do not rewrite application UUIDs.

SELECT application_user_id::text AS application_user_id,
       cognito_sub,
       email,
       status
FROM public.identity_accounts
ORDER BY email NULLS LAST, application_user_id;
