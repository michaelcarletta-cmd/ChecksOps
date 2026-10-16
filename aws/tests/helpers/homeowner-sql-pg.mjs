/**
 * PostgreSQL 16 fixture for the SQL 82 / SQL 83 guarded tooling tests: the
 * homeowner tables the two files read (columns as in
 * homeowner-signing-capabilities-sql.test.mjs), status CHECK constraints, RLS on
 * the six homeowner tables, a non-superuser login that owns them (like
 * checksops_admin), and the Cursor branch's SQL 73 / SQL 74 functions that staging
 * is expected to carry.
 *
 * The Cursor files are byte copies from history (commit dba4a9be2):
 *   aws/tests/fixtures/cursor-sql73-homeowner-ledger-view.sql            sha256 02a19f8e…
 *   aws/tests/fixtures/cursor-sql74-homeowner-signing-rls-boundary.sql   sha256 a7ee929b…
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CURSOR_SQL73_FILE = path.join(TESTS, 'fixtures/cursor-sql73-homeowner-ledger-view.sql');
export const CURSOR_SQL74_FILE = path.join(TESTS, 'fixtures/cursor-sql74-homeowner-signing-rls-boundary.sql');
export const CURSOR_SQL73_SHA256 = '02a19f8ef11cb3e60122b1ff1e07dd331f95a677d13028564d497ef06e523c9e';
export const CURSOR_SQL74_SHA256 = 'a7ee929bc25a7ca56bf29dacebdab20198bf1a7625e661333545dc9d1f662c4f';
export const cursorSql73 = () => fs.readFileSync(CURSOR_SQL73_FILE, 'utf8');
export const cursorSql74 = () => fs.readFileSync(CURSOR_SQL74_FILE, 'utf8');

const TABLES = `
CREATE TABLE public.homeowner_ledger_tokens (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, claim_id uuid, token text NOT NULL,
  homeowner_email text, homeowner_name text, revoked_at timestamptz, expires_at timestamptz,
  last_viewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.claims (
  id uuid PRIMARY KEY, org_id uuid, claim_number text, policyholder_address text, loss_type text,
  status text, created_at timestamptz);
CREATE TABLE public.check_intake_items (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, claim_id uuid, amount numeric, check_stage text, check_number text);
CREATE TABLE public.homeowner_ledger_events (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, claim_id uuid NOT NULL, check_id uuid, event_type text,
  occurred_at timestamptz NOT NULL, amount numeric, actor_label text, payload_json jsonb);
CREATE TABLE public.homeowner_ledger_check_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_id uuid, tenant_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.check_endorsements (
  id uuid PRIMARY KEY, check_id uuid NOT NULL, tenant_id uuid, payee_name text, payee_type text, status text,
  token text, contact_email text, signed_at timestamptz, request_sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT check_endorsements_status_check CHECK (status IN ('pending', 'sent', 'signed', 'completed', 'cancelled')),
  CONSTRAINT check_endorsements_payee_type_check CHECK (payee_type IN ('insured', 'mortgage_company', 'public_adjuster', 'contractor')));
CREATE TABLE public.disbursement_batches (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, check_intake_item_id uuid);
CREATE TABLE public.disbursement_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid NOT NULL, tenant_id uuid NOT NULL, amount numeric, status text);
CREATE TABLE public.claim_disbursements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid NOT NULL, check_id uuid, amount numeric, status text);
CREATE TABLE public.signature_requests (
  id uuid PRIMARY KEY, claim_id uuid, check_intake_item_id uuid, document_name text NOT NULL,
  document_path text NOT NULL DEFAULT 'doc.pdf', status text NOT NULL DEFAULT 'pending', sent_at timestamptz,
  completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT signature_requests_status_check CHECK (status IN ('draft', 'pending', 'in_progress', 'completed', 'cancelled')));
CREATE TABLE public.signature_signers (
  id uuid PRIMARY KEY, signature_request_id uuid NOT NULL, signer_name text NOT NULL, signer_email text NOT NULL,
  signer_type text NOT NULL, signing_order integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'pending',
  signed_at timestamptz, access_token text, token_hash text, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT signature_signers_status_check CHECK (status IN ('pending', 'signed', 'declined')));
`;

/** Seeded row values (names, emails, document names) that must never appear in any inspect output. */
export const SEEDED_PII = Object.freeze(['Private Person', 'Other Person', 'private@example.com', 'Private.pdf']);
export function assertNoSeededPii(assert, value, label = 'output') {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const pii of SEEDED_PII) assert.equal(text.includes(pii), false, `${label} contains ${pii}`);
}

export const HOMEOWNER_RLS_TABLE_NAMES = Object.freeze([
  'homeowner_ledger_tokens', 'check_endorsements', 'signature_requests', 'signature_signers', 'check_intake_items', 'claims',
]);
const ALL_TABLES = [
  'homeowner_ledger_tokens', 'claims', 'check_intake_items', 'homeowner_ledger_events', 'homeowner_ledger_check_uploads',
  'check_endorsements', 'disbursement_batches', 'disbursement_splits', 'claim_disbursements', 'signature_requests', 'signature_signers',
];

/**
 * Roles, tables (owned by `owner`, a non-superuser login), RLS on the six
 * homeowner tables and a few rows for the aggregate counts. Run as the superuser.
 */
export function homeownerSchemaSql(owner) {
  return `
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE checksops NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE ROLE ${owner} LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE, CREATE ON SCHEMA public TO ${owner};
GRANT USAGE ON SCHEMA auth TO ${owner};
${TABLES}
${ALL_TABLES.map((table) => `ALTER TABLE public.${table} OWNER TO ${owner};`).join('\n')}
${HOMEOWNER_RLS_TABLE_NAMES.map((table) => `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`).join('\n')}
INSERT INTO public.claims (id, org_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '11111111-1111-4111-8111-111111111111');
INSERT INTO public.check_intake_items (id, tenant_id, claim_id) VALUES
  ('33333333-3333-4333-8333-333333333331', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
INSERT INTO public.check_endorsements (id, check_id, tenant_id, payee_name, payee_type, status, contact_email) VALUES
  ('d1111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333331', '11111111-1111-4111-8111-111111111111', 'Private Person', 'insured', 'sent', 'private@example.com'),
  ('d2222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333331', '11111111-1111-4111-8111-111111111111', 'Bank', 'mortgage_company', 'pending', NULL),
  ('d3333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333331', '11111111-1111-4111-8111-111111111111', 'Other Person', 'insured', 'sent', NULL);
INSERT INTO public.signature_requests (id, claim_id, document_name, status) VALUES
  ('5a111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'Private.pdf', 'pending');
INSERT INTO public.signature_signers (id, signature_request_id, signer_name, signer_email, signer_type, status) VALUES
  ('5b111111-1111-4111-8111-111111111111', '5a111111-1111-4111-8111-111111111111', 'Private Person', 'private@example.com', 'insured', 'pending');
`;
}

/** Cursor's legacy re-mint doorway (in no committed file; its shape is assumed). The inspect only reports it. */
export const LEGACY_REMINT_SQL = `
CREATE FUNCTION public.aws_public_homeowner_ledger_remint_signer(p_token text, p_signer_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT NULL::jsonb $$;
`;
