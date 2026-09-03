-- Revoke financial certification grants. Does not drop tables (audit retained).
-- Does not touch payment_transfers or other money ledgers.

REVOKE ALL ON TABLE public.aws_financial_operations FROM checksops;
REVOKE ALL ON TABLE public.aws_financial_audit FROM checksops;
REVOKE ALL ON TABLE public.aws_financial_reconciliation_findings FROM checksops;
