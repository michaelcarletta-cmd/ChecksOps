import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AUTHORIZED_SYNTHETIC_FIXTURE as F,
  FORBIDDEN_FREEDOM as X,
  SQL40_FILENAME,
} from '../../scripts/deployment-guard/lib/collection-v2-synthetic-uat-cleanup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APPLY = path.join(ROOT, SQL40_FILENAME);
const PG_BIN = '/usr/lib/postgresql/16/bin';
const ARTIFACT_DIR = '/opt/cursor/artifacts/collection-v2-uat-cleanup-sql';

const DECOY_TMP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const DECOY_EVENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const FREEDOM_EVENT = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';

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

const schemaSql = `
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE checksops NOLOGIN INHERIT;
CREATE ROLE checksops_admin NOLOGIN;
GRANT authenticated TO checksops;
GRANT checksops TO CURRENT_USER;

CREATE TABLE public.tenant_maintenance_payments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  provider_transfer_id text,
  amount_cents integer NOT NULL,
  provider_environment text,
  status text,
  notes text
);
ALTER TABLE public.tenant_maintenance_payments OWNER TO checksops_admin;
GRANT SELECT, INSERT, UPDATE ON public.tenant_maintenance_payments TO checksops, authenticated;

CREATE TABLE public.payment_event_log (
  id uuid PRIMARY KEY,
  tenant_id uuid,
  provider_transfer_id text,
  environment text DEFAULT 'sandbox',
  event_type text,
  previous_status text,
  new_status text,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE public.payment_event_log OWNER TO checksops_admin;
GRANT SELECT, INSERT, UPDATE ON public.payment_event_log TO checksops, authenticated;

CREATE TABLE public.payment_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_transfer_id text,
  tenant_id uuid,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE public.payment_transfers OWNER TO checksops_admin;
GRANT SELECT, INSERT, UPDATE ON public.payment_transfers TO checksops, authenticated;
`;

const notes = (harness = F.harness_id, extra = '') => (
  `${F.marker} harness=${harness} obligation=${F.tmp_id} transfer=${F.provider_transfer_id} collection_v2 ${extra}`
);

const insertAuthorized = ({
  amount = 1,
  status = 'returned',
  env = 'sandbox',
  tenant = F.tenant_id,
  xfer = F.provider_transfer_id,
  harness = F.harness_id,
  extraNotes = '',
} = {}) => `
INSERT INTO public.tenant_maintenance_payments
  (id, tenant_id, provider_transfer_id, amount_cents, provider_environment, status, notes)
VALUES
  ('${F.tmp_id}', '${tenant}', '${xfer}', ${amount}, '${env}', '${status}', '${notes(harness, extraNotes)}');
INSERT INTO public.payment_event_log
  (id, tenant_id, provider_transfer_id, event_type, previous_status, new_status, provider_metadata)
VALUES
  ('${F.event_ids[0]}', '${tenant}', '${xfer}', 'collection_v2.completed', 'submitted', 'settled',
    jsonb_build_object('synthetic_uat_marker', '${F.marker}', 'harness_id', '${harness}', 'checksops_payment_id', '${F.tmp_id}')),
  ('${F.event_ids[1]}', '${tenant}', '${xfer}', 'collection_v2.completed', 'settled', 'returned',
    jsonb_build_object('synthetic_uat_marker', '${F.marker}', 'harness_id', '${harness}', 'checksops_payment_id', '${F.tmp_id}'));
`;

const insertNeighbors = () => `
INSERT INTO public.tenant_maintenance_payments
  (id, tenant_id, provider_transfer_id, amount_cents, provider_environment, status, notes)
VALUES
  ('${X.tmp_id}', '${X.tenant_id}', '${X.provider_transfer_id}', 13900, 'sandbox', 'settled',
    'live Freedom collection transfer=${X.provider_transfer_id}'),
  ('${DECOY_TMP}', '${F.tenant_id}', 'decoy-xfer-not-authorized', 1, 'sandbox', 'returned',
    '${F.marker} harness=dddddddd-dddd-4ddd-8ddd-dddddddddddd obligation=${DECOY_TMP}');
INSERT INTO public.payment_event_log
  (id, tenant_id, provider_transfer_id, event_type, previous_status, new_status, provider_metadata)
VALUES
  ('${FREEDOM_EVENT}', '${X.tenant_id}', '${X.provider_transfer_id}', 'collection_v2.completed', 'submitted', 'settled',
    jsonb_build_object('checksops_payment_id', '${X.tmp_id}')),
  ('${DECOY_EVENT}', '${F.tenant_id}', 'decoy-xfer-not-authorized', 'collection_v2.completed', 'submitted', 'settled',
    jsonb_build_object('synthetic_uat_marker', '${F.marker}', 'harness_id', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'));
INSERT INTO public.payment_transfers (provider_transfer_id, tenant_id, provider_metadata)
VALUES ('${X.provider_transfer_id}', '${X.tenant_id}', jsonb_build_object('obligation_id', '${X.tmp_id}'));
`;

test('isolated PostgreSQL exact-ID synthetic cleanup fails closed and leaves Freedom rows', { timeout: 180000 }, async (t) => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) {
    t.skip('PostgreSQL 16 initdb is not installed in this environment');
    return;
  }
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sql40-'));
  const port = 55400 + (process.pid % 1000);
  const logPath = path.join(pgData, 'pg.log');
  const artifactLog = path.join(ARTIFACT_DIR, 'pg-cleanup.log');
  const notesOut = [];
  const note = (line) => notesOut.push(line);

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
  const psql = (sql, extra = ['-v', 'ON_ERROR_STOP=1', '-At']) => (
    run(path.join(PG_BIN, 'psql'), [...psqlArgs, ...extra, '-c', sql])
  );
  const mustSql = (sql) => {
    const result = psql(sql);
    if (result.status !== 0) {
      throw new Error(`psql failed: ${result.stderr || result.stdout}\nSQL: ${sql.slice(0, 240)}`);
    }
    return String(result.stdout || '').trim();
  };
  const runFile = () => run(path.join(PG_BIN, 'psql'), [
    ...psqlArgs, '-v', 'ON_ERROR_STOP=1', '-At', '-f', APPLY,
  ]);

  try {
    mustSql(schemaSql);
    mustSql(insertNeighbors());
    mustSql(insertAuthorized());

    const appDelete = psql(`
      SET ROLE checksops;
      DELETE FROM public.tenant_maintenance_payments WHERE id = '${F.tmp_id}';
    `);
    note(`app_delete status=${appDelete.status} err=${(appDelete.stderr || '').slice(0, 180)}`);
    assert.notEqual(appDelete.status, 0);
    assert.match(`${appDelete.stderr} ${appDelete.stdout}`, /permission denied/i);
    assert.equal(mustSql(`SELECT count(*) FROM public.tenant_maintenance_payments WHERE id = '${F.tmp_id}'`), '1');

    const applied = runFile();
    note(`happy_path status=${applied.status} err=${(applied.stderr || '').slice(0, 240)}`);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(mustSql(`SELECT count(*) FROM public.tenant_maintenance_payments WHERE id = '${F.tmp_id}'`), '0');
    assert.equal(mustSql(`SELECT count(*) FROM public.payment_event_log WHERE id IN ('${F.event_ids[0]}', '${F.event_ids[1]}')`), '0');
    assert.equal(mustSql(`SELECT count(*) FROM public.tenant_maintenance_payments WHERE id = '${X.tmp_id}'`), '1');
    assert.equal(mustSql(`SELECT count(*) FROM public.tenant_maintenance_payments WHERE id = '${DECOY_TMP}'`), '1');
    assert.equal(mustSql(`SELECT count(*) FROM public.payment_event_log WHERE id = '${FREEDOM_EVENT}'`), '1');
    assert.equal(mustSql(`SELECT count(*) FROM public.payment_event_log WHERE id = '${DECOY_EVENT}'`), '1');
    assert.equal(mustSql(`SELECT count(*) FROM public.payment_transfers WHERE provider_transfer_id = '${X.provider_transfer_id}'`), '1');

    const failCases = [
      ['wrong_amount', insertAuthorized({ amount: 2 }), 'SQL40_TMP_MISMATCH'],
      ['wrong_status', insertAuthorized({ status: 'settled' }), 'SQL40_TMP_MISMATCH'],
      ['wrong_harness', insertAuthorized({ harness: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }), 'SQL40_TMP_MISMATCH'],
      ['forbidden_tenant', insertAuthorized({ tenant: X.tenant_id }), 'SQL40_FORBIDDEN_TMP_REFERENCE'],
    ];
    for (const [name, insertSql, code] of failCases) {
      mustSql(`
        DELETE FROM public.payment_event_log WHERE id IN ('${F.event_ids[0]}', '${F.event_ids[1]}');
        DELETE FROM public.tenant_maintenance_payments WHERE id = '${F.tmp_id}';
      `);
      mustSql(insertSql);
      const failed = runFile();
      note(`${name} status=${failed.status} err=${(failed.stderr || '').slice(0, 220)}`);
      assert.notEqual(failed.status, 0, name);
      assert.match(`${failed.stderr} ${failed.stdout}`, new RegExp(code));
      assert.equal(mustSql(`SELECT count(*) FROM public.tenant_maintenance_payments WHERE id = '${F.tmp_id}'`), '1', name);
      assert.equal(mustSql(`SELECT count(*) FROM public.tenant_maintenance_payments WHERE id = '${X.tmp_id}'`), '1', name);
    }

    mustSql(`
      DELETE FROM public.payment_event_log WHERE id IN ('${F.event_ids[0]}', '${F.event_ids[1]}');
      DELETE FROM public.tenant_maintenance_payments WHERE id = '${F.tmp_id}';
    `);
    mustSql(insertAuthorized());
    mustSql(`DELETE FROM public.payment_event_log WHERE id = '${F.event_ids[1]}'`);
    const missingEvent = runFile();
    note(`missing_event status=${missingEvent.status} err=${(missingEvent.stderr || '').slice(0, 220)}`);
    assert.notEqual(missingEvent.status, 0);
    assert.match(`${missingEvent.stderr} ${missingEvent.stdout}`, /SQL40_EVENT_COUNT|SQL40_EVENT_IDS_MISSING/);
    assert.equal(mustSql(`SELECT count(*) FROM public.tenant_maintenance_payments WHERE id = '${F.tmp_id}'`), '1');

    mustSql(`
      DELETE FROM public.payment_event_log WHERE id IN ('${F.event_ids[0]}', '${F.event_ids[1]}');
      DELETE FROM public.tenant_maintenance_payments WHERE id = '${F.tmp_id}';
    `);
    mustSql(insertAuthorized());
    mustSql(`
      INSERT INTO public.payment_transfers (provider_transfer_id, tenant_id, provider_metadata)
      VALUES ('${F.provider_transfer_id}', '${F.tenant_id}', jsonb_build_object('harness_id', '${F.harness_id}'));
    `);
    const transferPresent = runFile();
    note(`transfer_present status=${transferPresent.status} err=${(transferPresent.stderr || '').slice(0, 220)}`);
    assert.notEqual(transferPresent.status, 0);
    assert.match(`${transferPresent.stderr} ${transferPresent.stdout}`, /SQL40_PAYMENT_TRANSFER_PRESENT/);
    assert.equal(mustSql(`SELECT count(*) FROM public.tenant_maintenance_payments WHERE id = '${F.tmp_id}'`), '1');
    assert.equal(mustSql(`SELECT count(*) FROM public.tenant_maintenance_payments WHERE id = '${X.tmp_id}'`), '1');

    fs.writeFileSync(artifactLog, `${notesOut.join('\n')}\n`);
  } finally {
    run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'fast', 'stop']);
  }
});
