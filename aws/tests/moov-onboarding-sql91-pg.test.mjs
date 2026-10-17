import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { enqueueOutbox, failOutboxAttempt, ONBOARDING_LOCK_SQL } from '../functions/api/providers/onboarding/store.mjs';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL91 = path.join(ROOT, 'workflows/sql/91_moov_onboarding.sql');
const PG_BIN = '/usr/lib/postgresql/16/bin';

const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER = '9b1f7a52-1c0e-4d5a-9a3f-5d6e7f8a9b0c';
const U = {
  owner: '10000000-0000-4000-8000-000000000001',
  admin: '10000000-0000-4000-8000-000000000002',
  manager: '10000000-0000-4000-8000-000000000003',
  viewer: '10000000-0000-4000-8000-000000000005',
  partner: '10000000-0000-4000-8000-000000000006',
  globalAdmin: '10000000-0000-4000-8000-000000000007',
  platform: '10000000-0000-4000-8000-000000000008',
};

const run = (bin, args, opts = {}) => spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts });
const mustRun = (bin, args, opts = {}) => {
  const result = run(bin, args, opts);
  if (result.status !== 0) throw new Error(`${bin} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result;
};

const SHIM = `
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT authenticated TO checksops;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO checksops, authenticated;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.app_user_id', true), '')::uuid
$$;
GRANT EXECUTE ON FUNCTION auth.uid() TO checksops, authenticated;
CREATE TABLE public.tenants (id uuid PRIMARY KEY, name text);
CREATE TABLE public.identity_accounts (application_user_id uuid PRIMARY KEY, email text, status text DEFAULT 'active');
CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text);
CREATE TABLE public.tenant_users (user_id uuid NOT NULL, tenant_id uuid NOT NULL, role text NOT NULL);
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role text NOT NULL);
CREATE FUNCTION public.is_platform_owner() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
  SELECT EXISTS (SELECT 1 FROM public.identity_accounts ia WHERE ia.application_user_id = auth.uid()
    AND ia.status IN ('active', 'isolated_test') AND lower(ia.email) = 'checksopsadmin@gmail.com');
$$;
CREATE FUNCTION public.is_master_owner() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT public.is_platform_owner(); $$;
CREATE FUNCTION public.aws_user_tenant_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
  SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = auth.uid();
$$;
CREATE FUNCTION public.aws_is_cross_tenant_reader() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(public.is_master_owner(), false) OR COALESCE(public.is_platform_owner(), false);
$$;
CREATE FUNCTION public.aws_can_access_tenant(_tenant_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
  SELECT _tenant_id IS NOT NULL AND (public.aws_is_cross_tenant_reader() OR _tenant_id IN (SELECT public.aws_user_tenant_ids()));
$$;
CREATE FUNCTION public.aws_is_authenticated() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
  SELECT auth.uid() IS NOT NULL;
$$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO checksops, authenticated;
CREATE TABLE public.payment_provider_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, environment text NOT NULL, provider_account_id text, onboarding_status text);
CREATE TABLE public.payment_provider_methods (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, environment text, last_four text);
CREATE TABLE public.payment_method_verifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, status text);
CREATE TABLE public.payment_event_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, event_type text);
CREATE TABLE public.payment_idempotency_keys (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, idempotency_key text, status text);
ALTER TABLE public.payment_provider_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_provider_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_method_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_event_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_idempotency_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY members_read ON public.payment_provider_accounts FOR SELECT TO authenticated USING (public.aws_can_access_tenant(tenant_id));
GRANT SELECT, INSERT, UPDATE ON public.payment_provider_accounts, public.payment_provider_methods, public.payment_method_verifications,
  public.payment_event_log, public.payment_idempotency_keys TO checksops, authenticated;
INSERT INTO public.tenants VALUES ('${TENANT}', 'Freedom'), ('${OTHER}', 'Partner');
INSERT INTO public.identity_accounts (application_user_id, email) VALUES
  ('${U.owner}', 'owner@x.test'), ('${U.admin}', 'admin@x.test'), ('${U.manager}', 'manager@x.test'),
  ('${U.viewer}', 'viewer@x.test'), ('${U.partner}', 'partner@x.test'), ('${U.globalAdmin}', 'gadmin@x.test'),
  ('${U.platform}', 'checksopsadmin@gmail.com');
INSERT INTO public.tenant_users VALUES
  ('${U.owner}', '${TENANT}', 'owner'), ('${U.admin}', '${TENANT}', 'admin'), ('${U.manager}', '${TENANT}', 'manager'),
  ('${U.viewer}', '${TENANT}', 'viewer'), ('${U.partner}', '${OTHER}', 'owner');
INSERT INTO public.user_roles VALUES ('${U.globalAdmin}', 'admin');
`;

test('disposable PostgreSQL SQL 91 Moov onboarding RLS matrix', { timeout: 180000 }, async (t) => {
  // The repo's shared helper (stakeholder-policies-pg.mjs) starts the server,
  // as the ubuntu account when the tests run as root.
  const skip = pgSkipReason(PG_BIN);
  if (skip) {
    t.skip(skip);
    return;
  }
  const server = startPg('pg-sql91-', 56100, { bin: PG_BIN });
  t.after(() => server.stop());
  const pgData = server.host;
  const port = server.port;
  const base = ['-h', pgData, '-p', String(port), '-v', 'ON_ERROR_STOP=1', '-X', '-q'];
  const psql = (user, db, input) => run(path.join(PG_BIN, 'psql'), [...base, '-U', user, '-d', db, '-A', '-t'], { input });
  mustRun(path.join(PG_BIN, 'createdb'), ['-h', pgData, '-p', String(port), '-U', 'ubuntu', 'sql91']);
  const shim = psql('ubuntu', 'sql91', SHIM);
  assert.equal(shim.status, 0, shim.stderr);
  const apply = psql('ubuntu', 'sql91', fs.readFileSync(SQL91, 'utf8'));
  assert.equal(apply.status, 0, apply.stderr);
  // Re-runnable: a second apply succeeds and changes nothing.
  const reapply = psql('ubuntu', 'sql91', fs.readFileSync(SQL91, 'utf8'));
  assert.equal(reapply.status, 0, reapply.stderr);

  /** Runs `sql` as checksops for `user`, with or without the onboarding GUC. Returns { ok, out, err }. */
  const as = (user, sql, { onboarding = true, webhook = false } = {}) => {
    const r = psql('checksops', 'sql91', `BEGIN;
SELECT set_config('request.app_user_id', '${user ?? ''}', true);
${onboarding ? "SELECT set_config('request.moov_onboarding', '1', true);" : ''}
${webhook ? "SELECT set_config('request.provider_webhook_apply', '1', true);" : ''}
${sql}
COMMIT;`);
    return { ok: r.status === 0, out: r.stdout.trim().split('\n').filter(Boolean).pop() ?? '', err: r.stderr };
  };
  const insertProfile = (tenant) => `INSERT INTO public.moov_onboarding_profiles (tenant_id, environment, legal_name)
    VALUES ('${tenant}', 'sandbox', 'X') ON CONFLICT (tenant_id, environment) DO UPDATE SET legal_name = EXCLUDED.legal_name;`;

  // Writers: any member (stored role ignored) and the platform owner (any tenant).
  for (const user of [U.owner, U.admin, U.manager, U.viewer, U.platform]) {
    assert.equal(as(user, insertProfile(TENANT)).ok, true, user);
  }
  assert.equal(as(U.platform, insertProfile(OTHER)).ok, true, 'platform owner other tenant');
  assert.equal(as(U.owner, insertProfile(OTHER)).ok, false, 'member of one tenant writing another');
  for (const user of [U.partner, U.globalAdmin, null]) {
    const r = as(user, insertProfile(TENANT));
    assert.equal(r.ok, false, `writer ${user}`);
    assert.match(r.err, /row-level security/);
  }
  // The GUC is required even for an owner (no direct /data path).
  assert.equal(as(U.owner, insertProfile(TENANT), { onboarding: false }).ok, false);

  // Readers: members and the platform owner; partners/global admins see nothing.
  const count = (user, table) => as(user, `SELECT count(*) FROM public.${table} WHERE tenant_id = '${TENANT}';`, { onboarding: false }).out;
  for (const user of [U.owner, U.manager, U.viewer, U.platform]) assert.equal(count(user, 'moov_onboarding_profiles'), '1', user);
  for (const user of [U.partner, U.globalAdmin, null]) assert.equal(count(user, 'moov_onboarding_profiles'), '0', user);

  // Representatives: last four only; plaintext shapes are rejected.
  const rep = (ssn) => `INSERT INTO public.moov_onboarding_representatives (tenant_id, environment, first_name, last_name, ssn_last4)
    VALUES ('${TENANT}', 'sandbox', 'Jane', 'Doe', '${ssn}');`;
  assert.equal(as(U.owner, rep('6789')).ok, true);
  assert.match(as(U.owner, rep('123456789')).err, /ssn_last4_check/);
  assert.equal(as(U.viewer, rep('6789')).ok, true);
  assert.equal(as(U.partner, rep('6789')).ok, false);
  assert.match(as(U.owner, `UPDATE public.moov_onboarding_profiles SET ein_ciphertext = '274444321', ein_last4 = '4321' WHERE tenant_id = '${TENANT}';`).err, /ein_ciphertext_check/);

  // Outbox: ids only.
  const outbox = (payload) => `INSERT INTO public.moov_onboarding_outbox (tenant_id, environment, kind, subject_id, payload)
    VALUES ('${TENANT}', 'sandbox', 'onboarding_sync', gen_random_uuid(), '${payload}'::jsonb);`;
  assert.equal(as(U.owner, outbox('{"profile_id":"12345678-1234-4123-8123-123456789012"}')).ok, true);
  for (const payload of ['{"ssn":"x"}', '{"rep":{"governmentID":{"ssn":{"full":"1"}}}}', '{"note":"123-45-6789"}', '{"v":"123456789"}', '{"dob":"1980-01-01"}', '{"accountNumber":"1"}']) {
    assert.match(as(U.owner, outbox(payload)).err, /payload_no_pii/, payload);
  }

  // Documents: upload key files/verification-docs/uploads/{tenant}/{id}; final key .../final/{tenant}/{id}.
  const DOC = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const doc = (key) => `INSERT INTO public.moov_compliance_documents (id, tenant_id, environment, purpose, file_name, content_type, size_bytes, storage_key, kms_key_arn)
    VALUES ('${DOC}', '${TENANT}', 'sandbox', 'w9', 'w9.pdf', 'application/pdf', 100, '${key}', 'arn:k');`;
  assert.match(as(U.owner, doc(`files/verification-docs/uploads/${OTHER}/${DOC}`)).err, /storage_key_check/);
  assert.match(as(U.owner, doc(`files/verification-docs/final/${TENANT}/${DOC}`)).err, /storage_key_check/);
  assert.match(as(U.owner, doc(`files/tenant-documents/${TENANT}/verification/${DOC}`)).err, /storage_key_check/);
  assert.equal(as(U.owner, doc(`files/verification-docs/uploads/${TENANT}/${DOC}`)).ok, true);
  // A verified document must be pinned to an S3 version.
  assert.match(as(U.owner, `UPDATE public.moov_compliance_documents SET status = 'stored' WHERE id = '${DOC}';`).err, /version_check/);
  assert.match(as(U.owner, `UPDATE public.moov_compliance_documents SET status = 'stored', s3_version_id = 'v1' WHERE id = '${DOC}';`).err, /version_check/);
  assert.match(as(U.owner, `UPDATE public.moov_compliance_documents SET final_storage_key = 'files/verification-docs/uploads/${TENANT}/${DOC}' WHERE id = '${DOC}';`).err, /final_key_check/);
  assert.equal(as(U.owner, `UPDATE public.moov_compliance_documents SET status = 'stored', s3_version_id = 'v1', final_storage_key = 'files/verification-docs/final/${TENANT}/${DOC}' WHERE id = '${DOC}';`).ok, true);

  // Real outbox SQL from store.mjs: ON CONFLICT enqueue, backoff, failed after 10.
  const literal = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  const render = (sql, params) => sql.replace(/\$(\d+)/g, (_, n) => literal(params[Number(n) - 1]));
  const captured = [];
  const capture = { query: async (sql, params = []) => { captured.push(render(sql, params)); return { rows: [] }; } };
  const SUBJECT = 'cccccccc-dddd-4eee-8fff-000000000001';
  await enqueueOutbox(capture, { tenantId: TENANT, environment: 'sandbox', kind: 'onboarding_sync', subjectId: SUBJECT, userId: U.owner, payload: { profile_id: SUBJECT } });
  const enqueue = `${captured[0]};`;
  assert.equal(as(U.owner, enqueue).ok, true);
  const again = as(U.owner, enqueue);
  assert.equal(again.ok, true, again.err);
  const pendingCount = () => as(U.owner, `SELECT count(*) FROM public.moov_onboarding_outbox WHERE subject_id = '${SUBJECT}' AND status = 'pending';`, { onboarding: false }).out;
  assert.equal(pendingCount(), '1');
  const id = as(U.owner, `SELECT id FROM public.moov_onboarding_outbox WHERE subject_id = '${SUBJECT}';`, { onboarding: false }).out;
  captured.length = 0;
  await failOutboxAttempt(capture, { id, errorCode: 'moov_unavailable' });
  const failSql = `${captured[0]};`;
  assert.equal(as(U.owner, failSql).ok, true);
  const state = () => as(U.owner, `SELECT concat_ws('/', status, attempts, (next_attempt_at > now())::text) FROM public.moov_onboarding_outbox WHERE id = '${id}';`, { onboarding: false }).out;
  assert.equal(state(), 'pending/1/true');
  for (let i = 0; i < 12; i += 1) assert.equal(as(U.owner, failSql).ok, true);
  assert.equal(state(), 'failed/10');
  // A fresh pending row can be enqueued after failure.
  assert.equal(as(U.owner, enqueue).ok, true);
  assert.equal(pendingCount(), '1');
  // Advisory lock SQL runs as checksops.
  assert.equal(as(U.owner, ONBOARDING_LOCK_SQL.replace('$1', `'${TENANT}'`).replace('$2', "'sandbox'") + ';').ok, true);

  // Existing payment tables: onboarding writes for owner/admin/platform only.
  const method = `INSERT INTO public.payment_provider_methods (tenant_id, environment, last_four) VALUES ('${TENANT}', 'sandbox', '6789');`;
  assert.equal(as(U.owner, method).ok, true);
  assert.equal(as(U.viewer, method).ok, true);
  assert.equal(as(U.partner, method).ok, false);
  assert.equal(as(U.globalAdmin, method).ok, false);
  assert.match(as(U.owner, `INSERT INTO public.payment_provider_methods (tenant_id, environment, routing_last_four) VALUES ('${TENANT}', 'sandbox', '021000021');`).err, /routing_last_four_check/);
  assert.equal(as(U.owner, `INSERT INTO public.payment_provider_accounts (tenant_id, environment, provider_account_id) VALUES ('${TENANT}', 'sandbox', 'm1');`).ok, true);
  assert.equal(as(U.partner, `INSERT INTO public.payment_event_log (tenant_id, event_type) VALUES ('${TENANT}', 'x');`).ok, false);
  assert.equal(as(U.viewer, `INSERT INTO public.payment_event_log (tenant_id, event_type) VALUES ('${TENANT}', 'x');`, { onboarding: false }).ok, false);

  // Webhook apply (no user): status updates only with the server webhook GUC.
  const stamp2 = `UPDATE public.moov_onboarding_profiles SET last_webhook_event_type = 'capability.updated' WHERE tenant_id = '${TENANT}' RETURNING 1;`;
  assert.equal(as(null, stamp2, { onboarding: false }).out, '');
  assert.equal(as(null, stamp2, { onboarding: false, webhook: true }).out, '1');
  // No DELETE grant on onboarding tables.
  assert.match(as(U.owner, `DELETE FROM public.moov_onboarding_representatives WHERE tenant_id = '${TENANT}';`).err, /permission denied/);
});
