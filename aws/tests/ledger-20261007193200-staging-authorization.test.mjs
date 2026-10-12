/**
 * Evaluate-only pin for 20261007193200_skip_claim_ledger_event_for_endorsement_stage.
 *
 * Staging and production both run the July 2026 ledger functions
 * (hle bdd9ec4b…, sync 9f6ec2dc…); 20260918170040 was never applied. The
 * isolated PostgreSQL test rebuilds those exact definitions, then applies the
 * migration file verbatim and checks the ledger events before and after.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const RECORD = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'ops/deployment-guard/ledger-20261007193200-staging-authorization.json'),
  'utf8',
));
const STAGING_ACCEPTANCE = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'ops/deployment-guard/sql53-staging-acceptance.json'),
  'utf8',
));
const PRODUCTION_APPLY = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'ops/deployment-guard/sql53-production-apply.json'),
  'utf8',
));
const HLE = 'public.hle_on_check_intake_insert()';
const SYNC = 'public.sync_homeowner_ledger_from_check()';

const fileSha = (rel) => createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');

const functionBlock = (rel, name) => {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const pattern = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(\\)[\\s\\S]*?\\$\\$;`);
  const match = src.match(pattern);
  assert.ok(match, `${rel} defines public.${name}()`);
  return match[0];
};

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

test('record stays evaluate-only and pins the exact migration bytes', () => {
  assert.equal(RECORD.authorization, 'source-only');
  assert.equal(RECORD.apply_authorized, false);
  assert.equal(RECORD.execute, false);
  assert.equal(RECORD.target_environment, 'staging');
  assert.deepEqual(RECORD.owned_components, [RECORD.filename]);
  assert.equal(fileSha(RECORD.filename), RECORD.source_sha256);
  assert.ok(RECORD.forbidden_owned_components.includes('supabase/migrations/20260918170040_one_check_received_writer.sql'));
  assert.ok(!RECORD.forbidden_owned_components.includes(RECORD.filename));
});

test('expected live hashes match the recorded staging and production inspects', () => {
  const staging = STAGING_ACCEPTANCE.evidence.after_apply.preserved_function_definition_sha256;
  const production = PRODUCTION_APPLY.preserved_function_definition_sha256;
  for (const live of [staging, production]) {
    assert.equal(live[SYNC], RECORD.expected_live_definition_sha256);
    assert.equal(live[HLE], RECORD.preconditions.preserved_function_definition_sha256[HLE]);
  }
  for (const trigger of RECORD.preconditions.required_ledger_triggers) {
    assert.ok(PRODUCTION_APPLY.preserved_ledger_triggers.includes(trigger), trigger);
  }
});

test('isolated PostgreSQL: migration removes the duplicate check_received and endorsements_sent only', {
  timeout: 180000,
}, async (t) => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) {
    t.skip('PostgreSQL 16 initdb is not installed in this environment');
    return;
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('initdb cannot run as root');
    return;
  }

  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-ledger-20261007193200-'));
  const port = 57800 + (process.pid % 1000);
  const logPath = path.join(pgData, 'pg.log');
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
  const psqlArgs = ['-h', pgData, '-p', String(port), '-U', 'ubuntu', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt'];
  const psql = (sql) => String(mustRun(path.join(PG_BIN, 'psql'), [...psqlArgs, '-c', sql]).stdout || '').trim();
  const psqlFile = (file) => mustRun(path.join(PG_BIN, 'psql'), [...psqlArgs, '-f', file]);
  const defSha = (identity) => psql(
    `SELECT encode(sha256(convert_to(pg_get_functiondef('${identity}'::regprocedure), 'UTF8')), 'hex')`,
  );
  // One linked check moves review -> endorsing -> approved; returns its events by type.
  const scenario = () => {
    const checkId = psql(`
      INSERT INTO public.check_intake_items (tenant_id, claim_id, status, amount)
      VALUES (gen_random_uuid(), gen_random_uuid(), 'needs_review', 100) RETURNING id`);
    psql(`UPDATE public.check_intake_items SET status = 'endorsements_in_progress' WHERE id = '${checkId}'`);
    psql(`UPDATE public.check_intake_items SET status = 'approved_for_deposit' WHERE id = '${checkId}'`);
    const rows = psql(`
      SELECT event_type || '=' || count(*) FROM public.homeowner_ledger_events
       WHERE check_id = '${checkId}' GROUP BY event_type ORDER BY event_type`);
    return Object.fromEntries(rows.split('\n').filter(Boolean).map((row) => {
      const [type, count] = row.split('=');
      return [type, Number(count)];
    }));
  };

  try {
    psql(`
      CREATE TABLE public.check_intake_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, claim_id uuid,
        check_source text NOT NULL DEFAULT 'insurance', status text, amount numeric,
        created_at timestamptz DEFAULT now(), issue_date date, carrier_name text,
        check_number text, payee_line text);
      CREATE TABLE public.homeowner_ledger_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, claim_id uuid, check_id uuid,
        event_type text, occurred_at timestamptz, amount numeric, actor_label text, payload_json jsonb);
    `);
    const hleSource = RECORD.preconditions.preserved_function_definition_source[HLE];
    psql(functionBlock(hleSource, 'hle_on_check_intake_insert'));
    psql(functionBlock(RECORD.expected_live_definition_source, 'sync_homeowner_ledger_from_check'));
    psql(`
      CREATE TRIGGER trg_hle_check_intake_insert AFTER INSERT ON public.check_intake_items
        FOR EACH ROW EXECUTE FUNCTION public.hle_on_check_intake_insert();
      CREATE TRIGGER trg_sync_homeowner_ledger_ins AFTER INSERT ON public.check_intake_items
        FOR EACH ROW EXECUTE FUNCTION public.sync_homeowner_ledger_from_check();
      CREATE TRIGGER trg_sync_homeowner_ledger_upd AFTER UPDATE OF status ON public.check_intake_items
        FOR EACH ROW EXECUTE FUNCTION public.sync_homeowner_ledger_from_check();
    `);

    assert.equal(defSha(HLE), RECORD.preconditions.preserved_function_definition_sha256[HLE]);
    assert.equal(defSha(SYNC), RECORD.expected_live_definition_sha256);
    assert.deepEqual(scenario(), { check_received: 2, endorsements_sent: 1, ready_for_deposit: 1 });

    psqlFile(path.join(ROOT, RECORD.filename));

    assert.equal(defSha(SYNC), RECORD.intended_definition_sha256);
    assert.equal(defSha(HLE), RECORD.preconditions.preserved_function_definition_sha256[HLE]);
    assert.deepEqual(scenario(), { check_received: 1, ready_for_deposit: 1 });
    assert.equal(psql(`SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.check_intake_items'::regclass AND NOT tgisinternal`), '3');
    assert.equal(psql(`
      INSERT INTO public.check_intake_items (tenant_id, claim_id, status) VALUES (gen_random_uuid(), NULL, 'needs_review');
      SELECT count(*) FROM public.homeowner_ledger_events e
        JOIN public.check_intake_items c ON c.id = e.check_id WHERE c.claim_id IS NULL`), '0');
  } finally {
    run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(pgData, { recursive: true, force: true });
  }
});
