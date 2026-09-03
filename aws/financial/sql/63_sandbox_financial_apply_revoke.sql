-- Revoke sandbox apply EXECUTE grants. Does not drop functions or money tables.
-- Does not GRANT or REVOKE table DML on payment_transfers / checkalt_deposits.

REVOKE ALL ON FUNCTION public.aws_sandbox_apply_guard() FROM checksops;
REVOKE ALL ON FUNCTION public.aws_sandbox_apply_moov_transfer_status(text, text, text, text, timestamptz) FROM checksops;
REVOKE ALL ON FUNCTION public.aws_sandbox_touch_moov_account(text, text) FROM checksops;
REVOKE ALL ON FUNCTION public.aws_sandbox_apply_checkalt_operation(text, text, jsonb) FROM checksops;
