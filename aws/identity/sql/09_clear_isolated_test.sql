-- Clear the temporary isolated_test Cognito mapping only.
-- Do not delete the ChecksOps application UUID or restored user rows.

UPDATE public.identity_accounts
SET cognito_sub = NULL,
    status = 'pending',
    linked_at = NULL
WHERE status = 'isolated_test'
  AND application_user_id = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91'::uuid
RETURNING application_user_id::text AS application_user_id,
          status,
          cognito_sub,
          email;
