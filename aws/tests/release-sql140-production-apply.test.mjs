/**
 * Production tool for SQL 140 (scripts/deployment-guard/sql140-wallet-funding-settings-write-grants-
 * production-apply.mjs on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 140 included) through the
 * shared refusals; this file covers SQL 140's own:
 *
 *   - the pin has the release pin shape, is pending (execute false, no pre-state, no approval) and is
 *     in step with the staging pin, the one-shot, the bypass inventory and the test lists;
 *   - no predecessor; no function; the twelve INSERT columns are exactly tenant_id, the request columns
 *     saveTenantWalletFundingSettings (aws/functions/api/tenant-settings-handlers.mjs) accepts and the
 *     two acceptance columns it stamps, the twelve UPDATE columns the same but tenant_id plus updated_at,
 *     read from the source; no repository SQL grants INSERT or UPDATE on the table; the policies stay
 *     the boundary; the runbook, one-shot doc and README name it;
 *   - the pending pin refuses before connecting; an approved, accepted copy evaluates for the manifest
 *     built from it, and refuses with execute false, another live hash, another staging reference or
 *     a wrong phrase; the CLI spends no receipt.
 * The grants on PostgreSQL 16 are aws/tests/sql140-wallet-funding-settings-write-grants-pg.test.mjs; the
 * executor path is aws/tests/release-sql140-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql140-wallet-funding-settings-write-grants-production-apply.mjs';
import { COLUMNS, INSERT_COLUMNS, TABLE, UPDATE_COLUMNS, pinned } from './helpers/sql140-wallet-funding-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql140';
const SQL140_FILE = 'aws/workflows/sql/140_wallet_funding_settings_write_grants.sql';
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql140-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
const quoted = (s) => [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

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
    build_timestamp: '2026-11-02T00:00:00.000Z',
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
  assert.match(pin.production_inspect.note, /^Pending: no read-only production inspect has been run for SQL 140 yet\./);
  assert.match(pin.production_inspect.note, /prerequisites_missing/);
  assert.match(pin.production_inspect.note, /release_sql_inspect\.columns/);
  assert.match(pin.production_inspect.note, /the table ACL of tenant_wallet_funding_settings/);
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [false, null]);
  assert.match(pin.staging_acceptance.basis, /read-live and the staging apply of SQL 140/);
  assert.equal(pin.filename, SQL140_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  // The staging pin is apply-authorized (wave 36) from its read-live; the production pin stays pending.
  assert.equal(staging.execute, true);
  assert.equal(staging.expected_live_definition_sha256, 'fa08a3db73806391d757885c9165d0f1bf56a4571a22b1a32e2e63c73578952d');
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, read(SQL140_FILE)));
  assert.deepEqual(pin.function_identities, []);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_WALLET_FUNDING_SETTINGS_WRITE_GRANTS');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql140-wallet-funding-settings-write-grants-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-140-apply.md');
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
  assert.equal(tool.allowed_key, 'sql140_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(RELEASE_SQL_SPECS[KEY].runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql140-wallet-funding-settings-write-grants-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql140-production-apply"\]/);
  assert.match(rows, /sql134, sql135, sql136, sql137, sql138, sql139, sql140\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = read('.github/workflows/deployment-guard.yml');
  for (const name of ['aws/tests/release-sql140-executor.test.mjs', 'aws/tests/release-sql140-production-apply.test.mjs', 'aws/tests/sql140-wallet-funding-settings-write-grants-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; no function; exactly the columns the automatic funding save writes, checksops only; no other repository grant on the table; the policies stay the boundary; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['supersedes', 'refuse_after', 'runs_before', 'acl_functions', 'dropped_functions', 'tables', 'views', 'policies', 'triggers', 'table_privileges', 'definer_writes', 'whole_tables', 'render']) {
    assert.equal(spec[absent], undefined, absent);
  }
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.column_acl.map((c) => c.column), [...COLUMNS]);
  assert.ok(spec.column_acl.every((c) => c.table === TABLE && c.revokes === undefined && c.acl.every((l) => /^checksops (INSERT|UPDATE)$/.test(l))));
  assert.deepEqual(spec.column_acl.map((c) => [...c.acl]), COLUMNS.map((c) => pinned(c)));
  assert.deepEqual(spec.altered_relations, [TABLE]);
  assert.deepEqual(spec.prerequisites, [TABLE, ...COLUMNS.map((c) => `column ${TABLE}.${c}`), 'role checksops']);
  // Nothing in the release refuses after SQL 140, supersedes it or needs it.
  assert.deepEqual(Object.keys(RELEASE_SQL_SPECS).filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  assert.match(COMMITTED.order_note, /^No predecessor and no order on this engine/);
  assert.match(COMMITTED.order_note, /#1524/);
  assert.match(COMMITTED.order_note, /permission denied for table tenant_wallet_funding_settings/);
  assert.match(COMMITTED.order_note, /02_grant_readonly_application_role\.sql/);
  assert.match(COMMITTED.order_note, /already_applied true/);

  // The columns are the ones saveTenantWalletFundingSettings writes, read from the API source: tenant_id, the
  // request columns parseWalletFundingPatch accepts (the boolean and cents fields, the strategy, the bank, the
  // method id, the version) and the two acceptance columns the server stamps; the update adds updated_at.
  const api = read('aws/functions/api/tenant-settings-handlers.mjs');
  const booleans = quoted(/const WALLET_FUNDING_BOOLEAN_FIELDS = Object\.freeze\(\[([^\]]*)\]\)/.exec(api)[1]);
  const cents = quoted(/const WALLET_FUNDING_CENTS_FIELDS = Object\.freeze\(\[([^\]]*)\]\)/.exec(api)[1]);
  const known = quoted(/const known = new Set\(\[([\s\S]*?)\]\);/.exec(api)[1]).filter((w) => !/^WALLET_FUNDING/.test(w));
  const request = [...booleans, ...cents, ...known];
  assert.deepEqual([...request].sort(), [...INSERT_COLUMNS.slice(1)].filter((c) => !c.startsWith('authorization_accepted')).sort());
  const save = api.slice(api.indexOf('export const saveTenantWalletFundingSettings'), api.indexOf('export const runSaveTenantWalletFundingSettings'));
  assert.match(save, /const insertColumns = \['tenant_id', \.\.\.columns, \.\.\.\(patch\.authorization_version \? \['authorization_accepted_at', 'authorization_accepted_by'\] : \[\]\)\];/);
  assert.match(save, /authorization_accepted_at = now\(\), authorization_accepted_by = \$' \+ \(columns\.length \+ 2\) \+ '::uuid'/);
  assert.match(save, /ON CONFLICT \(tenant_id\) DO UPDATE SET \$\{updates\}\$\{acceptance\}, updated_at = now\(\)/);
  assert.match(save, /await setMoneyWriteFlag\(client\);\s*const rows = \(await client\.query\(\s*`INSERT INTO public\.tenant_wallet_funding_settings/);
  assert.equal((api.match(/INSERT INTO public\.tenant_wallet_funding_settings/g) || []).length, 1);
  assert.doesNotMatch(api, /UPDATE public\.tenant_wallet_funding_settings|DELETE FROM public\.tenant_wallet_funding_settings/);
  assert.deepEqual(UPDATE_COLUMNS, [...INSERT_COLUMNS.slice(1), 'updated_at']);

  // The file: the precondition block, then one INSERT grant and one UPDATE grant to checksops.
  const code = stripComments(read(SQL140_FILE));
  const blockEnd = code.indexOf('$sql140_preconditions$;') + '$sql140_preconditions$;'.length;
  const statements = code.slice(blockEnd).split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  assert.deepEqual(statements, [
    `GRANT INSERT ( ${INSERT_COLUMNS.join(', ')} ) ON TABLE ${TABLE} TO checksops`,
    `GRANT UPDATE ( ${UPDATE_COLUMNS.join(', ')} ) ON TABLE ${TABLE} TO checksops`,
  ]);
  // Grant history: no other repository SQL grants INSERT or UPDATE on tenant_wallet_funding_settings; the
  // restore gave the application role SELECT only.
  for (const dir of ['aws/workflows/sql', 'aws/write-path/sql', 'aws/rls/sql', 'aws/db-copy/sql']) {
    for (const file of fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.sql'))) {
      const rel = `${dir}/${file}`;
      if (rel === SQL140_FILE) continue;
      assert.doesNotMatch(stripComments(read(rel)), /GRANT[^;]*\b(INSERT|UPDATE|ALL)\b[^;]*ON\s+(TABLE\s+)?public\.tenant_wallet_funding_settings\b/i, rel);
    }
  }
  assert.match(read('aws/db-copy/sql/02_grant_readonly_application_role.sql'), /^GRANT SELECT ON ALL TABLES IN SCHEMA public TO checksops;$/m);
  // The policies that stay the boundary are the repository's.
  assert.match(read('aws/rls/sql/24_complete_write_policies.sql'), /CREATE POLICY aws_write_tenant_wallet_funding_settings ON public\.tenant_wallet_funding_settings\n {2}FOR ALL TO authenticated\n {2}USING \(public\.aws_can_write_tenant\(tenant_id\)\)\n {2}WITH CHECK \(public\.aws_can_write_tenant\(tenant_id\)\);/);
  assert.match(read('aws/rls/sql/12_final_select_policies.sql'), /CREATE POLICY aws_select_tenant_wallet_funding_settings ON public\.tenant_wallet_funding_settings/);
  assert.match(read('aws/rls/sql/26_enable_rls.sql'), /ALTER TABLE public\.tenant_wallet_funding_settings ENABLE ROW LEVEL SECURITY;/);
  for (const gate of ['insert', 'update', 'delete']) {
    assert.match(read('aws/workflows/sql/136_money_write_restrictive_policies.sql'), new RegExp(`CREATE POLICY aws_money_write_gate_${gate}_tenant_wallet_funding_settings ON public\\.tenant_wallet_funding_settings`));
  }
  const runbook = read(COMMITTED.tooling.runbook);
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* staging pin execute-authorized \(wave 36\); not applied anywhere\. The production pin is pending\./);
  assert.match(runbook, /read-live \(2026-11-02\)\.\*\* Run 41452217978/);
  assert.ok(runbook.includes(STAGING[KEY].expected_live_definition_sha256));
  assert.match(runbook, /APPLY_WALLET_FUNDING_SETTINGS_WRITE_GRANTS/);
  assert.match(runbook, /2026-11-02 12:31:40Z/);
  assert.match(runbook, /fa08a3db73806391d757885c9165d0f1bf56a4571a22b1a32e2e63c73578952d/);
  const oneShot = read('ops/production-sql-one-shot.md');
  assert.match(oneShot, /\| `sql140` \|/);
  assert.match(oneShot, /`sql135`, `sql136`, `sql137`, `sql138`, `sql139`, `sql140`\) \|/);
  assert.match(read('ops/deployment-guard/README.md'), /sql140-wallet-funding-settings-write-grants-production-apply\.mjs --inspect/);
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
  assert.equal(allowed.details.sql140_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY_CHECK_CREATE_INSERT_GRANT' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed (pending) pin, read from disk, refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql140-cli-${process.pid}.json`);
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
