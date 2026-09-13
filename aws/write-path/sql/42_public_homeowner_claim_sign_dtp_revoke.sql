-- Rollback for 42_public_homeowner_claim_sign_dtp.sql
DROP FUNCTION IF EXISTS public.aws_public_homeowner_claim_sign_dtp(text, text, text, text, text, text);
