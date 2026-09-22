-- Reverse of 71_claims_insert_grant.sql. Leaves SELECT in place.

REVOKE INSERT ON TABLE public.claims FROM checksops;
