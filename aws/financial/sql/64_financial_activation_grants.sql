-- DO NOT APPLY THIS FILE.
-- Reserved for a later human-approved financial activation.
-- AWS_FINANCIAL_PERMISSIONS_ACTIVATED must remain false until that review.
--
-- When (and only when) activation is explicitly approved, the AWS financial
-- service may EXECUTE these functions after:
--   authenticated app UUID → tenant → financial permission → resource ownership
--   → valid workflow state → provider execution gate
--
-- No browser DML. No GRANT UPDATE ON money tables TO PUBLIC / anon / authenticated.
-- Table-wide unrestricted financial access is forbidden.

-- Example (commented; not executed):
-- GRANT EXECUTE ON FUNCTION public.aws_financial_submit_checkalt_deposit(...) TO checksops;
-- GRANT EXECUTE ON FUNCTION public.aws_financial_create_moov_transfer(...) TO checksops;
--
-- Each function MUST:
-- 1. Require current_setting('request.financial_execution', true) = '1'
-- 2. Require current_setting('request.aws_financial_permissions_activated', true) = '1'
-- 3. Scope writes to the mapped tenant / owned resource
-- 4. Refuse environment='production' until cutover is separately approved
-- 5. Never accept browser-supplied tenant_id, user_id, or amount as authority

SELECT 'NOT_APPLIED'::text AS aws_financial_activation_grants;
