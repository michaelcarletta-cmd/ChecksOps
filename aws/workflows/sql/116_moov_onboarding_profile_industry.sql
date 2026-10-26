-- SQL 116: the Moov onboarding business profile keeps the business's industry.
--
-- Why: Moov requires an industry on a business account's profile (profile.business.industry,
-- a value from Moov's industry list, GET /industries). ChecksOps never asked for one and had
-- nowhere to keep it: public.moov_onboarding_profiles (SQL 91) has no industry column. On
-- staging on 2026-10-26 Moov's form for Freedom Adjustment's new sandbox account (tenant
-- 2eff5f1a) listed Industry as required and empty, so the account stayed
-- onboarding_incomplete whatever ChecksOps sent.
--
-- 1) public.moov_onboarding_profiles: ADD COLUMN IF NOT EXISTS industry text. Nullable, no
--    default, so every existing row is unchanged and reads as "no industry yet". It holds the
--    industry identifier Moov's list returns (for example 'clothing-accessories'); the API
--    validates the value before it writes it, so the column has no check of its own.
--
-- Not changed: the table's grants (SQL 91 grants SELECT, INSERT, UPDATE on the table to
-- checksops and authenticated, which covers a new column), its policies, constraints,
-- indexes and triggers, any other table, function or row.
-- Refuses to run (55000 sql116_prerequisite_missing) without public.moov_onboarding_profiles.
--
-- Writer: aws/functions/api/providers/onboarding/store.mjs (upsertProfile), in a later change.
-- Readers: aws/functions/api/providers/onboarding/store.mjs (loadProfile) and
--          aws/functions/api/providers/onboarding/moov-sync.mjs (businessProfileBody), in a
--          later change.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the
-- guarded SQL executor runs it inside one transaction.
-- Idempotent: safe to re-run. Not applied by this change.

DO $sql116_prereq$
BEGIN
  IF to_regclass('public.moov_onboarding_profiles') IS NULL THEN
    RAISE EXCEPTION 'sql116_prerequisite_missing: SQL 116 needs public.moov_onboarding_profiles (SQL 91)'
      USING ERRCODE = '55000';
  END IF;
END
$sql116_prereq$;

ALTER TABLE public.moov_onboarding_profiles ADD COLUMN IF NOT EXISTS industry text;
