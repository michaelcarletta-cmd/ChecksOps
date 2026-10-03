import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const ARTIFACT_DIR = '/opt/cursor/artifacts';
const BOOTSTRAP = path.join(ROOT, 'isolated/mortgage-agent-compensation/sql/47_pg_bootstrap.sql');
const SQL47 = path.join(ROOT, 'isolated/mortgage-agent-compensation/sql/47_mortgage_agent_compensation.sql');

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const AGENT_A = '00000000-0000-4000-8000-0000000000a1';
const AGENT_B = '00000000-0000-4000-8000-0000000000a2';
const TENANT = '00000000-0000-4000-8000-0000000000d1';
const CLAIM = '00000000-0000-4000-8000-0000000000c1';
const CHECK1 = '00000000-0000-4000-8000-000000000011';
const CHECK2 = '00000000-0000-4000-8000-000000000012';
const REQ1 = '00000000-0000-4000-8000-000000000021';
const REQ2 = '00000000-0000-4000-8000-000000000022';
const REQ_CANCEL = '00000000-0000-4000-8000-000000000023';
const EXCLUDED = '5b20db20-13e1-4919-9528-06388d8661d2';

const run = (bin, args, opts = {}) => spawnSync(bin, args, {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
  ...opts,
});

const mustRun = (bin, args, opts = {}) => {
  const result = run(bin, args, opts);
  if (result.status !== 0) {
    throw new Error(`${bin} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
};

test('mortgage agent compensation SQL 47 lifecycle', { timeout: 180000 }, async (t) => {
  assert.equal(fs.existsSync(path.join(PG_BIN, 'initdb')), true);
  assert.equal(fs.existsSync(SQL47), true);

  const stamp = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${process.pid}`;
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), `pg-comp-${stamp}-`));
  const port = 56000 + (process.pid % 1000);
  const dbName = `comp_${stamp}`;
  const artifactLog = path.join(ARTIFACT_DIR, `mortgage_agent_compensation_pg_${stamp}.log`);
  const chunks = [];
  const note = (line) => chunks.push(line);
  let started = false;

  t.after(() => {
    try {
      fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(artifactLog, chunks.join('\n'), 'utf8');
    } catch { /* ignore */ }
    if (started) run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', 'stop']);
    fs.rmSync(pgData, { recursive: true, force: true });
  });

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
  mustRun(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-l', path.join(pgData, 'pg.log'), '-w', 'start']);
  started = true;

  const psqlArgs = ['-h', pgData, '-p', String(port), '-U', 'ubuntu', '-v', 'ON_ERROR_STOP=1'];
  const psql = (extra, input) => {
    const result = run(path.join(PG_BIN, 'psql'), [...psqlArgs, ...extra], input ? { input } : {});
    if (result.status !== 0) throw new Error(`psql failed: ${result.stderr || result.stdout}`);
    return result;
  };
  const scalar = (sql) => psql(['-d', dbName, '-A', '-t', '-c', sql]).stdout.trim();

  psql(['-d', 'postgres', '-c', `CREATE DATABASE ${dbName}`]);
  psql(['-d', dbName, '-f', BOOTSTRAP]);
  psql(['-d', dbName, '-f', SQL47]);
  note('applied SQL 47');

  const sql47 = fs.readFileSync(SQL47, 'utf8');
  assert.equal(/GRANT\s+UPDATE\s+ON\s+TABLE\s+public\.mortgage_handling_requests/i.test(sql47), false);
  assert.equal(/ALTER\s+TABLE\s+public\.mortgage_handling_requests/i.test(sql47), false);
  const executableSql = sql47.replace(/--.*$/gm, '');
  assert.equal(/moov|stripe|bill-mortgage-handling/i.test(executableSql), false);
  assert.equal(executableSql.includes('aws_is_mortgage_ops_agent'), false);

  psql(['-d', dbName, '-c', `
INSERT INTO public.profiles (id, email, full_name) VALUES
  ('${OWNER}', 'checksopsadmin@gmail.com', 'Owner'),
  ('${AGENT_A}', 'agent-a@example.com', 'Agent A'),
  ('${AGENT_B}', 'agent-b@example.com', 'Agent B');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('${OWNER}', 'admin'),
  ('${AGENT_A}', 'mortgage_agent'),
  ('${AGENT_B}', 'mortgage_agent');
INSERT INTO public.mortgage_agent_accounts (application_user_id, status) VALUES
  ('${AGENT_A}', 'active'),
  ('${AGENT_B}', 'active')
ON CONFLICT DO NOTHING;
INSERT INTO public.tenants (id, name, slug) VALUES ('${TENANT}', 'Acme', 'acme');
INSERT INTO public.mortgage_handling_requests
  (id, tenant_id, check_intake_item_id, claim_id, mortgage_company, loan_number, status)
VALUES
  ('${REQ1}', '${TENANT}', '${CHECK1}', '${CLAIM}', 'Lender', 'LOAN-1', 'requested'),
  ('${REQ2}', '${TENANT}', '${CHECK2}', '${CLAIM}', 'Lender', 'LOAN-2', 'requested'),
  ('${REQ_CANCEL}', '${TENANT}', NULL, '${CLAIM}', 'Lender', 'LOAN-X', 'requested'),
  ('${EXCLUDED}', '${TENANT}', NULL, '${CLAIM}', 'PROD E2E TEST LENDER', 'SKIP', 'requested');
`]);

  const accept = (req, agent) => `
UPDATE public.mortgage_handling_requests
   SET assigned_employee_id = '${agent}',
       status = 'in_progress',
       accepted_at = COALESCE(accepted_at, now()),
       updated_at = now()
 WHERE id = '${req}' AND assigned_employee_id IS NULL AND status = 'requested'`;
  const complete = (req) => `
UPDATE public.mortgage_handling_requests
   SET status = 'completed', completed_at = now(), updated_at = now()
 WHERE id = '${req}'`;

  psql(['-d', dbName, '-c', `
INSERT INTO public.check_billing_events
  (tenant_id, check_intake_item_id, claim_id, mortgage_request_id, event_type, unit_price_cents)
VALUES
  ('${TENANT}', '${CHECK1}', '${CLAIM}', '${REQ1}', 'mortgage_ops_initial', 1000);
`]);
  psql(['-d', dbName, '-c', accept(REQ1, AGENT_A)]);
  assert.equal(scalar(`SELECT count(*) FROM mortgage_agent_compensation_entries WHERE mortgage_request_id='${REQ1}'`), '0');
  note('1 accept initial: tenant event exists, no payable');

  psql(['-d', dbName, '-c', complete(REQ1)]);
  assert.equal(scalar(`SELECT count(*) FROM mortgage_agent_compensation_entries WHERE mortgage_request_id='${REQ1}' AND status='earned'`), '1');
  assert.equal(scalar(`SELECT amount_cents FROM mortgage_agent_compensation_entries WHERE mortgage_request_id='${REQ1}'`), '1000');
  assert.equal(scalar(`SELECT classification FROM mortgage_agent_compensation_entries WHERE mortgage_request_id='${REQ1}'`), 'initial');
  note('2 complete: one $10 payable');

  psql(['-d', dbName, '-c', complete(REQ1)]);
  assert.equal(scalar(`SELECT count(*) FROM mortgage_agent_compensation_entries WHERE mortgage_request_id='${REQ1}'`), '1');
  note('3 duplicate complete: still one payable');

  psql(['-d', dbName, '-c', `
INSERT INTO public.check_billing_events
  (tenant_id, check_intake_item_id, claim_id, mortgage_request_id, event_type, unit_price_cents)
VALUES
  ('${TENANT}', '${CHECK2}', '${CLAIM}', '${REQ2}', 'mortgage_ops_additional_check', 0);
`]);
  psql(['-d', dbName, '-c', accept(REQ2, AGENT_A)]);
  assert.equal(scalar(`SELECT count(*) FROM mortgage_agent_compensation_entries WHERE mortgage_request_id='${REQ2}'`), '0');
  note('4 additional accept $0 tenant promo: no payable');

  psql(['-d', dbName, '-c', complete(REQ2)]);
  assert.equal(scalar(`SELECT amount_cents FROM mortgage_agent_compensation_entries WHERE mortgage_request_id='${REQ2}'`), '500');
  assert.equal(scalar(`SELECT classification FROM mortgage_agent_compensation_entries WHERE mortgage_request_id='${REQ2}'`), 'additional');
  note('5 complete additional: one $5 payable despite tenant $0');

  const period = scalar(`SELECT pay_period FROM mortgage_agent_compensation_entries WHERE mortgage_request_id='${REQ1}'`);
  assert.equal(scalar(`
    SELECT count(*) FROM mortgage_agent_compensation_entries
    WHERE agent_user_id='${AGENT_A}' AND pay_period='${period}' AND status NOT IN ('voided','excluded')
  `), '2');
  assert.equal(scalar(`
    SELECT coalesce(sum(amount_cents),0) FROM mortgage_agent_compensation_entries
    WHERE agent_user_id='${AGENT_A}' AND pay_period='${period}' AND status NOT IN ('voided','excluded')
  `), '1500');
  note('6 monthly: 2 files / $15');

  const asOwner = (sql) => scalar(`
    SELECT (${sql})
    FROM (
      SELECT set_config('request.app_user_id', '${OWNER}', true),
             set_config('request.is_platform_owner', 'true', true)
    ) cfg
  `);
  const asAgent = (sql) => scalar(`
    SELECT (${sql})
    FROM (
      SELECT set_config('request.app_user_id', '${AGENT_A}', true),
             set_config('request.is_platform_owner', 'false', true)
    ) cfg
  `);
  const approved = asOwner(`
    public.approve_mortgage_agent_compensation(
      ARRAY(SELECT id FROM mortgage_agent_compensation_entries WHERE agent_user_id='${AGENT_A}'),
      'month approve'
    )
  `);
  assert.equal(approved, '2');
  assert.equal(scalar(`
    SELECT coalesce(sum(amount_cents),0) FROM mortgage_agent_compensation_entries
    WHERE agent_user_id='${AGENT_A}' AND status='approved'
  `), '1500');
  note('7 approve: still $15 payable');

  const paid = asOwner(`
    public.mark_mortgage_agent_compensation_paid(
      ARRAY(SELECT id FROM mortgage_agent_compensation_entries WHERE agent_user_id='${AGENT_A}'),
      CURRENT_DATE, 'CHK-15', 'paid outside ChecksOps'
    )
  `);
  assert.equal(paid, '2');
  assert.equal(scalar(`
    SELECT coalesce(sum(amount_cents) FILTER (WHERE status='paid'),0) FROM mortgage_agent_compensation_entries
    WHERE agent_user_id='${AGENT_A}'
  `), '1500');
  assert.equal(scalar(`
    SELECT coalesce(sum(amount_cents) FILTER (WHERE status IN ('earned','approved')),0)
    FROM mortgage_agent_compensation_entries WHERE agent_user_id='${AGENT_A}'
  `), '0');
  note('8 mark paid: $15 paid / $0 outstanding');

  assert.equal(scalar(`
    SELECT count(*) FROM mortgage_agent_compensation_entries
    WHERE agent_user_id='${AGENT_A}' AND mortgage_request_id IN ('${REQ1}','${REQ2}')
  `), '2');
  note('9 drilldown still has both files');

  assert.equal(asAgent(`public.aws_can_admin_mortgage_agent_compensation()`), 'f');
  const denied = run(path.join(PG_BIN, 'psql'), [
    ...psqlArgs, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-c',
    `SELECT public.approve_mortgage_agent_compensation(ARRAY[]::uuid[], 'nope')`,
  ]);
  assert.notEqual(denied.status, 0);
  note('10 agent cannot administer compensation');

  const steal = run(path.join(PG_BIN, 'psql'), [
    ...psqlArgs, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-c',
    `UPDATE mortgage_agent_compensation_entries SET agent_user_id='${AGENT_B}' WHERE mortgage_request_id='${REQ1}'`,
  ]);
  assert.notEqual(steal.status, 0);
  assert.equal(scalar(`SELECT agent_user_id FROM mortgage_agent_compensation_entries WHERE mortgage_request_id='${REQ1}'`), AGENT_A);
  note('11 facts immutable / other agent cannot take credit');

  psql(['-d', dbName, '-c', `
UPDATE public.mortgage_handling_requests
   SET assigned_employee_id='${AGENT_A}', status='in_progress', accepted_at=now()
 WHERE id='${REQ_CANCEL}'
`]);
  psql(['-d', dbName, '-c', `
UPDATE public.mortgage_handling_requests SET status='cancelled' WHERE id='${REQ_CANCEL}'
`]);
  assert.equal(scalar(`SELECT count(*) FROM mortgage_agent_compensation_entries WHERE mortgage_request_id='${REQ_CANCEL}'`), '0');
  note('12 cancel before complete: no payable');

  asOwner(`public.set_mortgage_agent_account_status('${AGENT_B}', 'inactive', 'test')`);
  assert.equal(scalar(`SELECT status FROM mortgage_agent_accounts WHERE application_user_id='${AGENT_B}'`), 'inactive');
  assert.equal(scalar(`SELECT count(*) FROM user_roles WHERE user_id='${AGENT_B}' AND role='mortgage_agent'`), '1');
  const inactiveAccept = run(path.join(PG_BIN, 'psql'), [
    ...psqlArgs, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-c', `
INSERT INTO mortgage_handling_requests (id, tenant_id, status)
VALUES ('00000000-0000-4000-8000-000000000099', '${TENANT}', 'requested');
UPDATE mortgage_handling_requests
   SET assigned_employee_id='${AGENT_B}', status='in_progress', accepted_at=now()
 WHERE id='00000000-0000-4000-8000-000000000099'`,
  ]);
  assert.notEqual(inactiveAccept.status, 0);
  note('inactive agent cannot accept; role preserved');

  psql(['-d', dbName, '-c', `
UPDATE mortgage_handling_requests
   SET assigned_employee_id='${AGENT_A}', status='in_progress', accepted_at=now()
 WHERE id='${EXCLUDED}'
`]);
  psql(['-d', dbName, '-c', complete(EXCLUDED)]);
  assert.equal(scalar(`SELECT count(*) FROM mortgage_agent_compensation_entries WHERE mortgage_request_id='${EXCLUDED}'`), '0');
  note('excluded Freedom artifact does not earn');

  const recon = scalar(`
    SELECT count(*) FROM public.mortgage_agent_compensation_reconciliation(NULL)
    WHERE anomaly_type = 'amount_mismatch'
  `);
  assert.equal(recon, '0');
  note('tenant $0 promo is not an amount mismatch');

  assert.equal(scalar(`
    SELECT count(*) FROM information_schema.role_table_grants
    WHERE table_name='mortgage_handling_requests' AND privilege_type='UPDATE' AND grantee IN ('checksops','authenticated')
  `), '0');
  note('no MHR UPDATE grants added');
});
