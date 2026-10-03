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
const SQL48 = path.join(ROOT, 'isolated/mortgage-agent-compensation/sql/48_return_mortgage_request_to_queue.sql');
const SQL49 = path.join(ROOT, 'isolated/mortgage-agent-compensation/sql/49_adjust_mortgage_agent_compensation.sql');

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const AGENT_A = '00000000-0000-4000-8000-0000000000a1';
const AGENT_B = '00000000-0000-4000-8000-0000000000a2';
const TENANT = '00000000-0000-4000-8000-0000000000d1';
const CLAIM = '00000000-0000-4000-8000-0000000000c1';
const CHECK1 = '00000000-0000-4000-8000-000000000011';
const CHECK_PROMO = '00000000-0000-4000-8000-000000000013';
const REQ1 = '00000000-0000-4000-8000-000000000021';
const REQ_PROMO = '00000000-0000-4000-8000-000000000024';
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

test('SQL 48/49 return-to-queue and immutable adjustments lifecycle', { timeout: 180000 }, async (t) => {
  assert.equal(fs.existsSync(path.join(PG_BIN, 'initdb')), true);
  const stamp = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${process.pid}`;
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), `pg-retadj-${stamp}-`));
  const port = 57000 + (process.pid % 1000);
  const dbName = `retadj_${stamp}`;
  const artifactLog = path.join(ARTIFACT_DIR, `mortgage_agent_return_adjust_pg_${stamp}.log`);
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
  const expectFail = (sql) => {
    const result = run(path.join(PG_BIN, 'psql'), [...psqlArgs, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-c', sql]);
    assert.notEqual(result.status, 0, `expected failure for ${sql}`);
    return result.stderr || result.stdout;
  };

  psql(['-d', 'postgres', '-c', `CREATE DATABASE ${dbName}`]);
  psql(['-d', dbName, '-f', BOOTSTRAP]);
  psql(['-d', dbName, '-f', SQL47]);
  psql(['-d', dbName, '-f', SQL48]);
  psql(['-d', dbName, '-f', SQL49]);
  note('applied SQL 47 + 48 + 49');

  assert.match(scalar(`
    SELECT indexname FROM pg_indexes
    WHERE tablename='check_billing_events'
      AND indexdef ILIKE '%UNIQUE%'
      AND indexdef ILIKE '%mortgage_ops_initial%'
  `), /check_billing_events_one_mortgage_ops_per_check|check_billing_events_mortgage_ops_check_uidx/);
  note('GATE 0 local unique present via SQL 48 fallback');

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
  ('${REQ_PROMO}', '${TENANT}', '${CHECK_PROMO}', '${CLAIM}', 'Lender', 'LOAN-P', 'requested'),
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
  const asOwner = (sql) => scalar(`
    SELECT (${sql})
    FROM (
      SELECT set_config('request.app_user_id', '${OWNER}', true),
             set_config('request.is_platform_owner', 'true', true)
    ) cfg
  `);
  const ownerDo = (sql) => psql(['-d', dbName, '-c', `
    SELECT set_config('request.app_user_id', '${OWNER}', true),
           set_config('request.is_platform_owner', 'true', true);
    ${sql}
  `]);

  psql(['-d', dbName, '-c', `
INSERT INTO public.check_billing_events
  (tenant_id, check_intake_item_id, claim_id, mortgage_request_id, event_type, unit_price_cents)
VALUES
  ('${TENANT}', '${CHECK1}', '${CLAIM}', '${REQ1}', 'mortgage_ops_initial', 1000);
`]);
  psql(['-d', dbName, '-c', accept(REQ1, AGENT_A)]);
  const acceptedAt = scalar(`SELECT accepted_at FROM mortgage_handling_requests WHERE id='${REQ1}'`);
  const billingId = scalar(`
    SELECT id FROM check_billing_events
    WHERE check_intake_item_id='${CHECK1}'
      AND event_type IN ('mortgage_ops_initial','mortgage_ops_additional_check')
  `);
  const billingFp = scalar(`
    SELECT md5(id::text||event_type||unit_price_cents::text||status)
    FROM check_billing_events WHERE id='${billingId}'
  `);
  assert.equal(scalar(`SELECT count(*) FROM check_billing_events WHERE check_intake_item_id='${CHECK1}' AND event_type IN ('mortgage_ops_initial','mortgage_ops_additional_check')`), '1');
  note('1-2 Agent A Accept: exactly one tenant billing event');

  asOwner(`public.return_mortgage_handling_request_to_queue('${REQ1}', 'Agent A unavailable')`);
  assert.equal(scalar(`SELECT status FROM mortgage_handling_requests WHERE id='${REQ1}'`), 'requested');
  assert.equal(scalar(`SELECT assigned_employee_id FROM mortgage_handling_requests WHERE id='${REQ1}'`), '');
  assert.equal(scalar(`SELECT accepted_at FROM mortgage_handling_requests WHERE id='${REQ1}'`), acceptedAt);
  assert.equal(scalar(`SELECT md5(id::text||event_type||unit_price_cents::text||status) FROM check_billing_events WHERE id='${billingId}'`), billingFp);
  assert.equal(scalar(`SELECT action FROM mortgage_ops_request_audit WHERE mortgage_request_id='${REQ1}'`), 'return_to_queue');
  note('3-5 Admin return: requested, accepted_at + CBE unchanged');

  psql(['-d', dbName, '-c', accept(REQ1, AGENT_B)]);
  const secondInsert = run(path.join(PG_BIN, 'psql'), [
    ...psqlArgs, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-c', `
INSERT INTO public.check_billing_events
  (tenant_id, check_intake_item_id, claim_id, mortgage_request_id, event_type, unit_price_cents)
VALUES
  ('${TENANT}', '${CHECK1}', '${CLAIM}', '${REQ1}', 'mortgage_ops_additional_check', 500);
`]);
  assert.notEqual(secondInsert.status, 0);
  assert.equal(scalar(`SELECT count(*) FROM check_billing_events WHERE check_intake_item_id='${CHECK1}' AND event_type IN ('mortgage_ops_initial','mortgage_ops_additional_check')`), '1');
  assert.equal(scalar(`SELECT assigned_employee_id FROM mortgage_handling_requests WHERE id='${REQ1}'`), AGENT_B);
  note('6-7 Agent B Accept: no second tenant billing event');

  psql(['-d', dbName, '-c', complete(REQ1)]);
  assert.equal(scalar(`SELECT count(*) FROM mortgage_agent_compensation_entries WHERE mortgage_request_id='${REQ1}' AND parent_entry_id IS NULL`), '1');
  assert.equal(scalar(`SELECT agent_user_id FROM mortgage_agent_compensation_entries WHERE mortgage_request_id='${REQ1}' AND parent_entry_id IS NULL`), AGENT_B);
  assert.equal(scalar(`SELECT count(*) FROM mortgage_agent_compensation_entries WHERE agent_user_id='${AGENT_A}'`), '0');
  note('8-10 B completes: one root for B, A earns nothing');

  psql(['-d', dbName, '-c', complete(REQ1)]);
  assert.equal(scalar(`SELECT count(*) FROM mortgage_agent_compensation_entries WHERE mortgage_request_id='${REQ1}' AND parent_entry_id IS NULL`), '1');
  note('11 duplicate Complete remains idempotent');

  const afterEarnReturn = expectFail(`
    SELECT set_config('request.app_user_id', '${OWNER}', true),
           set_config('request.is_platform_owner', 'true', true);
    SELECT public.return_mortgage_handling_request_to_queue('${REQ1}', 'too late');
  `);
  assert.match(afterEarnReturn, /compensation_already_exists|request_not_returnable/);
  note('12 Return after compensation refused');

  const afterCompleteReturn = expectFail(`
    SELECT set_config('request.app_user_id', '${OWNER}', true),
           set_config('request.is_platform_owner', 'true', true);
    SELECT public.return_mortgage_handling_request_to_queue('${REQ1}', 'completed');
  `);
  assert.match(afterCompleteReturn, /request_not_returnable|compensation_already_exists/);
  note('13 Return after completion refused');

  const agentReturn = expectFail(`
    SELECT set_config('request.app_user_id', '${AGENT_B}', true),
           set_config('request.is_platform_owner', 'false', true);
    SELECT public.return_mortgage_handling_request_to_queue('${REQ1}', 'agent attempt');
  `);
  assert.match(agentReturn, /not_authorized/);
  note('14 Mortgage Agent Return is 403');

  psql(['-d', dbName, '-c', `
UPDATE mortgage_handling_requests
   SET assigned_employee_id='${AGENT_A}', status='in_progress', accepted_at=COALESCE(accepted_at, now())
 WHERE id='${EXCLUDED}'
`]);
  const excludedReturn = expectFail(`
    SELECT set_config('request.app_user_id', '${OWNER}', true),
           set_config('request.is_platform_owner', 'true', true);
    SELECT public.return_mortgage_handling_request_to_queue('${EXCLUDED}', 'should fail');
  `);
  assert.match(excludedReturn, /request_excluded/);
  note('15 excluded request refused');

  const parentId = scalar(`SELECT id FROM mortgage_agent_compensation_entries WHERE mortgage_request_id='${REQ1}' AND parent_entry_id IS NULL`);
  const factFp = scalar(`
    SELECT md5(id::text||agent_user_id::text||amount_cents::text||classification||pay_period||coalesce(accepted_at::text,'')||coalesce(completed_at::text,'')||mortgage_request_id::text)
    FROM mortgage_agent_compensation_entries WHERE id='${parentId}'
  `);
  ownerDo(`SELECT public.adjust_mortgage_agent_compensation('${parentId}', 250, 'underpayment', NULL, NULL);`);
  assert.equal(scalar(`SELECT amount_cents FROM mortgage_agent_compensation_entries WHERE id='${parentId}'`), '1000');
  assert.equal(scalar(`SELECT count(*) FROM mortgage_agent_compensation_entries WHERE parent_entry_id='${parentId}' AND amount_cents=250`), '1');
  note('16 positive adjustment works');

  ownerDo(`SELECT public.adjust_mortgage_agent_compensation('${parentId}', -100, 'overpayment', NULL, NULL);`);
  assert.equal(scalar(`SELECT count(*) FROM mortgage_agent_compensation_entries WHERE parent_entry_id='${parentId}' AND amount_cents=-100`), '1');
  note('17 negative adjustment works');

  asOwner(`public.mark_mortgage_agent_compensation_paid(ARRAY['${parentId}']::uuid[], CURRENT_DATE, 'CHK-ROOT', 'bookkeeping')`);
  const paidFp = scalar(`
    SELECT md5(id::text||agent_user_id::text||amount_cents::text||classification||status||pay_period||coalesce(payment_reference,'')||coalesce(paid_at::text,''))
    FROM mortgage_agent_compensation_entries WHERE id='${parentId}'
  `);
  assert.equal(scalar(`SELECT status FROM mortgage_agent_compensation_entries WHERE id='${parentId}'`), 'paid');

  const beforePair = Number(scalar(`SELECT count(*) FROM mortgage_agent_compensation_entries WHERE parent_entry_id='${parentId}'`));
  const badPair = expectFail(`
    SELECT set_config('request.app_user_id', '${OWNER}', true),
           set_config('request.is_platform_owner', 'true', true);
    SELECT public.adjust_mortgage_agent_compensation('${parentId}', 1000, 'bad pair', '00000000-0000-4000-8000-000000000099', NULL);
  `);
  assert.match(badPair, /invalid_counterparty/);
  assert.equal(scalar(`SELECT count(*) FROM mortgage_agent_compensation_entries WHERE parent_entry_id='${parentId}'`), String(beforePair));
  ownerDo(`SELECT public.adjust_mortgage_agent_compensation('${parentId}', 1000, 'wrong agent', '${AGENT_A}', NULL);`);
  assert.equal(scalar(`SELECT count(*) FROM mortgage_agent_compensation_entries WHERE parent_entry_id='${parentId}' AND amount_cents=-1000 AND agent_user_id='${AGENT_B}'`), '1');
  assert.equal(scalar(`SELECT count(*) FROM mortgage_agent_compensation_entries WHERE parent_entry_id='${parentId}' AND amount_cents=1000 AND agent_user_id='${AGENT_A}'`), '1');
  note('18 wrong-agent paired adjustment is atomic');

  assert.equal(scalar(`
    SELECT md5(id::text||agent_user_id::text||amount_cents::text||classification||status||pay_period||coalesce(payment_reference,'')||coalesce(paid_at::text,''))
    FROM mortgage_agent_compensation_entries WHERE id='${parentId}'
  `), paidFp);
  assert.equal(scalar(`
    SELECT md5(id::text||agent_user_id::text||amount_cents::text||classification||pay_period||coalesce(accepted_at::text,'')||coalesce(completed_at::text,'')||mortgage_request_id::text)
    FROM mortgage_agent_compensation_entries WHERE id='${parentId}'
  `), factFp);
  note('19 paid parent remains fact-unchanged');

  const period = scalar(`SELECT pay_period FROM mortgage_agent_compensation_entries WHERE id='${parentId}'`);
  assert.equal(scalar(`
    SELECT count(*) FROM mortgage_agent_compensation_entries
    WHERE pay_period='${period}' AND parent_entry_id IS NULL AND status NOT IN ('voided','excluded')
  `), '1');
  const money = Number(scalar(`
    SELECT coalesce(sum(amount_cents),0) FROM mortgage_agent_compensation_entries
    WHERE pay_period='${period}' AND status NOT IN ('voided','excluded')
  `));
  assert.equal(money, 1000 + 250 - 100 - 1000 + 1000);
  note('20-21 monthly file counts stay on roots; money includes adjustments');

  psql(['-d', dbName, '-c', `
INSERT INTO public.check_billing_events
  (tenant_id, check_intake_item_id, claim_id, mortgage_request_id, event_type, unit_price_cents)
VALUES
  ('${TENANT}', '${CHECK_PROMO}', '${CLAIM}', '${REQ_PROMO}', 'mortgage_ops_additional_check', 0);
`]);
  psql(['-d', dbName, '-c', accept(REQ_PROMO, AGENT_B)]);
  psql(['-d', dbName, '-c', complete(REQ_PROMO)]);
  assert.equal(scalar(`SELECT amount_cents FROM mortgage_agent_compensation_entries WHERE mortgage_request_id='${REQ_PROMO}' AND parent_entry_id IS NULL`), '500');
  assert.equal(scalar(`SELECT unit_price_cents FROM check_billing_events WHERE check_intake_item_id='${CHECK_PROMO}'`), '0');
  note('22 $0 tenant promo still produces normal agent compensation');

  const sql48 = fs.readFileSync(SQL48, 'utf8').replace(/--.*$/gm, '');
  const sql49 = fs.readFileSync(SQL49, 'utf8').replace(/--.*$/gm, '');
  assert.equal(/moov|stripe|ach|wallet|clawback/i.test(sql48 + sql49), false);
  assert.equal(scalar(`
    SELECT count(*) FROM information_schema.role_table_grants
    WHERE table_name='mortgage_handling_requests' AND privilege_type='UPDATE' AND grantee IN ('checksops','authenticated')
  `), '0');
  note('23 no provider/money movement and no MHR UPDATE grants');
});
