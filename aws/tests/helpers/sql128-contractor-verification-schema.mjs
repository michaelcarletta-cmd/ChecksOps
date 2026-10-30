/**
 * SQL 128 (aws/workflows/sql/128_contractor_verification_from_compliance.sql) test support: the
 * Supabase-era contractor tier functions as supabase migration 20260709105400 defines them (the
 * bodies restored onto the AWS databases), SQL 128's edits to contractor_verification_status, and
 * the extra schema for the release fixture (helpers/release-sql-pg.mjs).
 *
 *   - supabaseStatement(name) / supabaseBody(name): the CREATE statement and the body exactly as
 *     the supabase migration has them;
 *   - sql128Body(): the supabase contractor_verification_status body with SQL 128's two document
 *     checks in place of the contractor_documents reads (the edit must match exactly once);
 *   - contractorVerificationSchema(): run as the superuser before the fixture hands schema public
 *     to checksops_admin: contractor_profiles, contractor_reviews and moov_compliance_documents with
 *     the columns the bodies read, tenant_documents.expires_at and the library doc_type values, the
 *     functions and two triggers as supabase creates them (contractor_documents is gone, so the
 *     docs trigger function is left without its trigger, as on the AWS databases), and the rows
 *     the behavior test reads.
 *
 * Rows (on the fixture's TENANT_A / MEMBER_A and TENANT_B / MEMBER_B; TENANT_A already has a
 * legacy 'w9' tenant_documents row from the fixture seed):
 *   PROFILE_A  MEMBER_A's profile (license on file);
 *   PROFILE_B  MEMBER_B's profile (license on file);
 *   PROFILE_C  CONTRACTOR_C's profile, a user with no tenant.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MEMBER_A, MEMBER_B, REPO_ROOT, TENANT_A, TENANT_B } from './release-sql-pg.mjs';

export const SUPABASE_FILE = path.join(REPO_ROOT, 'supabase/migrations/20260709105400_28d3f3e9-3ef2-4740-9889-313ff9d16cd6.sql');
export const SQL128_FILE = path.join(REPO_ROOT, 'aws/workflows/sql/128_contractor_verification_from_compliance.sql');
export const STATUS_IDENTITY = 'public.contractor_verification_status(uuid)';
export const DOCS_TRIGGER_IDENTITY = 'public._trg_recompute_contractor_tier_from_docs()';

export const PROFILE_A = 'c0000000-0000-4000-8000-0000000000a1';
export const PROFILE_B = 'c0000000-0000-4000-8000-0000000000b1';
export const PROFILE_C = 'c0000000-0000-4000-8000-0000000000c1';
export const CONTRACTOR_C = 'a1000000-0000-4000-8000-0000000000c1';

const SUPABASE = fs.readFileSync(SUPABASE_FILE, 'utf8');

const locate = (name) => {
  const start = SUPABASE.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) throw new Error(`${name} not found in the supabase migration`);
  const open = SUPABASE.indexOf('AS $$', start);
  const close = SUPABASE.indexOf('$$;', open + 5);
  if (open < 0 || close < 0) throw new Error(`${name} body not found`);
  return { statement: SUPABASE.slice(start, close + 3), body: SUPABASE.slice(open + 5, close) };
};

export const supabaseStatement = (name) => locate(name).statement;
export const supabaseBody = (name) => locate(name).body;

const OLD_CHECKS = `  SELECT EXISTS (
    SELECT 1 FROM public.contractor_documents
    WHERE contractor_id = p_contractor_id AND document_type ILIKE '%w-9%' OR document_type ILIKE 'w9%'
  ) INTO v_w9;

  SELECT EXISTS (
    SELECT 1 FROM public.contractor_documents
    WHERE contractor_id = p_contractor_id
      AND (document_type ILIKE '%coi%' OR document_type ILIKE '%insurance%')
      AND (expiration_date IS NULL OR expiration_date >= CURRENT_DATE)
  ) INTO v_coi_ok;`;

const NEW_CHECKS = `  -- SQL 128: the W-9 and insurance the contractor's tenants uploaded on Compliance & Docs.
  SELECT EXISTS (
    SELECT 1 FROM public.moov_compliance_documents d
    WHERE d.tenant_id IN (SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = v_profile.user_id)
      AND d.purpose = 'w9'
      AND d.status IN ('stored', 'sent')
  ) OR EXISTS (
    SELECT 1 FROM public.tenant_documents t
    WHERE t.tenant_id IN (SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = v_profile.user_id)
      AND t.doc_type IN ('library:mortgage:w-9', 'w9')
  ) INTO v_w9;

  SELECT EXISTS (
    SELECT 1 FROM public.moov_compliance_documents d
    WHERE d.tenant_id IN (SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = v_profile.user_id)
      AND d.purpose = 'insurance'
      AND d.status IN ('stored', 'sent')
  ) OR EXISTS (
    SELECT 1 FROM public.tenant_documents t
    WHERE t.tenant_id IN (SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = v_profile.user_id)
      AND t.doc_type IN (
        'library:mortgage:certificate-of-insurance',
        'library:mortgage:general-liability-insurance',
        'library:mortgage:workers-comp-insurance',
        'insurance'
      )
      AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
  ) INTO v_coi_ok;`;

/** The supabase body with SQL 128's edit: only the two document checks change. */
export function sql128Body() {
  const body = supabaseBody('contractor_verification_status');
  if (body.split(OLD_CHECKS).length !== 2) throw new Error('the supabase document checks changed');
  return body.replace(OLD_CHECKS, NEW_CHECKS);
}

// The supabase CREATE TRIGGER statements for the reviews and profile triggers (the docs trigger
// went with contractor_documents).
const TRIGGERS = `
CREATE TRIGGER recompute_tier_on_reviews
AFTER INSERT OR UPDATE OR DELETE ON public.contractor_reviews
FOR EACH ROW EXECUTE FUNCTION public._trg_recompute_contractor_tier_from_reviews();
CREATE TRIGGER recompute_tier_on_profile
AFTER UPDATE ON public.contractor_profiles
FOR EACH ROW EXECUTE FUNCTION public._trg_recompute_contractor_tier_from_profile();
`;

const TABLES = `
-- The fixture's contractor_profiles (id, user_id, tier) with the supabase columns the bodies read.
ALTER TABLE public.contractor_profiles ALTER COLUMN tier SET DEFAULT 'guest',
  ADD COLUMN display_name text NOT NULL DEFAULT 'Contractor', ADD COLUMN license_number text, ADD COLUMN coi_expires_at date,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN verified_at timestamptz, ADD COLUMN pro_approved_at timestamptz, ADD COLUMN pro_approved_by uuid,
  ADD COLUMN admin_disbursed_verified boolean NOT NULL DEFAULT false, ADD COLUMN has_open_disputes boolean NOT NULL DEFAULT false,
  ADD COLUMN verification_notes text;
CREATE TABLE public.contractor_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL REFERENCES public.contractor_profiles(id) ON DELETE CASCADE,
  org_id uuid, author_user_id uuid, rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5), comment text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.moov_compliance_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, environment text NOT NULL,
  purpose text NOT NULL, file_name text NOT NULL DEFAULT 'doc.pdf', status text NOT NULL DEFAULT 'pending_upload',
  CONSTRAINT moov_compliance_documents_environment_check CHECK (environment IN ('sandbox', 'production')),
  CONSTRAINT moov_compliance_documents_status_check CHECK (status IN ('pending_upload', 'stored', 'sent', 'rejected')),
  CONSTRAINT moov_compliance_documents_purpose_check CHECK (purpose IN (
    'business_verification', 'identity_verification', 'individual_verification',
    'representative_verification', 'w9', 'bank_statement', 'license', 'insurance',
    'saas_agreement', 'terms_of_service', 'privacy_policy')));
ALTER TABLE public.tenant_documents ADD COLUMN expires_at date;
ALTER TABLE public.tenant_documents DROP CONSTRAINT tenant_documents_doc_type_check;
ALTER TABLE public.tenant_documents ADD CONSTRAINT tenant_documents_doc_type_check
  CHECK (doc_type IN ('w9','license','insurance','saas_agreement','terms_of_service','privacy_policy')
    OR doc_type LIKE 'library:%');
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contractor_profiles, public.contractor_reviews, public.moov_compliance_documents TO checksops;
`;

const ROWS = `
INSERT INTO public.identity_accounts (application_user_id, email, status) VALUES ('${CONTRACTOR_C}', 'contractor-c@example.invalid', 'active');
INSERT INTO public.contractor_profiles (id, user_id, display_name, license_number, created_at) VALUES
  ('${PROFILE_A}', '${MEMBER_A}', 'A Roofing', 'LIC-A', now() - interval '200 days'),
  ('${PROFILE_B}', '${MEMBER_B}', 'B Roofing', 'LIC-B', now() - interval '200 days'),
  ('${PROFILE_C}', '${CONTRACTOR_C}', 'C Roofing', 'LIC-C', now() - interval '200 days');
`;

/** Extra schema for releaseFixture({ extra }): tables, the restored supabase functions, rows. */
export function contractorVerificationSchema() {
  return [
    TABLES,
    supabaseStatement('contractor_verification_status'),
    supabaseStatement('recompute_contractor_tier'),
    supabaseStatement('_trg_recompute_contractor_tier_from_docs'),
    supabaseStatement('_trg_recompute_contractor_tier_from_reviews'),
    supabaseStatement('_trg_recompute_contractor_tier_from_profile'),
    TRIGGERS,
    ROWS,
  ];
}

export { MEMBER_A, MEMBER_B, TENANT_A, TENANT_B };
