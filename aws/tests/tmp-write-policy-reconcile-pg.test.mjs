import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REMAINING_POLICY_NAMES } from '../rls/tmp-write-policy-reconcile.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APPLY = path.join(ROOT, 'aws/rls/sql/39_tmp_write_policy_reconcile.sql');
const ROLLBACK = path.join(ROOT, 'aws/rls/sql/39_tmp_write_policy_reconcile_rollback.sql');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const ARTIFACT_DIR = '/opt/cursor/artifacts/tmp-rls-write-drift-repair';

const T1 = 'db13cc17-547b-4ca8-806a-f3cf79eafe59';
const T2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const ADMIN = '75d3da03-326c-4ea0-8cd1-684d695495a3';
const ORDINARY = '11111111-1111-4111-8111-111111111111';
const PLATFORM = '7dbb3009-0000-4000-8000-000000000001';
const ROW1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';

const run = (bin, args, opts = {}) => spawnSync(bin, args, {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
  ...opts,
});

const mustRun = (bin, args, opts = {}) => {
  const result = run(bin, args, opts);
  if (result.status !== 0) {
    throw new Error(`${bin} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
};

const fixtureSql = `
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE checksops NOLOGIN INHERIT;
CREATE ROLE checksops_admin NOLOGIN;
GRANT authenticated TO checksops;
GRANT checksops TO CURRENT_USER;
GRANT anon TO CURRENT_USER;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE raw text;
BEGIN
  raw := nullif(current_setting('request.app_user_id', true), '');
  IF raw IS NULL THEN RETURN NULL; END IF;
  RETURN raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'request.app_user_id is not a uuid';
END;
$$;

CREATE TYPE public.app_role AS ENUM ('admin', 'staff', 'client', 'contractor');
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  email text NOT NULL
);
CREATE TABLE public.user_roles (
  user_id uuid NOT NULL,
  role public.app_role NOT NULL,
  PRIMARY KEY (user_id, role)
);
CREATE TABLE public.tenant_users (
  user_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  PRIMARY KEY (user_id, tenant_id)
);
CREATE TABLE public.identity_accounts (
  application_user_id uuid PRIMARY KEY,
  status text NOT NULL,
  email text NOT NULL
);
CREATE TABLE public.tenant_maintenance_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  amount_cents integer NOT NULL DEFAULT 1,
  status text,
  billing_period text,
  notes text,
  settled_at timestamptz,
  returned_at timestamptz,
  return_reason text,
  failure_reason text,
  updated_at timestamptz
);
ALTER TABLE public.tenant_maintenance_payments OWNER TO checksops_admin;
GRANT SELECT, INSERT, UPDATE ON public.tenant_maintenance_payments TO checksops, authenticated;
ALTER TABLE public.tenant_maintenance_payments ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role
  );
$$;

CREATE OR REPLACE FUNCTION public.aws_monthly_billing_job()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT current_setting('request.monthly_billing_job', true) = '1';
$$;

CREATE OR REPLACE FUNCTION public.is_platform_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.identity_accounts ia
    WHERE ia.application_user_id = auth.uid()
      AND ia.status IN ('active', 'isolated_test')
      AND lower(ia.email) = 'checksopsadmin@gmail.com'
  )
  OR EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND lower(p.email) = 'checksopsadmin@gmail.com'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_master_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.is_platform_owner();
$$;

CREATE OR REPLACE FUNCTION public.aws_user_tenant_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.aws_is_cross_tenant_reader()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(public.is_master_owner(), false)
      OR COALESCE(public.is_platform_owner(), false);
$$;

CREATE OR REPLACE FUNCTION public.aws_can_access_tenant(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT _tenant_id IS NOT NULL
     AND (
       public.aws_is_cross_tenant_reader()
       OR _tenant_id IN (SELECT public.aws_user_tenant_ids())
     );
$$;

CREATE OR REPLACE FUNCTION public.aws_is_authenticated()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT auth.uid() IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.aws_can_write_tenant(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.aws_is_authenticated()
     AND _tenant_id IS NOT NULL
     AND public.aws_can_access_tenant(_tenant_id)
     AND (
       public.aws_is_cross_tenant_reader()
       OR public.has_role(auth.uid(), 'admin'::public.app_role)
       OR public.has_role(auth.uid(), 'staff'::public.app_role)
     );
$$;

GRANT EXECUTE ON FUNCTION public.aws_can_write_tenant(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_access_tenant(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_is_authenticated() TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_monthly_billing_job() TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.is_platform_owner() TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.is_master_owner() TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO checksops, authenticated;

CREATE POLICY aws_write_tenant_maintenance_payments ON public.tenant_maintenance_payments
  FOR ALL TO authenticated
  USING (
    is_platform_owner()
    OR aws_monthly_billing_job()
    OR (current_setting('request.provider_webhook_apply'::text, true) = '1'::text)
  )
  WITH CHECK (
    is_platform_owner()
    OR aws_monthly_billing_job()
    OR (current_setting('request.provider_webhook_apply'::text, true) = '1'::text)
  );

CREATE POLICY aws_write_tenant_maintenance_payments_job ON public.tenant_maintenance_payments
  FOR ALL TO checksops
  USING (
    aws_monthly_billing_job()
    OR (current_setting('request.provider_webhook_apply'::text, true) = '1'::text)
  )
  WITH CHECK (
    aws_monthly_billing_job()
    OR (current_setting('request.provider_webhook_apply'::text, true) = '1'::text)
  );

CREATE POLICY aws_select_tenant_maintenance_payments ON public.tenant_maintenance_payments
  FOR SELECT TO authenticated
  USING (aws_is_cross_tenant_reader() OR aws_can_access_tenant(tenant_id));

CREATE POLICY aws_select_tenant_maintenance_payments_job ON public.tenant_maintenance_payments
  FOR SELECT TO checksops
  USING (aws_monthly_billing_job());

INSERT INTO public.tenant_users (user_id, tenant_id) VALUES
  ('${ADMIN}', '${T1}'),
  ('${ORDINARY}', '${T1}');
INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}', 'admin');
INSERT INTO public.identity_accounts (application_user_id, status, email)
VALUES ('${PLATFORM}', 'active', 'checksopsadmin@gmail.com');
`;

test('isolated PostgreSQL TMP write-policy reconcile against inspected live catalog', { timeout: 180000 }, async (t) => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) {
    t.skip('PostgreSQL 16 initdb is not installed in this environment');
    return;
  }
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-tmp-rls-39-'));
  const port = 55300 + (process.pid % 1000);
  const logPath = path.join(pgData, 'pg.log');
  const artifactLog = path.join(ARTIFACT_DIR, 'pg-matrix.log');
  const notes = [];
  const note = (line) => notes.push(line);

  mustRun(path.join(PG_BIN, 'initdb'), [
    '-D', pgData, '--auth=trust', '--no-sync', '--username=ubuntu', '--encoding=UTF8',
  ]);
  fs.appendFileSync(path.join(pgData, 'postgresql.conf'), `
listen_addresses = ''
port = ${port}
unix_socket_directories = '${pgData}'
logging_collector = off
shared_buffers = 32MB
max_connections = 20
`);
  const started = run(path.join(PG_BIN, 'pg_ctl'), [
    '-D', pgData, '-l', logPath, '-w', '-t', '30', 'start',
  ]);
  if (started.status !== 0) {
    throw new Error(`pg_ctl start failed: ${started.stderr || fs.readFileSync(logPath, 'utf8')}`);
  }

  const psqlArgs = ['-h', pgData, '-p', String(port), '-U', 'ubuntu', '-d', 'postgres'];
  const psql = (sql, extra = ['-v', 'ON_ERROR_STOP=1', '-At']) => {
    const result = run(path.join(PG_BIN, 'psql'), [...psqlArgs, ...extra, '-c', sql]);
    return result;
  };
  const mustSql = (sql) => {
    const result = psql(sql);
    if (result.status !== 0) {
      throw new Error(`psql failed: ${result.stderr || result.stdout}\nSQL: ${sql.slice(0, 240)}`);
    }
    return String(result.stdout || '').trim();
  };
  const tryRoleSql = (body) => psql(`BEGIN; SET LOCAL ROLE checksops; ${body} COMMIT;`, ['-At']);

  try {
    mustSql(fixtureSql);

    const liveUsing = mustSql(`
      SELECT pg_get_expr(pol.polqual, pol.polrelid)
        FROM pg_policy pol
        JOIN pg_class c ON c.oid = pol.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = 'tenant_maintenance_payments'
         AND pol.polname = 'aws_write_tenant_maintenance_payments'`);
    note(`live_using=${liveUsing}`);
    assert.equal(
      liveUsing,
      '(is_platform_owner() OR aws_monthly_billing_job() OR (current_setting(\'request.provider_webhook_apply\'::text, true) = \'1\'::text))',
    );
    assert.equal(mustSql(`SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 'tenant_maintenance_payments'`), 't');

    const beforeAdmin = tryRoleSql(`
      SELECT set_config('request.app_user_id', '${ADMIN}', true);
      INSERT INTO public.tenant_maintenance_payments (id, tenant_id, amount_cents, status)
      VALUES ('${ROW1}', '${T1}', 1, 'due');
    `);
    note(`before_admin_insert status=${beforeAdmin.status} err=${(beforeAdmin.stderr || '').slice(0, 180)}`);
    assert.notEqual(beforeAdmin.status, 0);
    assert.match(`${beforeAdmin.stderr} ${beforeAdmin.stdout}`, /row-level security/i);

    const beforeJob = tryRoleSql(`
      SELECT set_config('request.monthly_billing_job', '1', true);
      INSERT INTO public.tenant_maintenance_payments (id, tenant_id, amount_cents, status)
      VALUES ('${ROW1}', '${T2}', 1, 'due');
    `);
    assert.equal(beforeJob.status, 0, beforeJob.stderr);
    mustSql(`DELETE FROM public.tenant_maintenance_payments`);

    const beforeWebhook = tryRoleSql(`
      SELECT set_config('request.provider_webhook_apply', '1', true);
      INSERT INTO public.tenant_maintenance_payments (id, tenant_id, amount_cents, status)
      VALUES ('${ROW1}', '${T2}', 1, 'due');
    `);
    assert.equal(beforeWebhook.status, 0, beforeWebhook.stderr);
    mustSql(`DELETE FROM public.tenant_maintenance_payments`);

    const collision = run(path.join(PG_BIN, 'psql'), [
      ...psqlArgs, '-v', 'ON_ERROR_STOP=1', '-c',
      `DROP POLICY aws_write_tenant_maintenance_payments ON public.tenant_maintenance_payments;
       CREATE POLICY aws_write_tenant_maintenance_payments ON public.tenant_maintenance_payments
         FOR ALL TO authenticated USING (false) WITH CHECK (false);`,
    ]);
    assert.equal(collision.status, 0, collision.stderr);
    const refused = run(path.join(PG_BIN, 'psql'), [
      ...psqlArgs, '-v', 'ON_ERROR_STOP=1', '-f', APPLY,
    ]);
    note(`collision_apply status=${refused.status} err=${(refused.stderr || '').slice(0, 200)}`);
    assert.notEqual(refused.status, 0);
    assert.match(`${refused.stderr} ${refused.stdout}`, /TMP_WRITE_POLICY_COLLISION/);

    mustSql(`
      DROP POLICY aws_write_tenant_maintenance_payments ON public.tenant_maintenance_payments;
      CREATE POLICY aws_write_tenant_maintenance_payments ON public.tenant_maintenance_payments
        FOR ALL TO authenticated
        USING (is_platform_owner() OR aws_monthly_billing_job() OR (current_setting('request.provider_webhook_apply'::text, true) = '1'::text))
        WITH CHECK (is_platform_owner() OR aws_monthly_billing_job() OR (current_setting('request.provider_webhook_apply'::text, true) = '1'::text));
      DROP POLICY aws_write_tenant_maintenance_payments_job ON public.tenant_maintenance_payments;
    `);
    const missingJob = run(path.join(PG_BIN, 'psql'), [
      ...psqlArgs, '-v', 'ON_ERROR_STOP=1', '-f', APPLY,
    ]);
    assert.notEqual(missingJob.status, 0);
    assert.match(`${missingJob.stderr} ${missingJob.stdout}`, /TMP_JOB_POLICY_MISSING/);

    mustSql(`
      CREATE POLICY aws_write_tenant_maintenance_payments_job ON public.tenant_maintenance_payments
        FOR ALL TO checksops
        USING (aws_monthly_billing_job() OR (current_setting('request.provider_webhook_apply'::text, true) = '1'::text))
        WITH CHECK (aws_monthly_billing_job() OR (current_setting('request.provider_webhook_apply'::text, true) = '1'::text));
    `);

    const applied = run(path.join(PG_BIN, 'psql'), [
      ...psqlArgs, '-v', 'ON_ERROR_STOP=1', '-f', APPLY,
    ]);
    assert.equal(applied.status, 0, applied.stderr);
    note('apply_ok');

    const names = mustSql(`
      SELECT string_agg(pol.polname, ',' ORDER BY pol.polname)
        FROM pg_policy pol
        JOIN pg_class c ON c.oid = pol.polrelid
       WHERE c.relname = 'tenant_maintenance_payments'`);
    assert.deepEqual(names.split(','), [...REMAINING_POLICY_NAMES].sort());
    assert.equal(mustSql(`SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 'tenant_maintenance_payments'`), 't');
    const afterUsing = mustSql(`
      SELECT pg_get_expr(pol.polqual, pol.polrelid)
        FROM pg_policy pol
        JOIN pg_class c ON c.oid = pol.polrelid
       WHERE c.relname = 'tenant_maintenance_payments'
         AND pol.polname = 'aws_write_tenant_maintenance_payments'`);
    note(`after_using=${afterUsing}`);
    assert.match(afterUsing, /aws_can_write_tenant\(tenant_id\)/);

    const adminInsert = tryRoleSql(`
      SELECT set_config('request.app_user_id', '${ADMIN}', true);
      INSERT INTO public.tenant_maintenance_payments (id, tenant_id, amount_cents, status, billing_period, notes)
      VALUES ('${ROW1}', '${T1}', 1, 'due', '2026-10', 'collection_v2:createOrGetOccurrence');
    `);
    assert.equal(adminInsert.status, 0, adminInsert.stderr);
    note('authorized_tenant_admin_insert=allow');

    const unauthorized = tryRoleSql(`
      SELECT set_config('request.app_user_id', '${ADMIN}', true);
      INSERT INTO public.tenant_maintenance_payments (id, tenant_id, amount_cents, status)
      VALUES ('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', '${T2}', 1, 'due');
    `);
    assert.notEqual(unauthorized.status, 0);
    assert.match(`${unauthorized.stderr} ${unauthorized.stdout}`, /row-level security/i);
    note('unauthorized_tenant_insert=deny');

    const adminUpdate = tryRoleSql(`
      SELECT set_config('request.app_user_id', '${ADMIN}', true);
      UPDATE public.tenant_maintenance_payments SET
        status = 'settled',
        settled_at = now()
      WHERE id = '${ROW1}';
    `);
    assert.equal(adminUpdate.status, 0, adminUpdate.stderr);
    note('authorized_tenant_update=allow collection_v2_settlement=allow');

    mustSql(`INSERT INTO public.tenant_maintenance_payments (id, tenant_id, amount_cents, status)
             VALUES ('cccccccc-cccc-4ccc-8ccc-ccccccccccc2', '${T2}', 1, 'due')`);
    const crossUpdate = tryRoleSql(`
      SELECT set_config('request.app_user_id', '${ADMIN}', true);
      UPDATE public.tenant_maintenance_payments SET status = 'settled'
      WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
    `);
    assert.equal(crossUpdate.status, 0, crossUpdate.stderr);
    assert.equal(
      mustSql(`SELECT status FROM public.tenant_maintenance_payments WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'`),
      'due',
    );
    note('cross_tenant_update=deny (USING hides the foreign row; no 42501)');

    const ordinary = tryRoleSql(`
      SELECT set_config('request.app_user_id', '${ORDINARY}', true);
      INSERT INTO public.tenant_maintenance_payments (id, tenant_id, amount_cents, status)
      VALUES ('cccccccc-cccc-4ccc-8ccc-ccccccccccc3', '${T2}', 1, 'due');
    `);
    assert.notEqual(ordinary.status, 0);
    note('ordinary_user_foreign_insert=deny');

    const job = tryRoleSql(`
      SELECT set_config('request.monthly_billing_job', '1', true);
      INSERT INTO public.tenant_maintenance_payments (id, tenant_id, amount_cents, status)
      VALUES ('cccccccc-cccc-4ccc-8ccc-ccccccccccc4', '${T2}', 1, 'due');
    `);
    assert.equal(job.status, 0, job.stderr);
    note('monthly_billing_job=allow via job policy');

    const webhook = tryRoleSql(`
      SELECT set_config('request.provider_webhook_apply', '1', true);
      UPDATE public.tenant_maintenance_payments SET status = 'submitted'
      WHERE id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4';
    `);
    assert.equal(webhook.status, 0, webhook.stderr);
    note('provider_webhook_apply=allow via job policy');

    const platform = tryRoleSql(`
      SELECT set_config('request.app_user_id', '${PLATFORM}', true);
      INSERT INTO public.tenant_maintenance_payments (id, tenant_id, amount_cents, status)
      VALUES ('cccccccc-cccc-4ccc-8ccc-ccccccccccc5', '${T2}', 1, 'due');
    `);
    assert.equal(platform.status, 0, platform.stderr);
    note('platform_owner_insert=allow via aws_can_write_tenant');

    const anon = psql(`
      BEGIN;
      SET LOCAL ROLE anon;
      INSERT INTO public.tenant_maintenance_payments (id, tenant_id, amount_cents, status)
      VALUES ('cccccccc-cccc-4ccc-8ccc-ccccccccccc6', '${T1}', 1, 'due');
      COMMIT;
    `, ['-At']);
    assert.notEqual(anon.status, 0);
    note('anon_insert=deny');

    const idempotent = run(path.join(PG_BIN, 'psql'), [
      ...psqlArgs, '-v', 'ON_ERROR_STOP=1', '-f', APPLY,
    ]);
    assert.equal(idempotent.status, 0, idempotent.stderr);

    const rolled = run(path.join(PG_BIN, 'psql'), [
      ...psqlArgs, '-v', 'ON_ERROR_STOP=1', '-f', ROLLBACK,
    ]);
    assert.equal(rolled.status, 0, rolled.stderr);
    const afterRollback = tryRoleSql(`
      SELECT set_config('request.app_user_id', '${ADMIN}', true);
      INSERT INTO public.tenant_maintenance_payments (id, tenant_id, amount_cents, status)
      VALUES ('cccccccc-cccc-4ccc-8ccc-ccccccccccc7', '${T1}', 1, 'due');
    `);
    assert.notEqual(afterRollback.status, 0);
    const jobAfterRollback = tryRoleSql(`
      SELECT set_config('request.monthly_billing_job', '1', true);
      INSERT INTO public.tenant_maintenance_payments (id, tenant_id, amount_cents, status)
      VALUES ('cccccccc-cccc-4ccc-8ccc-ccccccccccc8', '${T2}', 1, 'due');
    `);
    assert.equal(jobAfterRollback.status, 0, jobAfterRollback.stderr);
    note('rollback_restores_drift_without_snapshot; job still allowed');
  } finally {
    run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'fast', '-w', 'stop']);
    fs.writeFileSync(artifactLog, `${notes.join('\n')}\n`);
  }
});
