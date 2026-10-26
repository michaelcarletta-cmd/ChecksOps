import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL102 = path.join(ROOT, 'workflows/sql/102_platform_owner_tenant_profile.sql');
const SQL117 = path.join(ROOT, 'workflows/sql/117_platform_owner_tenant_lifecycle.sql');
const PG_BIN = '/usr/lib/postgresql/16/bin';

const OWNER = '10000000-0000-4000-8000-0000000000aa';
const MEMBER = '10000000-0000-4000-8000-000000000001';
const T = {
  busy: '20000000-0000-4000-8000-000000000001',
  empty: '20000000-0000-4000-8000-000000000002',
  ledger: '20000000-0000-4000-8000-000000000003',
  system: '20000000-0000-4000-8000-000000000004',
};

const run = (bin, args, opts = {}) => spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts });

// The real SQL 102 column guard, so the subscription_status writes go through it.
const guardFunction = () => {
  const sql = fs.readFileSync(SQL102, 'utf8');
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.aws_tenants_member_column_guard()');
  const end = sql.indexOf('\n$$;', start);
  assert.ok(start >= 0 && end > start, 'SQL 102 guard function not found');
  return sql.slice(start, end + 4);
};

const SHIM = () => `
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT authenticated TO checksops;
GRANT USAGE ON SCHEMA public TO checksops, authenticated;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO checksops, authenticated;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.app_user_id', true), '')::uuid
$$;
GRANT EXECUTE ON FUNCTION auth.uid() TO checksops, authenticated;
CREATE TABLE public.tenants (
  id uuid PRIMARY KEY, name text NOT NULL, slug text UNIQUE NOT NULL,
  subscription_status text DEFAULT 'inactive', is_system_tenant boolean DEFAULT false,
  moov_environment text, is_test_account boolean DEFAULT false,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.tenant_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL, role text NOT NULL,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE TABLE public.tenant_pricing_audit (
  id bigserial PRIMARY KEY, tenant_id uuid NOT NULL, actor_id uuid, field text NOT NULL,
  old_value jsonb, new_value jsonb, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE);
CREATE TABLE public.tenant_settings_example (tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE);
CREATE TABLE public.ledger_example (tenant_id uuid CONSTRAINT ledger_example_tenant_fk REFERENCES public.tenants(id));
CREATE FUNCTION public.is_platform_owner() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT auth.uid() = '${OWNER}'::uuid $$;
CREATE FUNCTION public.aws_is_authenticated() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT auth.uid() IS NOT NULL $$;
CREATE FUNCTION public.aws_is_tenant_member(_t uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.tenant_users WHERE tenant_id = _t AND user_id = auth.uid())
$$;
CREATE FUNCTION public.aws_tenant_pricing_columns() RETURNS text[] LANGUAGE sql AS $$ SELECT ARRAY['monthly_rate_cents'] $$;
CREATE FUNCTION public.aws_tenant_profile_columns() RETURNS text[] LANGUAGE sql AS $$
  SELECT ARRAY['name', 'custom_domain', 'subscription_status', 'max_checks_per_month', 'is_test_account', 'kyc_status', 'kyc_notes', 'internal_notes']
$$;
CREATE FUNCTION public.aws_tenant_has_moov_account(_t uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
${guardFunction()}
CREATE TRIGGER aws_tenants_member_column_guard BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.aws_tenants_member_column_guard();
INSERT INTO public.tenants (id, name, slug, subscription_status, is_system_tenant) VALUES
  ('${T.busy}', 'Busy Co', 'busy-co', 'trial', false),
  ('${T.empty}', 'Empty Test', 'empty-test', 'active', false),
  ('${T.ledger}', 'Ledger Co', 'ledger-co', 'active', false),
  ('${T.system}', 'ChecksOps', 'checksops', 'active', true);
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  ('${T.busy}', '${MEMBER}', 'admin'),
  ('${T.busy}', '10000000-0000-4000-8000-000000000002', 'staff'),
  ('${T.empty}', '${MEMBER}', 'admin');
INSERT INTO public.check_intake_items (tenant_id) VALUES ('${T.busy}');
INSERT INTO public.tenant_settings_example (tenant_id) VALUES ('${T.empty}');
INSERT INTO public.ledger_example (tenant_id) VALUES ('${T.ledger}');
`;

test('SQL 117 tenant lifecycle: deactivate, reactivate, activity and delete-empty', (t) => {
  const skip = pgSkipReason(PG_BIN);
  if (skip) {
    t.skip(skip);
    return;
  }
  const server = startPg('pg-sql117-', 56300, { bin: PG_BIN });
  t.after(() => server.stop());
  const base = ['-h', server.host, '-p', String(server.port), '-v', 'ON_ERROR_STOP=1', '-X', '-q'];
  const psql = (user, input) => run(path.join(PG_BIN, 'psql'), [...base, '-U', user, '-d', 'sql117', '-A', '-t'], { input });
  const createdb = run(path.join(PG_BIN, 'createdb'), ['-h', server.host, '-p', String(server.port), '-U', 'ubuntu', 'sql117']);
  assert.equal(createdb.status, 0, createdb.stderr);
  const shim = psql('ubuntu', SHIM());
  assert.equal(shim.status, 0, shim.stderr);
  const apply = psql('ubuntu', fs.readFileSync(SQL117, 'utf8'));
  assert.equal(apply.status, 0, apply.stderr);
  const reapply = psql('ubuntu', fs.readFileSync(SQL117, 'utf8'));
  assert.equal(reapply.status, 0, reapply.stderr);

  // One statement as the API role, acting as `user`. Returns { ok, out, err }.
  const as = (user, sql) => {
    const r = psql('checksops', `SET request.app_user_id = '${user}';\n${sql}`);
    return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr };
  };
  const json = (r) => {
    assert.ok(r.ok, r.err);
    return JSON.parse(r.out);
  };
  const db = (sql) => {
    const r = psql('ubuntu', sql);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };

  // Only the platform owner, and the API role cannot touch the table directly.
  const refused = as(MEMBER, `SELECT public.aws_platform_owner_deactivate_tenant('${T.busy}', 'x');`);
  assert.equal(refused.ok, false);
  assert.match(refused.err, /not_authorized: platform owner required/);
  assert.match(as(OWNER, 'SELECT count(*) FROM public.tenant_deactivations;').err, /permission denied/);

  // Deactivate: memberships suspended, status inactive (through the SQL 102 guard), audited.
  const off = json(as(OWNER, `SELECT public.aws_platform_owner_deactivate_tenant('${T.busy}', 'Closed account');`));
  assert.deepEqual(off, { ok: true, tenant_id: T.busy, already_deactivated: false, suspended: 2 });
  assert.equal(db(`SELECT count(*) FROM public.tenant_users WHERE tenant_id = '${T.busy}';`), '0');
  assert.equal(db(`SELECT subscription_status FROM public.tenants WHERE id = '${T.busy}';`), 'inactive');
  assert.equal(db(`SELECT previous_subscription_status || '|' || reason || '|' || jsonb_array_length(memberships) FROM public.tenant_deactivations;`), 'trial|Closed account|2');
  assert.equal(db(`SELECT count(*) FROM public.tenant_pricing_audit WHERE tenant_id = '${T.busy}' AND field = 'tenant_deactivated';`), '1');
  assert.equal(db(`SELECT count(*) FROM public.tenant_users WHERE tenant_id = '${T.empty}';`), '1', 'other tenants keep their members');
  const again = json(as(OWNER, `SELECT public.aws_platform_owner_deactivate_tenant('${T.busy}', NULL);`));
  assert.equal(again.already_deactivated, true);

  const listed = as(OWNER, 'SELECT tenant_id || \'|\' || suspended_memberships FROM public.aws_platform_owner_deactivated_tenants();');
  assert.equal(listed.out, `${T.busy}|2`);

  // The system tenant is never deactivated or deleted.
  assert.match(as(OWNER, `SELECT public.aws_platform_owner_deactivate_tenant('${T.system}', NULL);`).err, /system_tenant_protected/);
  assert.match(as(OWNER, `SELECT public.aws_platform_owner_delete_empty_tenant('${T.system}', 'checksops');`).err, /system_tenant_protected/);

  // Reactivate: the same rows come back, a membership added since is kept, the exact previous status returns.
  db(`INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ('${T.busy}', '${MEMBER}', 'admin');`);
  const on = json(as(OWNER, `SELECT public.aws_platform_owner_reactivate_tenant('${T.busy}');`));
  assert.deepEqual(on, { ok: true, tenant_id: T.busy, already_active: false, restored: 1 });
  assert.equal(db(`SELECT count(*) FROM public.tenant_users WHERE tenant_id = '${T.busy}';`), '2');
  assert.equal(db(`SELECT subscription_status FROM public.tenants WHERE id = '${T.busy}';`), 'trial');
  assert.equal(db('SELECT count(*) FROM public.tenant_deactivations;'), '0');
  assert.equal(json(as(OWNER, `SELECT public.aws_platform_owner_reactivate_tenant('${T.busy}');`)).already_active, true);

  // Activity: checks and money rows block a permanent delete.
  const busy = json(as(OWNER, `SELECT public.aws_platform_owner_tenant_activity('${T.busy}');`));
  assert.equal(busy.empty, false);
  assert.equal(busy.counts.check_intake_items, 1);
  assert.match(as(OWNER, `SELECT public.aws_platform_owner_delete_empty_tenant('${T.busy}', 'busy-co');`).err, /tenant_not_empty/);
  assert.equal(db(`SELECT count(*) FROM public.tenants WHERE id = '${T.busy}';`), '1');

  // Delete-empty: the typed slug must match; then the row and its cascades go, the audit stays.
  assert.match(as(OWNER, `SELECT public.aws_platform_owner_delete_empty_tenant('${T.empty}', 'wrong');`).err, /confirmation_mismatch/);
  assert.equal(json(as(OWNER, `SELECT public.aws_platform_owner_tenant_activity('${T.empty}');`)).empty, true);
  const gone = json(as(OWNER, `SELECT public.aws_platform_owner_delete_empty_tenant('${T.empty}', 'Empty-Test');`));
  assert.deepEqual(gone, { ok: true, tenant_id: T.empty, deleted: true, slug: 'empty-test' });
  assert.equal(db(`SELECT count(*) FROM public.tenants WHERE id = '${T.empty}';`), '0');
  assert.equal(db(`SELECT count(*) FROM public.tenant_settings_example WHERE tenant_id = '${T.empty}';`), '0');
  assert.equal(db(`SELECT count(*) FROM public.tenant_pricing_audit WHERE tenant_id = '${T.empty}' AND field = 'tenant_deleted';`), '1');

  // A row in a table without a cascade refuses the delete with the constraint's name; nothing changes.
  const ledger = as(OWNER, `SELECT public.aws_platform_owner_delete_empty_tenant('${T.ledger}', 'ledger-co');`);
  assert.equal(ledger.ok, false);
  assert.match(ledger.err, /tenant_has_records/);
  assert.match(ledger.err, /ledger_example_tenant_fk/);
  assert.equal(db(`SELECT count(*) FROM public.tenants WHERE id = '${T.ledger}';`), '1');
  assert.equal(db(`SELECT count(*) FROM public.tenant_pricing_audit WHERE tenant_id = '${T.ledger}' AND field = 'tenant_deleted';`), '0');
});
