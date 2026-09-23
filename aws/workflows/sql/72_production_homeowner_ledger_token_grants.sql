-- Production minimum privilege for the accepted homeowner-ledger-send handler.
-- The application role `checksops` is a member of `authenticated` (RLS stays in force).
-- Handler statements: SELECT / INSERT / UPDATE on public.homeowner_ledger_tokens.
-- Do not grant DELETE. Do not alter ledger architecture or RLS policies.

GRANT SELECT, INSERT, UPDATE ON TABLE public.homeowner_ledger_tokens TO checksops;
