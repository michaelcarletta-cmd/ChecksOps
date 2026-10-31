/**
 * Production tool for SQL 137 (scripts/deployment-guard/sql137-platform-owner-identity-production-
 * apply.mjs on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 137 included) through the
 * shared refusals; this file covers SQL 137's own:
 *
 *   - the pin has the release pin shape, is pending (execute false, no pre-state, no approval) and is
 *     in step with the staging pin, the one-shot, the bypass inventory and the test lists;
 *   - no predecessor; one function (is_platform_owner(), the only definition in the repository's AWS
 *     SQL besides aws/rls/sql/10); the API reads platform-owner status only through the function; no
 *     API path updates an email column or updates, deletes or truncates identity_accounts (read from
 *     the source); the runbook, one-shot doc and README name it;
 *   - the pending pin refuses before connecting; an approved, accepted copy evaluates for the manifest
 *     built from it, and refuses with execute false, another live hash, another staging reference or
 *     a wrong phrase; the CLI spends no receipt.
 * The function and grants on PostgreSQL 16 are aws/tests/sql137-platform-owner-identity-pg.test.mjs;
 * the executor path is aws/tests/release-sql137-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql137-platform-owner-identity-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql137';
const SQL137_FILE = 'aws/workflows/sql/137_platform_owner_identity.sql';
const TABLE = 'public.identity_accounts';
const FUNCTION = 'public.is_platform_owner()';
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql137-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
/** Every .mjs file under a directory (node_modules excluded). */
const mjsFiles = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
  if (d.name === 'node_modules') return [];
  const rel = `${dir}/${d.name}`;
  if (d.isDirectory()) return mjsFiles(rel);
  return d.name.endsWith('.mjs') ? [rel] : [];
});

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
    build_timestamp: '2026-10-31T00:00:00.000Z',
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
  assert.match(pin.production_inspect.note, /^Pending: no read-only production inspect has been run for SQL 137 yet\./);
  assert.match(pin.production_inspect.note, /prerequisites_missing/);
  assert.match(pin.production_inspect.note, /release_sql_inspect\.functions, release_sql_inspect\.privileges/);
  assert.match(pin.production_inspect.note, /sql137_owner_identity_count, sql137_owner_profile_without_identity/);
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [false, null]);
  assert.match(pin.staging_acceptance.basis, /read-live and the staging apply of SQL 137/);
  assert.equal(pin.filename, SQL137_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.ok(pin.intended_post_state.note.endsWith(`${pin.intended_replacement_sha256}.`));
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, read(SQL137_FILE)));
  assert.deepEqual(pin.function_identities, [FUNCTION]);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_PLATFORM_OWNER_IDENTITY');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql137-platform-owner-identity-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-137-apply.md');
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
  assert.equal(tool.allowed_key, 'sql137_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(RELEASE_SQL_SPECS[KEY].runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql137-platform-owner-identity-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql137-production-apply"\]/);
  assert.match(rows, /sql133, sql134, sql135, sql137, sql138\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = read('.github/workflows/deployment-guard.yml');
  for (const name of ['aws/tests/release-sql137-executor.test.mjs', 'aws/tests/release-sql137-production-apply.test.mjs', 'aws/tests/sql137-platform-owner-identity-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; one function, defined only in aws/rls/sql/10 before; the API decides owner status through it and writes no email column of profiles or identity_accounts; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['supersedes', 'refuse_after', 'runs_before', 'acl_functions', 'dropped_functions', 'tables', 'views', 'policies', 'triggers', 'column_acl', 'definer_writes', 'whole_tables', 'render']) {
    assert.equal(spec[absent], undefined, absent);
  }
  assert.deepEqual(spec.functions.map((fn) => fn.identity), [FUNCTION]);
  assert.deepEqual(spec.table_privileges.map((p) => [p.table, p.intended.length]), [[TABLE, 0]]);
  assert.deepEqual(spec.altered_relations, [TABLE]);
  assert.match(COMMITTED.order_note, /^No predecessor and no order on this engine/);
  assert.match(COMMITTED.order_note, /finding 15/);
  assert.match(COMMITTED.order_note, /sql137_owner_profile_without_identity/);
  assert.match(COMMITTED.order_note, /already_applied true/);

  // The repository's AWS SQL defines is_platform_owner() only in aws/rls/sql/10 (and now SQL 137).
  const defines = [];
  for (const dir of ['aws/rls/sql', 'aws/workflows/sql', 'aws/identity/sql', 'aws/write-path/sql']) {
    if (!fs.existsSync(path.join(ROOT, dir))) continue;
    for (const file of fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.sql'))) {
      if (/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.is_platform_owner\s*\(/i.test(stripComments(read(`${dir}/${file}`)))) defines.push(`${dir}/${file}`);
    }
  }
  assert.deepEqual(defines.sort(), ['aws/rls/sql/10_owner_helpers_from_identity.sql', SQL137_FILE]);

  // The API: no UPDATE of an email column of profiles or identity_accounts, no UPDATE, DELETE or
  // TRUNCATE of identity_accounts; its profiles UPDATEs set only full_name / phone and totp_enrolled_at.
  const api = mjsFiles('aws/functions');
  assert.ok(api.length > 20, 'API sources found');
  for (const rel of api) {
    const src = read(rel);
    assert.doesNotMatch(src, /UPDATE\s+(public\.)?identity_accounts\b/i, rel);
    assert.doesNotMatch(src, /DELETE\s+FROM\s+(public\.)?(identity_accounts|profiles)\b/i, rel);
    assert.doesNotMatch(src, /TRUNCATE[^;`]*\bidentity_accounts\b/i, rel);
    for (const m of src.matchAll(/UPDATE\s+public\.profiles\s+SET\s+([^`]*?)\s+WHERE/gi)) {
      assert.doesNotMatch(m[1], /\bemail\b/, `${rel}: ${m[0]}`);
    }
    for (const m of src.matchAll(/INSERT INTO public\.(identity_accounts|profiles)[\s\S]*?ON CONFLICT[^`]*?DO\s+(\w+)/g)) {
      assert.equal(m[2], 'NOTHING', `${rel}: ${m[0].slice(0, 80)}`);
    }
  }
  const metadata = read('aws/functions/api/write-app-metadata.mjs');
  const profiles = metadata.slice(metadata.indexOf('export const executeProfiles'), metadata.indexOf('export const executeCompanyBranding'));
  assert.deepEqual([...profiles.matchAll(/out\.([a-z_]+) = /g)].map((m) => m[1]), ['full_name', 'phone']);
  // Platform-owner status in the API comes from the function (data.mjs, workflow-rpc.mjs and the others).
  assert.match(read('aws/functions/api/data.mjs'), /export const IS_PLATFORM_OWNER_SQL = 'SELECT public\.is_platform_owner\(\) AS is_owner';/);

  const runbook = read(COMMITTED.tooling.runbook);
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* staging pin execute-authorized \(wave 32\)/);
  assert.match(runbook, /read-live \(2026-10-31\)\.\*\* Run 41234275408/);
  assert.ok(runbook.includes('a2c2d856a21c52d47544fad05e0f0275a24a093421c8a7a7fbeea0e4bb329dfc'));
  assert.match(runbook, /APPLY_PLATFORM_OWNER_IDENTITY/);
  assert.match(runbook, /finding 15/);
  const oneShot = read('ops/production-sql-one-shot.md');
  assert.match(oneShot, /\| `sql137` \|/);
  assert.match(oneShot, /`sql134`, `sql135`, `sql137`, `sql138`\) \|/);
  assert.match(read('ops/deployment-guard/README.md'), /sql137-platform-owner-identity-production-apply\.mjs --inspect/);
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
  assert.equal(allowed.details.sql137_production_apply_allowed, true);
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
  const file = path.join(os.tmpdir(), `sql137-cli-${process.pid}.json`);
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
