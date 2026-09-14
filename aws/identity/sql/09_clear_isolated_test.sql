-- Clear the temporary isolated_test Cognito mapping only.
-- Do not delete the ChecksOps application UUID or restored user rows.

-- Tester is one of the 8 locked production mappings. Never unlink those UUIDs.
UPDATE public.identity_accounts
SET cognito_sub = NULL,
    status = 'pending',
    linked_at = NULL
WHERE status = 'isolated_test'
  AND application_user_id = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91'::uuid
  AND application_user_id NOT IN (
    '0160a5f3-30a4-4aba-8e54-6529f1ceb0d4'::uuid,
    '30d0505c-bcfa-4732-81fd-869dc46da5dd'::uuid,
    '3af0234c-de1b-4819-938d-fa4f9390811b'::uuid,
    '7dbb3009-f059-4767-b5dc-1c5c72379330'::uuid,
    'abd3c2a0-6dc0-4680-92dd-a013e1141c91'::uuid,
    'b100f05d-9e81-4a7b-b9cc-9baf173131d9'::uuid,
    'e2ad0849-c6b6-4f4a-a68a-8c52f563c6fd'::uuid,
    'fd857564-9534-4b0f-95ac-624ed1273725'::uuid
  )
RETURNING application_user_id::text AS application_user_id,
          status,
          cognito_sub,
          email;
