-- Rollback for SQL 72. Drops only the public endorsement GET lookup.
-- Does not touch SQL 71 submit/reject/mark-sent or email_send_log RPCs.
-- After rollback, unauthenticated GET /public/endorsement get_endorsement_data
-- returns token_consumed again because the table SELECT fallback is RLS-denied.

DROP FUNCTION IF EXISTS public.aws_public_endorsement_by_token(text);
