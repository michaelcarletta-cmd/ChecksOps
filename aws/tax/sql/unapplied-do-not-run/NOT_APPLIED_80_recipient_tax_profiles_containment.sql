-- ============================================================================
-- NOT SAFE TO APPLY / DESIGN ONLY
-- Do not run this file. It is not a migration, not a oneshot, and not
-- authorized for production, staging, or any live database.
-- Intentionally stored outside supabase/migrations and outside every
-- automatic runner glob (aws/write-path/sql, aws/workflows/sql,
-- aws/financial/sql, aws/rls/sql, aws/migrations/proposed).
-- Filename prefix NOT_APPLIED_ is required. Do not copy this file into
-- those directories. Production PostgREST GRANT/RLS containment is a
-- separately reviewed PR — do not add it here.
-- ============================================================================
-- TAX/1099 TIN CONTAINMENT — DO NOT APPLY IN THIS PR.
--
-- Unapplied by design. Do not run against production, staging, or any live
-- database unless separately authorized. Existing tin values must not be
-- deleted, rewritten, decrypted, printed, or selected into application logs.
--
-- Intent:
--   1. Drop open "any tenant member" policies.
--   2. Restrict row access to platform owner, platform user_roles.admin,
--      and tenant owner/admin of that tenant_id.
--   3. Add encryption-at-rest columns WITHOUT backfilling from tin.
--   4. Fail closed: abort the transaction on error; do not leave a half-applied
--      policy set that is more open than before.
--
-- Reversible (see NOT_APPLIED_80_recipient_tax_profiles_containment.down.sql):
--   DROP the additive columns; restore the previous policies.
--   Plaintext tin is left untouched in both directions.
--
-- Future authorized encrypt job (NOT this file):
--   Copy tin -> tin_encrypted using the chosen KMS/secrets mechanism, verify,
--   then NULL tin in a second authorized transaction. Never log tin.

BEGIN;

CREATE OR REPLACE FUNCTION public.aws_can_access_tax_profiles(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT _tenant_id IS NOT NULL
     AND (
       public.is_platform_owner()
       OR EXISTS (
         SELECT 1
         FROM public.user_roles ur
         WHERE ur.user_id = auth.uid()
           AND ur.role::text = 'admin'
       )
       OR EXISTS (
         SELECT 1
         FROM public.tenant_users tu
         WHERE tu.tenant_id = _tenant_id
           AND tu.user_id = auth.uid()
           AND lower(tu.role) IN ('owner', 'admin')
       )
     );
$$;

COMMENT ON FUNCTION public.aws_can_access_tax_profiles(uuid) IS
  'Tax-profile access: platform owner, platform user_roles.admin, or tenant owner/admin of _tenant_id. Ordinary members are denied.';

REVOKE ALL ON FUNCTION public.aws_can_access_tax_profiles(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_can_access_tax_profiles(uuid) TO checksops, authenticated;

DROP POLICY IF EXISTS "tenant members read recipient_tax_profiles" ON public.recipient_tax_profiles;
DROP POLICY IF EXISTS "tenant members insert recipient_tax_profiles" ON public.recipient_tax_profiles;
DROP POLICY IF EXISTS "tenant members update recipient_tax_profiles" ON public.recipient_tax_profiles;
DROP POLICY IF EXISTS "tenant members delete recipient_tax_profiles" ON public.recipient_tax_profiles;
DROP POLICY IF EXISTS aws_select_recipient_tax_profiles ON public.recipient_tax_profiles;
DROP POLICY IF EXISTS aws_write_recipient_tax_profiles ON public.recipient_tax_profiles;

CREATE POLICY aws_select_recipient_tax_profiles ON public.recipient_tax_profiles
  FOR SELECT TO authenticated
  USING (public.aws_can_access_tax_profiles(tenant_id));

CREATE POLICY aws_write_recipient_tax_profiles ON public.recipient_tax_profiles
  FOR ALL TO authenticated
  USING (public.aws_can_access_tax_profiles(tenant_id))
  WITH CHECK (public.aws_can_access_tax_profiles(tenant_id));

ALTER TABLE public.recipient_tax_profiles
  ADD COLUMN IF NOT EXISTS tin_on_file boolean,
  ADD COLUMN IF NOT EXISTS tin_last_4 text,
  ADD COLUMN IF NOT EXISTS tin_type text,
  ADD COLUMN IF NOT EXISTS tin_encrypted bytea,
  ADD COLUMN IF NOT EXISTS tin_key_id text;

COMMENT ON COLUMN public.recipient_tax_profiles.tin IS
  'Plaintext TIN/EIN. Do not return to browsers. Encrypt-in-place is a later authorized job; do not backfill or null this column here.';
COMMENT ON COLUMN public.recipient_tax_profiles.tin_encrypted IS
  'Reserved for encryption-at-rest. Leave null until an authorized encrypt job copies tin and then nulls plaintext.';
COMMENT ON COLUMN public.recipient_tax_profiles.tin_key_id IS
  'Key identifier for tin_encrypted. Null until the encrypt job runs.';
COMMENT ON COLUMN public.recipient_tax_profiles.tin_last_4 IS
  'Optional stored last-four. This file does not populate it from tin.';
COMMENT ON COLUMN public.recipient_tax_profiles.tin_on_file IS
  'Optional stored presence flag. This file does not populate it from tin.';
COMMENT ON COLUMN public.recipient_tax_profiles.tin_type IS
  'Optional ein/ssn/unknown. This file does not populate it from tin.';

-- Fail closed: refuse to continue if the open member policies still exist.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'recipient_tax_profiles'
      AND policyname LIKE 'tenant members %'
  ) THEN
    RAISE EXCEPTION 'tax containment failed closed: member policies still present';
  END IF;
END $$;

COMMIT;
