/**
 * Production tool for SQL 141 (scripts/deployment-guard/sql141-permanent-vendor-payees-production-apply.mjs
 * on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 141 included) through the
 * shared refusals; this file covers SQL 141's own:
 *
 *   - the pin has the release pin shape, is pending (execute false, no pre-state, no approval) and is
 *     in step with the staging pin, the one-shot, the bypass inventory and the test lists;
 *   - no predecessor; the three functions, the two policies and the two new tables; no existing
 *     relation is altered (public.tenants included) and no other repository SQL creates these objects;
 *     the send endpoint is not part of this change; the runbook, one-shot doc and README name it;
 *   - the pending pin refuses before connecting; an approved, accepted copy evaluates for the manifest
 *     built from it, and refuses with execute false, another live hash, another staging reference or
 *     a wrong phrase; the CLI spends no receipt.
 * The objects on PostgreSQL 16 are aws/tests/sql141-permanent-vendor-payees-pg.test.mjs (the file applied
 * directly) and aws/tests/sql141-permanent-vendor-payees-tool-pg.test.mjs (through this tool); the executor
 * path is aws/tests/release-sql141-executor.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { ONE_SHOT_TOOLS } from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import { RELEASE_2026_10_17_PENDING_SQL_PINS as STAGING } from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { RELEASE_SQL_SPECS, releaseIntendedHash } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import {
  RELEASE_PRODUCTION,
  evaluateReleaseProductionApply,
  executeReleaseProductionApply,
  loadReleaseProductionPin,
  precheckReleaseProductionApply,
  readPinnedReleaseSql,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { main } from '../../scripts/deployment-guard/sql141-permanent-vendor-payees-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql141';
const SQL141_FILE = 'aws/workflows/sql/141_permanent_vendor_payees.sql';
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
const TABLES = Object.freeze(['public.vendor_tenants', 'public.tenant_vendor_payees']);
const FUNCTIONS = Object.freeze([
  'public.aws_vendor_payee_add(uuid, text)',
  'public.aws_vendor_payee_remove(uuid, uuid)',
  'public.aws_platform_owner_set_tenant_vendor(uuid, boolean)',
]);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql141-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

function manifest(pin) {
  const live = pin.expected_live_definition_sha256;
  const fingerprint = { sql: live };
  const workstream = `prod-${KEY}-release-test`;
  return {
    workstream_id: workstream,
    branch: 'main',
    commit: 'a'.repeat(40),
    operator: 'owner',
    target_environment: 'production',
    target_component: 'production-sql',
    deployment_type: 'sql-apply',
    owned_components: [pin.filename],
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    expected_live_definition_sha256: live,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    live_definition_sha256: live,
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: pin.staging_acceptance,
    approval: { approved: true, workstream_id: workstream },
    authorization_phrase: pin.authorization_phrase,
    one_use_id: `${KEY}-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-11-04T00:00:00.000Z',
  };
}
/** An approved, accepted copy of the committed pin with a recorded pre-state (test only). */
const approved = (extra = {}) => Object.freeze({
  ...COMMITTED,
  authorization: 'Owner approved test fixture',
  execute: true,
  expected_live_definition_sha256: PRE,
  staging_acceptance: { ok: true, reference: STAGING_REF, basis: 'test fixture' },
  ...extra,
});

test('pin: the release pin shape, pending, in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(pin.applied, undefined);
  assert.equal(pin.production_inspect.status, 'pending');
  assert.equal(pin.production_inspect.live_definition_sha256, null);
  assert.equal(pin.production_inspect.ssm_command_id, null);
  assert.match(pin.production_inspect.note, /^Pending: no read-only production inspect has been run for SQL 141 yet\./);
  assert.match(pin.production_inspect.note, /prerequisites_missing/);
  assert.match(pin.production_inspect.note, /release_sql_inspect\.definer_writes/);
  assert.match(pin.production_inspect.note, /default privileges/);
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [false, null]);
  assert.match(pin.staging_acceptance.basis, /read-live and the staging apply of SQL 141/);
  assert.equal(pin.filename, SQL141_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(staging.execute, false);
  assert.equal(staging.authorization, 'pending');
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, read(SQL141_FILE)));
  assert.deepEqual(pin.function_identities, FUNCTIONS);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_PERMANENT_VENDOR_PAYEES');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql141-permanent-vendor-payees-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-141-apply.md');
  for (const file of [pin.tooling.production_tool, pin.tooling.runbook, pin.tooling.fingerprint_engine, pin.tooling.production_lib, ...pin.tooling.tests]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  }
  assert.equal(readPinnedReleaseSql(KEY, ROOT, pin).ok, true);
  // One-shot: the release tool with its order (no hash in the registry).
  const tool = ONE_SHOT_TOOLS[KEY];
  assert.equal(tool.key, KEY);
  assert.equal(tool.script, RELEASE_PRODUCTION[KEY].cli);
  assert.deepEqual([...tool.args], []);
  assert.equal(tool.pin_rel, RELEASE_PRODUCTION[KEY].pin_rel);
  assert.equal(tool.allowed_key, 'sql141_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(RELEASE_SQL_SPECS[KEY].runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql141-permanent-vendor-payees-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql141-production-apply"\]/);
  assert.match(rows, /sql135, sql136, sql137, sql138, sql139, sql140, sql141, sql142, sql143, sql144, sql145, sql146, sql147, sql148, sql150, sql152, sql153, sql154, sql155, sql156, sql158, sql159, sql160\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = read('.github/workflows/deployment-guard.yml');
  for (const name of ['aws/tests/release-sql141-executor.test.mjs', 'aws/tests/release-sql141-production-apply.test.mjs', 'aws/tests/sql141-permanent-vendor-payees-pg.test.mjs', 'aws/tests/sql141-permanent-vendor-payees-tool-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; three functions, two policies, two new tables; no existing relation altered; no other repository SQL creates them; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['supersedes', 'refuse_after', 'runs_before', 'acl_functions', 'dropped_functions', 'dropped_policies', 'views', 'triggers', 'table_privileges', 'column_acl', 'added_columns', 'constraints', 'altered_relations', 'whole_tables', 'render']) {
    assert.equal(spec[absent], undefined, absent);
  }
  assert.deepEqual(spec.functions.map((fn) => [fn.identity, [...fn.acl], fn.revokes]), FUNCTIONS.map((f) => [f, ['checksops EXECUTE', 'owner EXECUTE'], undefined]));
  assert.deepEqual(spec.tables.map((t) => [t.name, t.rls, t.forced, [...t.acl]]), TABLES.map((t) => [t, true, false, ['authenticated SELECT', 'checksops SELECT']]));
  assert.deepEqual(spec.policies.map((p) => [p.table, p.name, p.cmd, [...p.roles]]), [
    ['public.vendor_tenants', 'aws_select_vendor_tenants', 'SELECT', ['authenticated']],
    ['public.tenant_vendor_payees', 'aws_select_tenant_vendor_payees', 'SELECT', ['authenticated']],
  ]);
  assert.deepEqual(spec.definer_writes, ['public.tenants', 'public.tenant_partner_code_aliases']);
  // Nothing in the release refuses after SQL 141, supersedes it or needs it.
  assert.deepEqual(Object.keys(RELEASE_SQL_SPECS).filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  assert.match(COMMITTED.order_note, /^No predecessor and no order on this engine/);
  assert.match(COMMITTED.order_note, /owner decision 2026-11-03/);
  assert.match(COMMITTED.order_note, /never creates a tenant partnership/);
  assert.match(COMMITTED.order_note, /Nothing moves money/);
  assert.match(COMMITTED.order_note, /moov-send\.mjs\) is a separate API change/);
  assert.match(COMMITTED.order_note, /already_applied true/);

  // The file creates only its own objects: no statement on public.tenants or another existing relation.
  const code = stripComments(read(SQL141_FILE));
  assert.deepEqual([...code.matchAll(/CREATE TABLE IF NOT EXISTS (public\.[a-z_]+)/g)].map((m) => m[1]), TABLES);
  assert.deepEqual([...code.matchAll(/CREATE OR REPLACE FUNCTION (public\.[a-z_]+)\(/g)].map((m) => m[1]), FUNCTIONS.map((f) => f.split('(')[0]));
  assert.deepEqual([...code.matchAll(/ALTER TABLE (public\.[a-z_]+)/g)].map((m) => m[1]), TABLES);
  assert.deepEqual([...code.matchAll(/CREATE POLICY ([a-z_]+) ON (public\.[a-z_]+)/g)].map((m) => [m[2], m[1]]), spec.policies.map((p) => [p.table, p.name]));
  assert.doesNotMatch(code, /\b(UPDATE|DELETE FROM|INSERT INTO|ALTER TABLE|GRANT [A-Z, ]+ ON TABLE|REVOKE [A-Z ]+ ON TABLE) public\.(tenants|tenant_users|tenant_partner_code_aliases|tenant_partnerships|shared_checks|stakeholder_accounts|external_payment_recipients)\b/);
  // No other repository SQL creates these tables or functions.
  for (const dir of ['aws/workflows/sql', 'aws/write-path/sql', 'aws/rls/sql', 'aws/db-copy/sql']) {
    for (const file of fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.sql'))) {
      const rel = `${dir}/${file}`;
      if (rel === SQL141_FILE) continue;
      assert.doesNotMatch(stripComments(read(rel)), /\b(vendor_tenants|tenant_vendor_payees|aws_vendor_payee_add|aws_vendor_payee_remove|aws_platform_owner_set_tenant_vendor)\b/, rel);
    }
  }
  const runbook = read(COMMITTED.tooling.runbook);
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* guarded tooling built; not applied anywhere\. The staging pin is pending \(no read-live yet\); the production pin is pending\./);
  assert.match(runbook, /APPLY_PERMANENT_VENDOR_PAYEES/);
  assert.match(runbook, /Owner decision 2026-11-03/);
  assert.match(runbook, /\*\*Nothing here moves money\*\*/);
  assert.match(runbook, /16522f0a99f22410a73e4a80e10e48a10a08162171345d72e0f72bc47338982f/);
  const oneShot = read('ops/production-sql-one-shot.md');
  assert.match(oneShot, /\| `sql141` \|/);
  assert.match(oneShot, /`sql136`, `sql137`, `sql138`, `sql139`, `sql140`, `sql141`, `sql142`, `sql143`, `sql144`, `sql145`, `sql146`, `sql147`, `sql148`, `sql150`, `sql152`, `sql153`, `sql154`, `sql155`, `sql156`, `sql158`, `sql159`, `sql160`\) \|/);
  assert.match(read('ops/deployment-guard/README.md'), /sql141-permanent-vendor-payees-production-apply\.mjs --inspect/);
});

test('the pending pin refuses before connecting; an approved copy allows only its own manifest; execute false, other hashes and phrases refuse', async () => {
  const noPre = await evaluateReleaseProductionApply(KEY, manifest({ ...COMMITTED, expected_live_definition_sha256: PRE }), { root: ROOT });
  assert.equal(noPre.code, CODES.SQL_COLLISION);
  const withPre = { ...COMMITTED, expected_live_definition_sha256: PRE };
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(withPre), { root: ROOT, pin: withPre })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(withPre), { root: ROOT, pin: withPre, connect: neverConnect, consumedPath: consumedPath() })).ok, false);
  // execute true alone does not authorize it.
  const flipped = { ...withPre, execute: true };
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(flipped), { root: ROOT, pin: flipped })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql141_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY_WALLET_FUNDING_SETTINGS_WRITE_GRANTS' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed (pending) pin, read from disk, refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql141-cli-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify(manifest(pin)));
  const writes = [];
  let spent = 0;
  const orig = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    await main(['--apply', '--input', file], { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, {
      root: ROOT, consumeReceiptOnce: () => { spent += 1; return { ok: true }; }, connect: neverConnect, consumedPath: consumedPath(),
    });
    await main(['--inspect', '--password', 'x'], {}, { root: ROOT, connect: neverConnect });
  } finally {
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
    fs.rmSync(file, { force: true });
  }
  const out = writes.join('');
  assert.equal(spent, 0);
  assert.doesNotMatch(out, /should-not-connect/);
  assert.match(out, /SQL_COLLISION|PRODUCTION_APPROVAL_REQUIRED|DEPLOYMENT_GUARD_REQUIRED/);
  assert.match(out, /credential flags are refused/);
});
