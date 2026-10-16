-- Moov onboarding ("Compliance & Docs" + bank setup) stored in ChecksOps.
--
-- Tables (all tenant-scoped, per environment 'sandbox' | 'production'):
--   moov_onboarding_profiles         business profile; EIN as KMS ciphertext + last four
--   moov_onboarding_representatives  owners/controllers; SSN last four only, DOB as KMS ciphertext + year
--   moov_compliance_documents        compliance files in S3 (SSE-KMS) and their Moov file ids
--   moov_onboarding_outbox           retry queue; payload holds ids only (no SSN, EIN, DOB)
-- Plus payment_provider_methods.routing_last_four (bank routing number, last four only).
--
-- The full SSN is never stored anywhere: no column can hold it and the outbox
-- CHECK rejects SSN/EIN-shaped values and sensitive keys.
--
-- Reads: members of the tenant and the platform owner (aws_can_access_tenant),
-- through the API handlers only (these tables are not in allowed-tables.json
-- and not in the /data/write allowlist).
-- Writes: only while the onboarding handlers have set request.moov_onboarding=1
-- AND the caller is a member of THAT tenant (any stored role: tenants have no
-- role tiers) or the platform owner (aws_moov_onboarding_writer). Browsers
-- cannot set GUCs. Global user_roles
-- admin/staff without membership gains nothing. Webhook status updates use
-- request.provider_webhook_apply=1 (server webhook route only).
--
-- Writers: aws/functions/api/providers/onboarding/*.mjs
--          aws/functions/api/providers/onboarding/webhook-status.mjs

CREATE OR REPLACE FUNCTION public.aws_moov_onboarding_active()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(current_setting('request.moov_onboarding', true) = '1', false);
$$;

COMMENT ON FUNCTION public.aws_moov_onboarding_active() IS
  'True only while the AWS Moov onboarding handlers set request.moov_onboarding=1.';

CREATE OR REPLACE FUNCTION public.aws_can_submit_moov_onboarding(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.aws_is_authenticated()
     AND _tenant_id IS NOT NULL
     AND (
       COALESCE(public.is_platform_owner(), false)
       OR EXISTS (
         SELECT 1
         FROM public.tenant_users tu
         WHERE tu.tenant_id = _tenant_id
           AND tu.user_id = auth.uid()
       )
     );
$$;

COMMENT ON FUNCTION public.aws_can_submit_moov_onboarding(uuid) IS
  'Any tenant_users member of _tenant_id (role ignored: no tiers), or the platform owner (is_platform_owner). Global user_roles admin without membership is denied.';

CREATE OR REPLACE FUNCTION public.aws_moov_onboarding_writer(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT public.aws_moov_onboarding_active()
     AND COALESCE(public.aws_can_submit_moov_onboarding(_tenant_id), false);
$$;

CREATE OR REPLACE FUNCTION public.aws_moov_webhook_apply_active()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(current_setting('request.provider_webhook_apply', true) = '1', false);
$$;

REVOKE ALL ON FUNCTION public.aws_moov_onboarding_active() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_submit_moov_onboarding(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_moov_onboarding_writer(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_moov_webhook_apply_active() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_moov_onboarding_active() TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_submit_moov_onboarding(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_moov_onboarding_writer(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_moov_webhook_apply_active() TO checksops, authenticated;

-- ---------------------------------------------------------------- profiles
CREATE TABLE public.moov_onboarding_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  environment text NOT NULL,
  legal_name text,
  dba text,
  business_type text,
  email text,
  phone text,
  website text,
  description text,
  address jsonb NOT NULL DEFAULT '{}'::jsonb,
  ein_ciphertext text,
  ein_last4 text,
  ein_key_arn text,
  moov_account_id text,
  moov_profile_synced_at timestamptz,
  sync_pending boolean NOT NULL DEFAULT false,
  last_error_code text,
  last_webhook_event_type text,
  last_webhook_event_at timestamptz,
  submitted_by uuid REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moov_onboarding_profiles_tenant_env_unique UNIQUE (tenant_id, environment),
  CONSTRAINT moov_onboarding_profiles_environment_check CHECK (environment IN ('sandbox', 'production')),
  CONSTRAINT moov_onboarding_profiles_ein_last4_check CHECK (ein_last4 IS NULL OR ein_last4 ~ '^[0-9]{4}$'),
  CONSTRAINT moov_onboarding_profiles_ein_ciphertext_check CHECK (ein_ciphertext IS NULL OR ein_ciphertext LIKE 'kms:v1:%'),
  CONSTRAINT moov_onboarding_profiles_ein_pair_check CHECK ((ein_ciphertext IS NULL) = (ein_last4 IS NULL))
);
CREATE INDEX moov_onboarding_profiles_moov_account_idx
  ON public.moov_onboarding_profiles (environment, moov_account_id) WHERE moov_account_id IS NOT NULL;

-- ---------------------------------------------------------------- representatives
CREATE TABLE public.moov_onboarding_representatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  environment text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text,
  phone text,
  title text,
  address jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_controller boolean NOT NULL DEFAULT false,
  is_owner boolean NOT NULL DEFAULT false,
  ownership_pct numeric(5,2),
  dob_ciphertext text,
  dob_year smallint,
  ssn_last4 text,
  ssn_resubmit_required boolean NOT NULL DEFAULT false,
  moov_representative_id text,
  moov_synced_at timestamptz,
  last_error_code text,
  removed_at timestamptz,
  created_by uuid REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moov_onboarding_representatives_profile_fkey FOREIGN KEY (tenant_id, environment)
    REFERENCES public.moov_onboarding_profiles (tenant_id, environment) ON DELETE CASCADE,
  CONSTRAINT moov_onboarding_representatives_environment_check CHECK (environment IN ('sandbox', 'production')),
  CONSTRAINT moov_onboarding_representatives_ssn_last4_check CHECK (ssn_last4 IS NULL OR ssn_last4 ~ '^[0-9]{4}$'),
  CONSTRAINT moov_onboarding_representatives_dob_ciphertext_check CHECK (dob_ciphertext IS NULL OR dob_ciphertext LIKE 'kms:v1:%'),
  CONSTRAINT moov_onboarding_representatives_ownership_check CHECK (ownership_pct IS NULL OR (ownership_pct >= 0 AND ownership_pct <= 100))
);
CREATE INDEX moov_onboarding_representatives_tenant_idx
  ON public.moov_onboarding_representatives (tenant_id, environment);
CREATE UNIQUE INDEX moov_onboarding_representatives_moov_id_unique
  ON public.moov_onboarding_representatives (environment, moov_representative_id)
  WHERE moov_representative_id IS NOT NULL;

-- ---------------------------------------------------------------- documents
CREATE TABLE public.moov_compliance_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  environment text NOT NULL,
  purpose text NOT NULL,
  representative_id uuid REFERENCES public.moov_onboarding_representatives(id) ON DELETE SET NULL,
  file_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL,
  storage_key text NOT NULL,
  kms_key_arn text NOT NULL,
  status text NOT NULL DEFAULT 'pending_upload',
  sha256 text,
  moov_account_id text,
  moov_file_id text,
  moov_status text,
  last_error_code text,
  uploaded_by uuid REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL,
  upload_url_issued_at timestamptz,
  uploaded_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moov_compliance_documents_environment_check CHECK (environment IN ('sandbox', 'production')),
  CONSTRAINT moov_compliance_documents_status_check CHECK (status IN ('pending_upload', 'stored', 'sent', 'rejected')),
  CONSTRAINT moov_compliance_documents_purpose_check CHECK (purpose IN (
    'business_verification', 'identity_verification', 'individual_verification',
    'representative_verification', 'w9', 'bank_statement', 'license', 'insurance',
    'saas_agreement', 'terms_of_service', 'privacy_policy'
  )),
  CONSTRAINT moov_compliance_documents_content_type_check CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png', 'text/csv')),
  CONSTRAINT moov_compliance_documents_size_check CHECK (size_bytes BETWEEN 1 AND 20971520),
  CONSTRAINT moov_compliance_documents_storage_key_check CHECK (
    storage_key = 'files/tenant-documents/' || tenant_id::text || '/verification/' || id::text
  )
);
CREATE INDEX moov_compliance_documents_tenant_idx
  ON public.moov_compliance_documents (tenant_id, environment, created_at DESC);
CREATE UNIQUE INDEX moov_compliance_documents_moov_file_unique
  ON public.moov_compliance_documents (environment, moov_file_id)
  WHERE moov_file_id IS NOT NULL;

-- ---------------------------------------------------------------- outbox
CREATE TABLE public.moov_onboarding_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  environment text NOT NULL,
  kind text NOT NULL,
  subject_id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error_code text,
  created_by uuid REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT moov_onboarding_outbox_environment_check CHECK (environment IN ('sandbox', 'production')),
  CONSTRAINT moov_onboarding_outbox_kind_check CHECK (kind IN ('onboarding_sync', 'document_upload')),
  CONSTRAINT moov_onboarding_outbox_status_check CHECK (status IN ('pending', 'completed', 'abandoned')),
  -- Ids only: no sensitive keys and no SSN/EIN-shaped values anywhere in the payload.
  CONSTRAINT moov_onboarding_outbox_payload_no_pii CHECK (
    payload::text !~* '"(ssn|ssn_full|ein|tax_?id|government_?id|dob|birth_?date|account_?number|routing_?number|file_?base64)"\s*:'
    AND payload::text !~ '"[0-9]{3}-?[0-9]{2}-?[0-9]{4}"'
  )
);
CREATE INDEX moov_onboarding_outbox_tenant_idx
  ON public.moov_onboarding_outbox (tenant_id, environment, status);
CREATE UNIQUE INDEX moov_onboarding_outbox_one_pending
  ON public.moov_onboarding_outbox (tenant_id, environment, kind, subject_id)
  WHERE status = 'pending';

-- ---------------------------------------------------------------- bank routing (last four)
ALTER TABLE public.payment_provider_methods
  ADD COLUMN IF NOT EXISTS routing_last_four text;
ALTER TABLE public.payment_provider_methods
  DROP CONSTRAINT IF EXISTS payment_provider_methods_routing_last_four_check;
ALTER TABLE public.payment_provider_methods
  ADD CONSTRAINT payment_provider_methods_routing_last_four_check
  CHECK (routing_last_four IS NULL OR routing_last_four ~ '^[0-9]{4}$');

-- ---------------------------------------------------------------- RLS: new tables
ALTER TABLE public.moov_onboarding_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moov_onboarding_representatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moov_compliance_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moov_onboarding_outbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY aws_select_moov_onboarding_profiles ON public.moov_onboarding_profiles
  FOR SELECT TO authenticated USING (public.aws_can_access_tenant(tenant_id));
CREATE POLICY aws_insert_moov_onboarding_profiles ON public.moov_onboarding_profiles
  FOR INSERT TO authenticated WITH CHECK (public.aws_moov_onboarding_writer(tenant_id));
CREATE POLICY aws_update_moov_onboarding_profiles ON public.moov_onboarding_profiles
  FOR UPDATE TO authenticated
  USING (public.aws_moov_onboarding_writer(tenant_id))
  WITH CHECK (public.aws_moov_onboarding_writer(tenant_id));
-- UPDATE ... WHERE also needs SELECT visibility; the webhook route has no user.
CREATE POLICY aws_webhook_select_moov_onboarding_profiles ON public.moov_onboarding_profiles
  FOR SELECT TO authenticated USING (public.aws_moov_webhook_apply_active());
CREATE POLICY aws_webhook_update_moov_onboarding_profiles ON public.moov_onboarding_profiles
  FOR UPDATE TO authenticated
  USING (public.aws_moov_webhook_apply_active())
  WITH CHECK (public.aws_moov_webhook_apply_active());

CREATE POLICY aws_select_moov_onboarding_representatives ON public.moov_onboarding_representatives
  FOR SELECT TO authenticated USING (public.aws_can_access_tenant(tenant_id));
CREATE POLICY aws_insert_moov_onboarding_representatives ON public.moov_onboarding_representatives
  FOR INSERT TO authenticated WITH CHECK (public.aws_moov_onboarding_writer(tenant_id));
CREATE POLICY aws_update_moov_onboarding_representatives ON public.moov_onboarding_representatives
  FOR UPDATE TO authenticated
  USING (public.aws_moov_onboarding_writer(tenant_id))
  WITH CHECK (public.aws_moov_onboarding_writer(tenant_id));

CREATE POLICY aws_select_moov_compliance_documents ON public.moov_compliance_documents
  FOR SELECT TO authenticated USING (public.aws_can_access_tenant(tenant_id));
CREATE POLICY aws_insert_moov_compliance_documents ON public.moov_compliance_documents
  FOR INSERT TO authenticated WITH CHECK (public.aws_moov_onboarding_writer(tenant_id));
CREATE POLICY aws_update_moov_compliance_documents ON public.moov_compliance_documents
  FOR UPDATE TO authenticated
  USING (public.aws_moov_onboarding_writer(tenant_id))
  WITH CHECK (public.aws_moov_onboarding_writer(tenant_id));

CREATE POLICY aws_select_moov_onboarding_outbox ON public.moov_onboarding_outbox
  FOR SELECT TO authenticated USING (public.aws_can_access_tenant(tenant_id));
CREATE POLICY aws_insert_moov_onboarding_outbox ON public.moov_onboarding_outbox
  FOR INSERT TO authenticated WITH CHECK (public.aws_moov_onboarding_writer(tenant_id));
CREATE POLICY aws_update_moov_onboarding_outbox ON public.moov_onboarding_outbox
  FOR UPDATE TO authenticated
  USING (public.aws_moov_onboarding_writer(tenant_id))
  WITH CHECK (public.aws_moov_onboarding_writer(tenant_id));

REVOKE ALL ON TABLE public.moov_onboarding_profiles FROM PUBLIC;
REVOKE ALL ON TABLE public.moov_onboarding_representatives FROM PUBLIC;
REVOKE ALL ON TABLE public.moov_compliance_documents FROM PUBLIC;
REVOKE ALL ON TABLE public.moov_onboarding_outbox FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE public.moov_onboarding_profiles TO checksops, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.moov_onboarding_representatives TO checksops, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.moov_compliance_documents TO checksops, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.moov_onboarding_outbox TO checksops, authenticated;

-- ---------------------------------------------------------------- RLS: existing payment tables
-- Additional permissive policies (as in SQL 72): onboarding writes by a
-- member of the tenant or the platform owner, only while the onboarding
-- handlers have set request.moov_onboarding=1. Existing policies are unchanged.
DROP POLICY IF EXISTS aws_onboarding_insert_payment_provider_accounts ON public.payment_provider_accounts;
CREATE POLICY aws_onboarding_insert_payment_provider_accounts ON public.payment_provider_accounts
  FOR INSERT TO authenticated WITH CHECK (public.aws_moov_onboarding_writer(tenant_id));
DROP POLICY IF EXISTS aws_onboarding_update_payment_provider_accounts ON public.payment_provider_accounts;
CREATE POLICY aws_onboarding_update_payment_provider_accounts ON public.payment_provider_accounts
  FOR UPDATE TO authenticated
  USING (public.aws_moov_onboarding_writer(tenant_id))
  WITH CHECK (public.aws_moov_onboarding_writer(tenant_id));
DROP POLICY IF EXISTS aws_webhook_select_payment_provider_accounts ON public.payment_provider_accounts;
CREATE POLICY aws_webhook_select_payment_provider_accounts ON public.payment_provider_accounts
  FOR SELECT TO authenticated USING (public.aws_moov_webhook_apply_active());
DROP POLICY IF EXISTS aws_webhook_update_payment_provider_accounts ON public.payment_provider_accounts;
CREATE POLICY aws_webhook_update_payment_provider_accounts ON public.payment_provider_accounts
  FOR UPDATE TO authenticated
  USING (public.aws_moov_webhook_apply_active())
  WITH CHECK (public.aws_moov_webhook_apply_active());

DROP POLICY IF EXISTS aws_onboarding_insert_payment_provider_methods ON public.payment_provider_methods;
CREATE POLICY aws_onboarding_insert_payment_provider_methods ON public.payment_provider_methods
  FOR INSERT TO authenticated WITH CHECK (public.aws_moov_onboarding_writer(tenant_id));
DROP POLICY IF EXISTS aws_onboarding_update_payment_provider_methods ON public.payment_provider_methods;
CREATE POLICY aws_onboarding_update_payment_provider_methods ON public.payment_provider_methods
  FOR UPDATE TO authenticated
  USING (public.aws_moov_onboarding_writer(tenant_id))
  WITH CHECK (public.aws_moov_onboarding_writer(tenant_id));

DROP POLICY IF EXISTS aws_onboarding_insert_payment_method_verifications ON public.payment_method_verifications;
CREATE POLICY aws_onboarding_insert_payment_method_verifications ON public.payment_method_verifications
  FOR INSERT TO authenticated WITH CHECK (public.aws_moov_onboarding_writer(tenant_id));
DROP POLICY IF EXISTS aws_onboarding_update_payment_method_verifications ON public.payment_method_verifications;
CREATE POLICY aws_onboarding_update_payment_method_verifications ON public.payment_method_verifications
  FOR UPDATE TO authenticated
  USING (public.aws_moov_onboarding_writer(tenant_id))
  WITH CHECK (public.aws_moov_onboarding_writer(tenant_id));

DROP POLICY IF EXISTS aws_onboarding_insert_payment_event_log ON public.payment_event_log;
CREATE POLICY aws_onboarding_insert_payment_event_log ON public.payment_event_log
  FOR INSERT TO authenticated WITH CHECK (public.aws_moov_onboarding_writer(tenant_id));
DROP POLICY IF EXISTS aws_webhook_insert_payment_event_log ON public.payment_event_log;
CREATE POLICY aws_webhook_insert_payment_event_log ON public.payment_event_log
  FOR INSERT TO authenticated WITH CHECK (public.aws_moov_webhook_apply_active());

DROP POLICY IF EXISTS aws_onboarding_insert_payment_idempotency_keys ON public.payment_idempotency_keys;
CREATE POLICY aws_onboarding_insert_payment_idempotency_keys ON public.payment_idempotency_keys
  FOR INSERT TO authenticated WITH CHECK (public.aws_moov_onboarding_writer(tenant_id));
DROP POLICY IF EXISTS aws_onboarding_update_payment_idempotency_keys ON public.payment_idempotency_keys;
CREATE POLICY aws_onboarding_update_payment_idempotency_keys ON public.payment_idempotency_keys
  FOR UPDATE TO authenticated
  USING (public.aws_moov_onboarding_writer(tenant_id))
  WITH CHECK (public.aws_moov_onboarding_writer(tenant_id));
