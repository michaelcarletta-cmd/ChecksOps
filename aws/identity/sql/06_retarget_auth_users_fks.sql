-- DO NOT RUN in this phase.
-- Migration path for the 47 skipped public FKs that referenced auth.users(id).
-- Target is the preserved ChecksOps application UUID, never Cognito sub.
--
-- Preferred referenced relation: public.identity_accounts(application_user_id)
-- because all 9 restored users will have a row there, including the user with
-- user_roles and no profiles row. profiles.id stays the same UUID when present.
-- Equivalent later option for columns that require a profile: public.profiles(id)
-- only after that 9th user has a profiles row with the SAME id.
--
-- Preserve ON DELETE / ON UPDATE from the dump. Do not rewrite existing UUID values.

-- identity_primary_key (1)
-- ALTER TABLE public.profiles
--   ADD CONSTRAINT profiles_id_identity_fkey
--   FOREIGN KEY (id) REFERENCES public.identity_accounts(application_user_id)
--   ON DELETE CASCADE ON UPDATE NO ACTION;

-- identity_membership_or_profile (6)
-- tenant_users.user_id              CASCADE   -> identity_accounts(application_user_id)
-- user_roles.user_id                CASCADE   -> identity_accounts(application_user_id)
-- contractor_profiles.user_id       CASCADE   -> identity_accounts(application_user_id)
-- notification_preferences.user_id  CASCADE   -> identity_accounts(application_user_id)
-- contractor_reviews.author_user_id SET NULL  -> identity_accounts(application_user_id)
-- referral_events.referred_user_id  NO ACTION -> identity_accounts(application_user_id)

-- audit_actor_has_data (20) and audit_actor_currently_empty (20)
-- Same UUID columns, FK to identity_accounts(application_user_id), keep dump ON DELETE.

-- Unresolved before attaching FKs:
-- 1. Invite/import the 9 users and set identity_accounts.cognito_sub (status=active).
-- 2. Decide whether the user with roles and no profile gets a profiles row with the
--    existing UUID (do not mint a new id).
-- 3. Do not enable RLS until auth.uid() GUC is set on every request path that hits
--    those tables.
