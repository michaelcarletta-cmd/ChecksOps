/**
 * Production tool for SQL 159 (scripts/deployment-guard/sql159-homeowner-intro-requests-select-grant-production-apply.mjs on
 * lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs). Owner 2026-11-12, option (a), "A now":
 * checksops table SELECT on public.homeowner_intro_requests, so a contractor's Leads list loads in production.
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 159 included) through the shared refusals;
 * this file covers SQL 159's own:
 *
 *   - the pin has the release pin shape; it was execute-authorized (owner-approved pin change of 2026-11-12, #1815), is
 *     applied (2026-11-12, "apply SQL 159 in production") and retired (execute false, the apply run recorded in applied), with the
 *     recorded production pre-state (read-only inspect SSM acaf2260; the derived no-grant state) and the staging read-live
 *     (already in the intended state, no staging apply) as its acceptance; it is in step with the staging pin (which
 *     stays pending), the one-shot, the bypass inventory and the test lists;
 *   - no predecessor; one table grant (checksops SELECT), no function, policy, RLS, trigger or write grant; no overlay
 *     plan entry; the runbook, one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; the committed pin allows only the manifest bound
 *     to its recorded pre-state; an approved, accepted copy evaluates for the manifest built from it,
 *     and refuses with execute false, another live hash, another staging reference or a wrong phrase; the CLI spends no
 *     receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql159-homeowner-intro-requests-select-grant-pg.test.mjs; the executor path
 * is aws/tests/release-sql159-executor.test.mjs.
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
import { RELEASE_SQL_SPECS, releaseIntendedHash, releaseStateHash } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import {
  RELEASE_PRODUCTION,
  evaluateReleaseProductionApply,
  executeReleaseProductionApply,
  loadReleaseProductionPin,
  precheckReleaseProductionApply,
  readPinnedReleaseSql,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { main } from '../../scripts/deployment-guard/sql159-homeowner-intro-requests-select-grant-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql159';
const SQL159_FILE = 'aws/workflows/sql/159_homeowner_intro_requests_select_grant.sql';
const TABLE = 'public.homeowner_intro_requests';
/** The production pre-state: the table present, checksops without SELECT on it (no line). */
const NO_GRANT = releaseStateHash(KEY, { privileges: { [TABLE]: { exists: true, lines: [] } } });
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
// SQL 159's recorded production pre-state (read-only inspect of 2026-11-12, SSM acaf2260, main a8a0afa7b): checksops without
// SELECT on the table, the derived no-grant state.
const PRODUCTION_PRE = '6170e77b6e8b764b28de0d41779ad2d326d867409b401a4b7fd0bb4aa27b7c50';
// The guarded staging read-live (already in the intended state there; no staging apply).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43232074130';
// The owner's words for SQL 159, quoted in the authorization.
const OWNER_WORDS = Object.freeze(['"A now"', '"Yes start that"', '"Yes start the staging refresh and read-live"', '"Yes do the record PR and the production inspect"']);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql159-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-11-12T00:00:00.000Z',
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

test('pin: the release pin shape, applied and retired (owner approved 2026-11-12 on the staging read-live; applied 2026-11-12), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)(\.|$)/.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Owner-approved pin change of 2026-11-12: the read-only production inspect (SSM acaf2260, main a8a0afa7b) recorded as
  // the pre-state; the staging read-live (run 43232074130, already in the intended state) as the acceptance.
  // Then applied 2026-11-12 under the owner's own words for that run, and retired.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-11-12; execute is false again/);
  for (const words of [...OWNER_WORDS, '"Merge 1815 when green"', '"apply SQL 159 in production"']) assert.ok(pin.authorization.includes(words), words);
  assert.ok(pin.authorization.includes('#1815'));
  const applied = pin.applied;
  assert.deepEqual([applied.date, applied.result, applied.apply_ssm_command_id, applied.inspect_ssm_command_id, applied.one_shot_run_id, applied.one_use_id, applied.one_use_id_consumed, applied.owner_approval],
    ['2026-11-12', 'applied', '55844713-816d-4a6e-a365-96db7cf61af3', '10a80f13-5313-4651-b14f-76b8ac4e2063', '8380da36-7587-4cf3-9083-4f9ae251f379', 'sql159-prod-a555299d-2bf6-42dc-9f08-4346756fdbc0', true, 'apply SQL 159 in production']);
  assert.equal(applied.source_commit, '32022c676e9235ed6b71df3da816b79a0c062b67');
  assert.equal(applied.source_tarball.sha256, '0a8a412d07a94a33cb0bb8a56ad62a5a8e43b1b91830cb9a64ae3aa3ca60f196');
  assert.equal(applied.migration_source_sha256, pin.source_sha256);
  assert.deepEqual(applied.steps, ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
  assert.deepEqual(Object.values(applied.contract_results).map((c) => c.evidence.split(' ')[0]), ['4/4', '6/6', '43/43']);
  assert.equal(applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(applied.receipt.before_hash, pin.expected_live_definition_sha256);
  assert.equal(applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(applied.post_apply_inspect.already_applied, true);
  assert.equal(applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(applied.post_apply_inspect.release_sql_inspect.table_privileges, [{ name: 'homeowner_intro_requests', lines: ['checksops SELECT'], other_write_grants: [] }]);
  assert.deepEqual(applied.receipt.release_sql_inspect.table_privileges, applied.post_apply_inspect.release_sql_inspect.table_privileges);
  for (const text of ['transfer run 43238102298', '10a80f13-5313-4651-b14f-76b8ac4e2063', 'arrived whole', 'Production acceptance: not yet reported by the owner']) assert.ok(applied.one_shot_note.includes(text), text);
  // The earlier attempt the same day committed nothing; this run's pre-apply inspect read the same pre-state.
  for (const text of ['658d76f1-83be-4e68-b589-ded9c40c8e65', 'Nothing was committed', '15:00:00Z', '6170e77b']) assert.ok(applied.earlier_attempt.includes(text), text);
  for (const text of ['55844713-816d-4a6e-a365-96db7cf61af3', '8380da36-7587-4cf3-9083-4f9ae251f379', '10a80f13-5313-4651-b14f-76b8ac4e2063']) assert.ok(pin.production_evidence['2026-11-12 apply'].includes(text), text);
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, NO_GRANT);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.notEqual(pin.expected_live_definition_sha256, releaseStateHash(KEY, {}));
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-11-12');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, 'acaf2260-cef8-4d40-9f19-85a5c87c873d');
  assert.equal(pin.production_inspect.source_commit, 'a8a0afa7b4733b252fd3be412747ac68a46be805');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('c30c1876d3b2b8d543e2fe2c3f4d2ffef476f8badbd8f43e2ed5c7f99f086a06'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.match(pin.production_inspect.note, /homeowner_intro_requests lines \[\] \(checksops holds no SELECT\), other_write_grants \[\]/);
  assert.match(pin.production_inspect.note, /If already_applied is true, the table is missing/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no release-engine production inspect has been run for SQL 159 yet.'));
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor read-live of sql159-homeowner-intro-requests-select-grant, run 43232074130/);
  assert.match(pin.staging_acceptance.basis, /deploy run 43231455999/);
  assert.match(pin.staging_acceptance.basis, /already_applied true/);
  assert.match(pin.staging_acceptance.basis, /no staging apply was needed or run/);
  assert.ok(pin.staging_acceptance.basis.includes(`live_definition_sha256 ${pin.intended_replacement_sha256} == intended`));
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // The staging pin stays pending: no staging apply (its expected live hash would equal the intended one).
  assert.equal(staging.execute, false);
  assert.equal(staging.expected_live_definition_sha256, null);
  assert.equal(pin.filename, SQL159_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL159_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, []);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'GRANT_HOMEOWNER_INTRO_REQUESTS_SELECT');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql159-homeowner-intro-requests-select-grant-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-159-apply.md');
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
  assert.equal(tool.allowed_key, 'sql159_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql159-homeowner-intro-requests-select-grant-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql159-production-apply"\]/);
  assert.match(rows, /sql156, sql158, sql159, sql160, sql161, sql162, sql163, sql164, sql165\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql159-executor.test.mjs', 'aws/tests/release-sql159-production-apply.test.mjs', 'aws/tests/sql159-homeowner-intro-requests-select-grant-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; one table grant (checksops SELECT) and nothing else; no function, policy, RLS, trigger or write grant; no overlay plan entry; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.production_only, undefined);
  assert.equal(spec.production_noop, undefined);
  assert.deepEqual(spec.prerequisites, [TABLE, 'role checksops']);
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.table_privileges, [{ table: TABLE, grantees: ['checksops'], privileges: ['SELECT'], intended: ['checksops SELECT'] }]);
  assert.deepEqual(spec.altered_relations, [TABLE]);
  for (const absent of ['tables', 'views', 'policies', 'column_acl', 'dropped_functions', 'acl_functions', 'indexes', 'added_columns', 'constraints', 'triggers', 'definer_writes']) assert.equal(spec[absent], undefined, absent);
  assert.match(COMMITTED.order_note, /^No predecessor\. SQL 159 grants checksops table SELECT on public\.homeowner_intro_requests and nothing else/);
  for (const text of ['"A now"', 'permission denied for table homeowner_intro_requests', 'other_table_privileges_unchanged', 'server_side_api',
    'No API, Lambda or SPA change is part of this pin', NO_GRANT, releaseStateHash(KEY, {})]) {
    assert.ok(COMMITTED.order_note.includes(text), text);
  }
  // The intended fingerprint is checksops's SELECT line and differs from both stops.
  assert.notEqual(COMMITTED.intended_replacement_sha256, NO_GRANT);
  assert.notEqual(COMMITTED.intended_replacement_sha256, releaseStateHash(KEY, {}));
  // No API member waits on SQL 159.
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.equal(plan.sql_prerequisites?.[SQL159_FILE], undefined);
  // The file: one prerequisite DO block and one GRANT; nothing else.
  const text = fs.readFileSync(path.join(ROOT, SQL159_FILE), 'utf8').replace(/--[^\n]*/g, '');
  const outside = text.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$');
  assert.equal(outside.replace(/\s+/g, ' ').trim(), `DO $body$; GRANT SELECT ON TABLE ${TABLE} TO checksops;`);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  for (const value of [COMMITTED.intended_replacement_sha256, COMMITTED.source_sha256, NO_GRANT, releaseStateHash(KEY, {}), 'GRANT_HOMEOWNER_INTRO_REQUESTS_SELECT']) {
    assert.ok(runbook.includes(value), value);
  }
  assert.match(runbook, /\*\*Status:\*\* staging already in the intended state \(read-live run 43232074130, 2026-11-12; no staging apply, the staging pin stays pending\); applied to production \(2026-11-12\); the production pin is retired \(`execute: false`\)\./);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql159` \|/);
  assert.match(oneShot, /`sql156`, `sql158`, `sql159`, `sql160`, `sql161`, `sql162`, `sql163`, `sql164`, `sql165`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql159-homeowner-intro-requests-select-grant-production-apply\.mjs --inspect/);
});

test('the pending (pre-authorization) pin refuses before connecting; the committed pin allows only its own manifest; execute false, other hashes and phrases refuse', async () => {
  // The pin before its owner-approved change: no pre-state, no owner approval, no staging acceptance.
  const PENDING = Object.freeze({ ...COMMITTED, authorization: 'pending', execute: false, expected_live_definition_sha256: null, staging_acceptance: { ok: false, reference: null, basis: 'Pending' } });
  const noPre = await evaluateReleaseProductionApply(KEY, manifest({ ...PENDING, expected_live_definition_sha256: PRE }), { root: ROOT, pin: PENDING });
  assert.equal(noPre.code, CODES.SQL_COLLISION);
  const withPre = { ...PENDING, expected_live_definition_sha256: PRE };
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(withPre), { root: ROOT, pin: withPre })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(withPre), { root: ROOT, pin: withPre, connect: neverConnect, consumedPath: consumedPath() })).ok, false);
  // execute true alone does not authorize it.
  const flipped = { ...withPre, execute: true };
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(flipped), { root: ROOT, pin: flipped })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);

  // An execute-authorized copy of the committed (retired) pin allows only the manifest bound to its recorded pre-state; the
  // retired pin refuses before connecting.
  const AUTHORIZED = Object.freeze({ ...COMMITTED, execute: true, authorization: 'Owner approved 2026-11-12 (test copy of the execute-authorized pin before its record-and-retire change)' });
  assert.equal((await executeReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, false);
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(AUTHORIZED), { root: ROOT, pin: AUTHORIZED });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql159_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: AUTHORIZED })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql159_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // SQL 156's phrase does not authorize SQL 159.
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'SHARE_CHECK_LIBRARY_WITH_MORTGAGE_DESK' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql159-cli-${process.pid}.json`);
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
  assert.match(out, /GUARD_APPLY_FORBIDDEN|SQL_COLLISION|PRODUCTION_APPROVAL_REQUIRED|DEPLOYMENT_GUARD_REQUIRED/);
  assert.match(out, /credential flags are refused/);
});
