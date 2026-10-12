/**
 * Production apply path for ledger migration 20261007193200.
 * The PostgreSQL 16 test rebuilds the live definitions (sync 9f6ec2dc…, hle bdd9ec4b…,
 * aws_can_write_claim 0a7e62b2…) and the three ledger triggers, the same fixture the
 * staging executor test uses, and runs the real production inspect and apply.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { AUTHORIZED_LEDGER_20261007193200 as STAGING_PIN } from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  evaluateLedgerProductionApply,
  executeLedgerProductionApply,
  inspectLedgerProduction,
  ledgerSqlForbiddenMutation,
  loadLedgerProductionPin,
  readPinnedLedgerSql,
  resolveLedgerDatabaseUrl,
} from '../../scripts/deployment-guard/lib/ledger-production-apply.mjs';
import { main as ledgerMain } from '../../scripts/deployment-guard/ledger-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PIN = loadLedgerProductionPin(ROOT);
const PG_BIN = '/usr/lib/postgresql/16/bin';
const RECORD = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/ledger-20261007193200-staging-authorization.json'), 'utf8'));
const HLE = 'public.hle_on_check_intake_insert()';

const fingerprint = { sql: PIN.expected_live_definition_sha256 };
function manifest(overrides = {}) {
  return {
    workstream_id: 'prod-ledger-20261007193200-test',
    branch: 'main',
    commit: 'a'.repeat(40),
    operator: 'owner',
    target_environment: 'production',
    target_component: 'production-sql',
    deployment_type: 'sql-apply',
    owned_components: [PIN.filename],
    filename: PIN.filename,
    migration_id: PIN.migration_id,
    source_sha256: PIN.source_sha256,
    expected_live_definition_sha256: PIN.expected_live_definition_sha256,
    live_definition_sha256: PIN.expected_live_definition_sha256,
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: PIN.staging_acceptance,
    approval: { approved: true, workstream_id: 'prod-ledger-20261007193200-test' },
    authorization_phrase: PIN.authorization_phrase,
    one_use_id: `ledger-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-12T18:00:00.000Z',
    ...overrides,
  };
}
const consumedPath = () => path.join(os.tmpdir(), `ledger-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
const neverConnect = async () => { throw new Error('should-not-connect'); };

test('production pin is the staging-applied migration and its exact before/after hashes', () => {
  for (const key of ['filename', 'migration_id', 'source_sha256', 'expected_live_definition_sha256', 'intended_replacement_sha256', 'function_identity', 'trigger_table']) {
    assert.equal(PIN[key], STAGING_PIN[key], key);
  }
  assert.deepEqual(PIN.preserved_function_definition_sha256, STAGING_PIN.preserved_function_definition_sha256);
  assert.deepEqual(PIN.required_ledger_triggers, STAGING_PIN.required_ledger_triggers);
  assert.equal(PIN.target_environment, 'production');
  assert.equal(PIN.deployment_type, 'sql-apply');
  const sql = readPinnedLedgerSql(ROOT, PIN);
  assert.equal(sql.ok, true, JSON.stringify(sql));
  assert.equal(ledgerSqlForbiddenMutation(sql.details.text), null);
  assert.match(PIN.staging_acceptance.reference, /^https:\/\/github\.com\/michaelcarletta-cmd\/ChecksOps\/actions\/runs\/\d+$/);
});

test('the forbidden-mutation check rejects anything beyond the single pinned CREATE OR REPLACE', () => {
  const text = readPinnedLedgerSql(ROOT, PIN).details.text;
  assert.ok(ledgerSqlForbiddenMutation(`${text}\nDROP TRIGGER trg_hle_check_intake_insert ON public.check_intake_items;`));
  assert.ok(ledgerSqlForbiddenMutation(text.replace('sync_homeowner_ledger_from_check()', 'hle_on_check_intake_insert()')));
  assert.ok(ledgerSqlForbiddenMutation(`GRANT ALL ON public.claims TO public;\n${text}`));
});

test('evaluation is bound to the exact pin and the production gate', () => {
  assert.equal(evaluateLedgerProductionApply(manifest(), { root: ROOT, pin: PIN }).ok, true);
  const wrongHash = evaluateLedgerProductionApply(manifest({ expected_live_definition_sha256: 'b'.repeat(64) }), { root: ROOT, pin: PIN });
  assert.equal(wrongHash.code, CODES.SQL_COLLISION);
  assert.deepEqual(wrongHash.details.mismatched, ['expected_live_definition_sha256']);
  assert.equal(evaluateLedgerProductionApply(manifest({ target_environment: 'staging' }), { root: ROOT, pin: PIN }).code, CODES.SQL_COLLISION);
  assert.equal(evaluateLedgerProductionApply(manifest({ approval: { approved: true, workstream_id: 'someone-else' } }), { root: ROOT, pin: PIN }).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal(evaluateLedgerProductionApply(manifest({ staging_acceptance: { ok: false } }), { root: ROOT, pin: PIN }).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const otherRun = { ok: true, reference: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/1' };
  assert.equal(evaluateLedgerProductionApply(manifest({ staging_acceptance: otherRun }), { root: ROOT, pin: PIN }).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal(evaluateLedgerProductionApply(manifest({ immediately_before_fingerprint: { sql: 'c'.repeat(64) } }), { root: ROOT, pin: PIN }).code, CODES.DEPLOYMENT_COLLISION);
});

test('apply refuses before connecting without the phrase or a single-use id', async () => {
  const noPhrase = await executeLedgerProductionApply(manifest({ authorization_phrase: 'yes' }), { root: ROOT, pin: PIN, connect: neverConnect, consumedPath: consumedPath() });
  assert.equal(noPhrase.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const noId = await executeLedgerProductionApply(manifest({ one_use_id: 'x' }), { root: ROOT, pin: PIN, connect: neverConnect, consumedPath: consumedPath() });
  assert.equal(noId.code, CODES.INVALID_MANIFEST);
});

test('admin secret without a host resolves only to the pinned production endpoint', async () => {
  const secret = { username: 'checksops_admin', password: 'p@ss', port: 5432, dbname: 'checksops', engine: 'postgres', dbInstanceIdentifier: 'checksops-production' };
  const resolved = await resolveLedgerDatabaseUrl({ pin: PIN, getSecretValue: async () => JSON.stringify(secret) });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(resolved.details.host, PIN.rds_host);
  const other = await resolveLedgerDatabaseUrl({ pin: PIN, getSecretValue: async () => JSON.stringify({ ...secret, dbInstanceIdentifier: 'checksops-staging' }) });
  assert.equal(other.code, CODES.UNRELATED_MUTATION);
  const staging = await resolveLedgerDatabaseUrl({ pin: PIN, getSecretValue: async () => JSON.stringify({ ...secret, host: 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com' }) });
  assert.equal(staging.ok, false);
  const nonAdmin = await resolveLedgerDatabaseUrl({ pin: PIN, getSecretValue: async () => JSON.stringify({ ...secret, username: 'checksops' }) });
  assert.equal(nonAdmin.ok, false);
});

test('CLI apply needs the guard receipt and CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1', async () => {
  const input = path.join(os.tmpdir(), `ledger-prod-input-${process.pid}.json`);
  fs.writeFileSync(input, JSON.stringify(manifest()));
  const writes = [];
  const orig = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    await ledgerMain(['--apply', '--input', input], {}, {
      root: ROOT,
      pin: PIN,
      enforceScriptGuard: () => ({ ok: true, details: {} }),
      connect: neverConnect,
    });
    await ledgerMain(['--apply', '--input', input], { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, {
      root: ROOT,
      pin: PIN,
      enforceScriptGuard: () => ({ ok: false, code: CODES.DEPLOYMENT_GUARD_REQUIRED, message: 'no receipt' }),
      connect: neverConnect,
    });
  } finally {
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
    fs.rmSync(input, { force: true });
  }
  const out = writes.join('');
  assert.match(out, /GUARD_APPLY_FORBIDDEN/);
  assert.match(out, /DEPLOYMENT_GUARD_REQUIRED/);
  assert.doesNotMatch(out, /should-not-connect/);
});

test('CLI does not spend the receipt on a wrong phrase, a reused id or a receipt for another file', async () => {
  const run = async (overrides, receipt, consumed) => {
    const input = path.join(os.tmpdir(), `ledger-prod-input-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(input, JSON.stringify(manifest(overrides)));
    const writes = [];
    let spent = 0;
    const orig = { out: process.stdout.write, err: process.stderr.write };
    process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    try {
      await ledgerMain(['--apply', '--input', input], { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, {
        root: ROOT,
        pin: PIN,
        enforceScriptGuard: () => ({ ok: true, details: { receipt } }),
        consumeReceiptOnce: () => { spent += 1; return { ok: true }; },
        connect: neverConnect,
        consumedPath: consumed,
      });
    } finally {
      process.stdout.write = orig.out;
      process.stderr.write = orig.err;
      fs.rmSync(input, { force: true });
    }
    return { out: writes.join(''), spent };
  };
  const owned = { owned_components: [PIN.filename] };
  const phrase = await run({ authorization_phrase: 'yes' }, owned, consumedPath());
  assert.equal(phrase.spent, 0);
  assert.match(phrase.out, /PRODUCTION_APPROVAL_REQUIRED/);
  const other = await run({}, { owned_components: ['supabase/migrations/other.sql'] }, consumedPath());
  assert.equal(other.spent, 0);
  assert.match(other.out, /RECEIPT_MISMATCH/);
  const file = consumedPath();
  fs.writeFileSync(file, JSON.stringify({ consumed: ['ledger-prod-reused-id'] }));
  const reused = await run({ one_use_id: 'ledger-prod-reused-id' }, owned, file);
  assert.equal(reused.spent, 0);
  assert.match(reused.out, /RECEIPT_REUSED/);
  for (const r of [phrase, other, reused]) assert.doesNotMatch(r.out, /should-not-connect/);
});

// ---------------------------------------------------------------------------
// Real PostgreSQL 16

const pgSkipReason = () => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return 'PostgreSQL 16 initdb is not installed in this environment';
  if (typeof process.getuid === 'function' && process.getuid() === 0) return 'initdb cannot run as root';
  return null;
};

const functionBlock = (rel, pattern) => {
  const match = fs.readFileSync(path.join(ROOT, rel), 'utf8').match(pattern);
  assert.ok(match, `${rel} defines ${pattern}`);
  return match[0];
};

const SCHEMA_SQL = () => `
SET check_function_bodies = off;
CREATE TABLE public.check_intake_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, claim_id uuid,
  check_source text NOT NULL DEFAULT 'insurance', status text, amount numeric,
  created_at timestamptz DEFAULT now(), issue_date date, carrier_name text,
  check_number text, payee_line text);
CREATE TABLE public.homeowner_ledger_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, claim_id uuid, check_id uuid,
  event_type text, occurred_at timestamptz, amount numeric, actor_label text, payload_json jsonb);
${functionBlock(RECORD.preconditions.preserved_function_definition_source[HLE], /CREATE OR REPLACE FUNCTION public\.hle_on_check_intake_insert\(\)[\s\S]*?\$\$;/)}
${functionBlock(RECORD.expected_live_definition_source, /CREATE OR REPLACE FUNCTION public\.sync_homeowner_ledger_from_check\(\)[\s\S]*?\$\$;/)}
${functionBlock('aws/rls/sql/20_write_helpers.sql', /CREATE OR REPLACE FUNCTION public\.aws_can_write_claim\(_claim_id uuid\)[\s\S]*?\$\$;/)}
CREATE TRIGGER trg_hle_check_intake_insert AFTER INSERT ON public.check_intake_items
  FOR EACH ROW EXECUTE FUNCTION public.hle_on_check_intake_insert();
CREATE TRIGGER trg_sync_homeowner_ledger_ins AFTER INSERT ON public.check_intake_items
  FOR EACH ROW EXECUTE FUNCTION public.sync_homeowner_ledger_from_check();
CREATE TRIGGER trg_sync_homeowner_ledger_upd AFTER UPDATE OF status ON public.check_intake_items
  FOR EACH ROW EXECUTE FUNCTION public.sync_homeowner_ledger_from_check();
`;

async function withCluster(t, fn) {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-ledger-prod-'));
  const port = 59900 + (process.pid % 90);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', pgData, '--auth=trust', '--no-sync', '--username=ubuntu', '--encoding=UTF8'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  fs.appendFileSync(path.join(pgData, 'postgresql.conf'), `\nlisten_addresses = ''\nport = ${port}\nunix_socket_directories = '${pgData}'\nlogging_collector = off\nshared_buffers = 32MB\nmax_connections = 20\n`);
  const started = spawnSync(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-l', path.join(pgData, 'pg.log'), '-w', '-t', '30', 'start'], { encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  const admin = new pg.Client({ host: pgData, port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  let n = 0;
  const freshDatabase = async (mutate = '') => {
    n += 1;
    const database = `ledger_prod_${n}`;
    await admin.query(`CREATE DATABASE ${database}`);
    const seed = new pg.Client({ host: pgData, port, user: 'ubuntu', database });
    await seed.connect();
    await seed.query(SCHEMA_SQL());
    if (mutate) await seed.query(mutate);
    await seed.end();
    return async () => {
      const client = new pg.Client({ host: pgData, port, user: 'ubuntu', database });
      await client.connect();
      return client;
    };
  };
  try {
    await fn(freshDatabase);
  } finally {
    await admin.end();
    spawnSync(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(pgData, { recursive: true, force: true });
  }
}

async function liveSyncSha(connect) {
  const client = await connect();
  try {
    return (await client.query(
      "SELECT encode(sha256(convert_to(pg_get_functiondef('public.sync_homeowner_ledger_from_check()'::regprocedure), 'UTF8')), 'hex') AS h",
    )).rows[0].h;
  } finally {
    await client.end();
  }
}

test('PostgreSQL 16: read-only inspect, apply, replay and drift refusals', { timeout: 180000 }, async (t) => {
  await withCluster(t, async (freshDatabase) => {
    const live = await freshDatabase();
    const inspect = await inspectLedgerProduction({ connect: live, pin: PIN });
    assert.equal(inspect.ok, true, JSON.stringify(inspect));
    assert.equal(inspect.details.live_definition_sha256, PIN.expected_live_definition_sha256);
    assert.equal(inspect.details.apply_preconditions_met, true);
    assert.equal(inspect.details.already_applied, false);
    assert.equal(await liveSyncSha(live), PIN.expected_live_definition_sha256);

    const seed = await live();
    await seed.query(`INSERT INTO public.check_intake_items (tenant_id, claim_id, status, amount) VALUES (gen_random_uuid(), gen_random_uuid(), 'needs_review', 50)`);
    await seed.end();
    const input = manifest();
    const file = consumedPath();
    const applied = await executeLedgerProductionApply(input, { root: ROOT, pin: PIN, connect: live, consumedPath: file });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, PIN.expected_live_definition_sha256);
    assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
    assert.equal(await liveSyncSha(live), PIN.intended_replacement_sha256);

    const replay = await executeLedgerProductionApply(input, { root: ROOT, pin: PIN, connect: live, consumedPath: file });
    assert.equal(replay.code, CODES.RECEIPT_REUSED);
    const again = await executeLedgerProductionApply(manifest(), { root: ROOT, pin: PIN, connect: live, consumedPath: consumedPath() });
    assert.equal(again.code, CODES.UNRELATED_MUTATION);
    const after = await inspectLedgerProduction({ connect: live, pin: PIN });
    assert.equal(after.details.already_applied, true);

    const noTrigger = await freshDatabase('DROP TRIGGER trg_sync_homeowner_ledger_upd ON public.check_intake_items;');
    const missing = await executeLedgerProductionApply(manifest(), { root: ROOT, pin: PIN, connect: noTrigger, consumedPath: consumedPath() });
    assert.equal(missing.code, CODES.DEPLOYMENT_COLLISION);
    assert.deepEqual(missing.details.missing_ledger_triggers, ['trg_sync_homeowner_ledger_upd']);
    assert.equal(await liveSyncSha(noTrigger), PIN.expected_live_definition_sha256);

    const disabled = await freshDatabase('ALTER TABLE public.check_intake_items DISABLE TRIGGER trg_sync_homeowner_ledger_upd;');
    const off = await executeLedgerProductionApply(manifest(), { root: ROOT, pin: PIN, connect: disabled, consumedPath: consumedPath() });
    assert.equal(off.code, CODES.DEPLOYMENT_COLLISION);
    assert.deepEqual(off.details.missing_ledger_triggers, ['trg_sync_homeowner_ledger_upd']);
    assert.equal(await liveSyncSha(disabled), PIN.expected_live_definition_sha256);

    const syncDrift = await freshDatabase(`CREATE OR REPLACE FUNCTION public.sync_homeowner_ledger_from_check()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$ BEGIN RETURN NEW; END; $$;`);
    const changed = await executeLedgerProductionApply(manifest(), { root: ROOT, pin: PIN, connect: syncDrift, consumedPath: consumedPath() });
    assert.equal(changed.code, CODES.SQL_COLLISION);
    assert.notEqual(await liveSyncSha(syncDrift), PIN.intended_replacement_sha256);
  });
});
