-- AWS staging: narrow GRANTs for tranche-6 non-financial metadata writes.
-- Does not enable financial tables, provider execution, or 64_financial_activation_grants.sql.

GRANT SELECT, UPDATE ON TABLE public.notifications TO checksops;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenant_documents TO checksops;
GRANT SELECT, UPDATE, DELETE ON TABLE public.loss_draft_documents TO checksops;
GRANT SELECT, INSERT, UPDATE ON TABLE public.mortgage_companies TO checksops;
GRANT SELECT, INSERT ON TABLE public.shared_check_messages TO checksops;
GRANT SELECT, UPDATE ON TABLE public.profiles TO checksops;
GRANT SELECT, INSERT, UPDATE ON TABLE public.company_branding TO checksops;
GRANT SELECT, UPDATE ON TABLE public.referral_alerts TO checksops;
GRANT SELECT, UPDATE ON TABLE public.tenants TO checksops;
GRANT SELECT, INSERT ON TABLE public.privacy_notice_acknowledgments TO checksops;
GRANT SELECT, UPDATE, DELETE ON TABLE public.tenant_users TO checksops;
