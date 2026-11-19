/**
 * Production tool for SQL 169 (scripts/deployment-guard/sql169-check-billing-events-keep-charge-on-check-delete-production-apply.mjs
 * on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs). Owner 2026-11-16, on deleting a check
 * that has a ChecksOps charge: "Delete, keep charge (Recommended)".
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 169 included) through the shared refusals;
 * this file covers SQL 169's own:
 *
 *   - the pin has the release pin shape; it was execute-authorized (owner-approved pin change of 2026-11-16, #1949), is
 *     applied (2026-11-16, "apply SQL 169 in production KEEP_CHARGES_WHEN_CHECK_IS_DELETED") and retired (execute false, the
 *     apply run recorded in applied), with the
 *     recorded production pre-state (read-only inspect SSM 29ddf3f2; the derived CASCADE state) and the staging apply from
 *     the same pre-state (run 43923431127) as its acceptance; it is in step with the staging pin, the one-shot, the bypass
 *     inventory and the test lists;
 *   - no predecessor; one constraint replaced (check_billing_events_check_intake_item_id_fkey, ON DELETE SET NULL), no
 *     function, trigger, table, policy or grant; no overlay plan entry yet; the runbook, one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; the committed pin allows only the manifest bound
 *     to its recorded pre-state; an approved, accepted copy evaluates for the manifest built from it,
 *     and refuses with execute false, another live hash, another staging reference or a wrong phrase; the CLI spends no
 *     receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql169-check-billing-events-keep-charge-on-check-delete-pg.test.mjs; the
 * executor path is aws/tests/release-sql169-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql169-check-billing-events-keep-charge-on-check-delete-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql169';
const SQL169_FILE = 'aws/workflows/sql/169_check_billing_events_keep_charge_on_check_delete.sql';
const TABLE = 'public.check_billing_events';
const CONSTRAINT = 'check_billing_events_check_intake_item_id_fkey';
const CASCADE_DEF = 'FOREIGN KEY (check_intake_item_id) REFERENCES public.check_intake_items(id) ON DELETE CASCADE';
const SET_NULL_DEF = 'FOREIGN KEY (check_intake_item_id) REFERENCES public.check_intake_items(id) ON DELETE SET NULL';
/** The expected pre-state: the Supabase CASCADE key, validated. */
const CASCADE_PRE = releaseStateHash(KEY, { constraints: { [`${TABLE} ${CONSTRAINT}`]: { exists: true, def: CASCADE_DEF, validated: true } } });
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// SQL 169's recorded production pre-state (read-only inspect of 2026-11-16, SSM 29ddf3f2, main 96981921a): the ON DELETE
// CASCADE key, the derived pre-state.
const PRODUCTION_PRE = 'f7530ea5e4b9ff3d8dc74911ffeadfe9b38dd6fd867ca3edacbc9ec65c8c4a40';
// The guarded staging apply from the same pre-state.
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43923431127';
// The owner's words for SQL 169, quoted in the authorization.
const OWNER_WORDS = Object.freeze(['"build SQL 169"', '"merge the SQL 169 PR"', '"apply SQL 169 in staging"', '"merge the SQL 169 staging pin PR"', '"run the SQL 169 production inspect"', '"open the SQL 169 production pin PR"']);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql169-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-11-16T00:00:00.000Z',
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

test('pin: the release pin shape, applied and retired (owner approved 2026-11-16 on the staging apply; applied 2026-11-16), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)(\.|$)/.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Owner-approved pin change of 2026-11-16: the read-only production inspect (SSM 29ddf3f2, main 96981921a) recorded as
  // the pre-state; the staging apply (run 43923431127, from the same pre-state) as the acceptance.
  // Then applied 2026-11-16 under the owner's own words for that run, and retired.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-11-16; execute is false again/);
  for (const words of [...OWNER_WORDS, '"merge the SQL 169 production pin PR"', '"apply SQL 169 in production KEEP_CHARGES_WHEN_CHECK_IS_DELETED"']) assert.ok(pin.authorization.includes(words), words);
  assert.ok(pin.authorization.includes('#1949'));
  const applied = pin.applied;
  assert.deepEqual([applied.date, applied.result, applied.apply_ssm_command_id, applied.inspect_ssm_command_id, applied.one_shot_run_id, applied.one_use_id, applied.one_use_id_consumed, applied.owner_approval],
    ['2026-11-16', 'applied', '9c92cb54-fc92-47b0-9fa1-cb7764b2f992', '40b64605-6154-413e-abbd-78cdc6643f51', 'd64ba504-e0e3-42ea-92d4-57ae4af26008', 'sql169-prod-91223610-db3b-4249-b7b3-59502f378d5d', true, 'apply SQL 169 in production KEEP_CHARGES_WHEN_CHECK_IS_DELETED']);
  assert.equal(applied.workstream_id, 'prod-sql169-keep-charge-on-delete-20261116');
  assert.equal(applied.source_commit, '6641007ab2bd1e042bda54084fcdcfc1bd9e253c');
  assert.equal(applied.source_tarball.sha256, '20b86c779cb709b2a6c7b09a2cd17c0ebbd00897b0c55c5330f57e29530107bd');
  assert.equal(applied.migration_source_sha256, pin.source_sha256);
  assert.equal(applied.manifest_sha256, '863032d4b70179f58bcb308ef01a09cc48b0453bfcc818885edd8f086c96f34d');
  assert.deepEqual(applied.steps, ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
  assert.deepEqual(Object.values(applied.contract_results).map((c) => c.evidence.split(' ')[0]), ['4/4', '6/6', '43/43']);
  assert.equal(applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.deepEqual(applied.pre_apply_inspect.precondition_failures, []);
  assert.equal(applied.receipt.before_hash, pin.expected_live_definition_sha256);
  assert.equal(applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(applied.post_apply_inspect.already_applied, true);
  assert.equal(applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(applied.post_apply_inspect.precondition_failures, []);
  const after = applied.post_apply_inspect.release_sql_inspect;
  assert.deepEqual(after.constraints, [{ name: `check_billing_events ${CONSTRAINT}`, state: 'intended' }]);
  assert.deepEqual(after.functions, []);
  assert.deepEqual(applied.receipt.release_sql_inspect, after);
  // The run's whole output arrived: nothing is marked not captured.
  assert.equal(applied.not_captured, undefined);
  for (const text of ['transfer run 43930251982', '40b64605-6154-413e-abbd-78cdc6643f51', '9705f1c56c96e5b973ac1d81e203b62efc3abca5fa1399d3bcc35ed537ff581a', 'AWS-managed SSM commands', 'Production acceptance: not yet reported by the owner']) assert.ok(applied.one_shot_note.includes(text), text);
  for (const text of ['9c92cb54-fc92-47b0-9fa1-cb7764b2f992', 'd64ba504-e0e3-42ea-92d4-57ae4af26008', '40b64605-6154-413e-abbd-78cdc6643f51']) assert.ok(pin.production_evidence['2026-11-16 apply'].includes(text), text);
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, CASCADE_PRE);
  assert.equal(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-11-16');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, '29ddf3f2-9ca8-467d-8877-a84e95294f14');
  assert.equal(pin.production_inspect.source_commit, '96981921a14678e8c7dfe5ec56c29e09f8972e55');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  for (const text of ['d6a952e92abb572f1de5af8cb34926b0a282ade76d16b05e634e36e995340ac5', '90d36f6e036643aeb2f71b1c2f39a7290ca94d8022f432dd35a998bef0368352',
    'run 43924507724', 'prerequisites_missing [], predecessors {} (none), successors_applied [], precondition_failures []', 'already_applied false',
    'ok true, read_only true, source_ok true, current_user, session_user and admin_login checksops_admin, pin_execute false, predecessors_applied true',
    'sql169_column_not_nullable', 'the column NOT NULL', CASCADE_PRE]) {
    assert.ok(pin.production_inspect.note.includes(text), text);
  }
  assert.match(pin.production_inspect.note, /If already_applied is true, prerequisites_missing is not \[\] or precondition_failures is not \[\], stop/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no release-engine production inspect has been run for SQL 169 yet'));
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql169-check-billing-events-keep-charge-on-check-delete, run 43923431127/);
  assert.match(pin.staging_acceptance.basis, /wave 61/);
  assert.match(pin.staging_acceptance.basis, /deploy run 43922432721/);
  assert.match(pin.staging_acceptance.basis, /read-live run 43919046029/);
  assert.ok(pin.staging_acceptance.basis.includes(`receipt before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.match(pin.staging_acceptance.basis, /Read-live run 43923909951 then reported already_applied true/);
  assert.match(pin.staging_acceptance.basis, /Production's pre-state \(production_inspect\) equals staging's/);
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  assert.equal(pin.filename, SQL169_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL169_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, []);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'KEEP_CHARGES_WHEN_CHECK_IS_DELETED');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql169-check-billing-events-keep-charge-on-check-delete-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-169-apply.md');
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
  assert.equal(tool.allowed_key, 'sql169_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql169-check-billing-events-keep-charge-on-check-delete-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql169-production-apply"\]/);
  assert.match(rows, /sql166, sql167, sql168, sql169, sql170, sql171\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql169-executor.test.mjs', 'aws/tests/release-sql169-production-apply.test.mjs', 'aws/tests/sql169-check-billing-events-keep-charge-on-check-delete-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; one foreign key replaced, nothing else; the overlay plan holds workflow.mjs on it, recorded live; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.production_only, undefined);
  assert.equal(spec.production_noop, undefined);
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.constraints, [{ table: TABLE, name: CONSTRAINT, def: SET_NULL_DEF }]);
  assert.deepEqual(spec.altered_relations, [TABLE]);
  for (const absent of ['tables', 'views', 'policies', 'table_privileges', 'column_acl', 'dropped_functions', 'acl_functions', 'indexes', 'added_columns', 'altered_columns', 'triggers', 'dropped_triggers', 'definer_writes']) {
    assert.equal(spec[absent], undefined, absent);
  }
  // No other release migration fingerprints the key.
  for (const key of Object.keys(RELEASE_SQL_SPECS).filter((k) => k !== KEY)) {
    assert.ok(!JSON.stringify(RELEASE_SQL_SPECS[key]).includes(CONSTRAINT), key);
  }
  assert.match(COMMITTED.order_note, /^No predecessor\. SQL 169 replaces one foreign key and creates nothing/);
  for (const text of ['"Delete, keep charge (Recommended)"', 'altered_relations_owned_by_login', 'sql169_column_not_nullable',
    'sql169_unexpected_foreign_key', 'sql169_foreign_key_already_current', 'LEFT JOIN check_intake_items',
    'No API, Lambda or SPA change is part of this pin', CASCADE_PRE]) {
    assert.ok(COMMITTED.order_note.includes(text), text);
  }
  // The API change that lets a charged check be deleted (the Delete Check keep-charges plan, 2026-11-16) is the one member held
  // on it; production records it verified live from this pin's applied record (#1950), staging from its apply run.
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.deepEqual(Object.keys(plan.members).filter((m) => plan.members[m].sql_before === SQL169_FILE), ['workflow.mjs']);
  const pre = plan.sql_prerequisites[SQL169_FILE];
  assert.equal(pre.verified_live, true);
  assert.ok(pre.evidence.includes(`SSM ${COMMITTED.applied.apply_ssm_command_id}`));
  assert.ok(pre.evidence.includes(COMMITTED.applied.one_use_id));
  assert.ok(pre.evidence.includes('#1950'));
  assert.equal(readJson('ops/deployment-guard/staging-sql-live.json').sql[SQL169_FILE].verified_live, true);
  // The file: one DO block; no GRANT, REVOKE, function, trigger, table, policy, index or row change outside it.
  const text = fs.readFileSync(path.join(ROOT, SQL169_FILE), 'utf8').replace(/--[^\n]*/g, '');
  const outside = text.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$');
  assert.equal([...outside.matchAll(/\bDO\s+\$/g)].length, 1);
  assert.doesNotMatch(outside, /\bGRANT\b|\bREVOKE\b|\bCREATE\b|\bALTER\b|\bDROP\b/i);
  assert.doesNotMatch(text, /\b(TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+public\.)/i);
  // Inside it, only this key is dropped and added.
  assert.deepEqual([...text.matchAll(/\bALTER\s+TABLE\s+(\S+)\s+(DROP|ADD)\s+CONSTRAINT\s+(\w+)/gi)].map((m) => `${m[1]} ${m[2]} ${m[3]}`),
    [`${TABLE} DROP ${CONSTRAINT}`, `${TABLE} ADD ${CONSTRAINT}`]);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  for (const value of [COMMITTED.intended_replacement_sha256, COMMITTED.source_sha256, CASCADE_PRE, 'KEEP_CHARGES_WHEN_CHECK_IS_DELETED']) {
    assert.ok(runbook.includes(value), value);
  }
  assert.match(runbook, /\*\*Status:\*\* applied in staging \(wave 61, 2026-11-16, apply run 43923431127\); staging acceptance: the staging apply under the owner's run approval \(\"apply SQL 169 in staging\"; no separate acceptance statement\); applied to production \(2026-11-16\); the production pin is retired \(`execute: false`\)\./);
  assert.match(runbook, /\*\*Production apply \(2026-11-16\)\.\*\* /);
  assert.match(runbook, /\*\*Production inspect \(2026-11-16\)\.\*\* Read-only `--inspect` through SSM `29ddf3f2-9ca8-467d-8877-a84e95294f14`/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql169` \|/);
  assert.match(oneShot, /`sql167`, `sql168`, `sql169`, `sql170`, `sql171`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql169-check-billing-events-keep-charge-on-check-delete-production-apply\.mjs --inspect/);
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
  const AUTHORIZED = Object.freeze({ ...COMMITTED, execute: true, authorization: 'Owner approved 2026-11-16 (test copy of the execute-authorized pin before its record-and-retire change)' });
  assert.equal((await executeReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, false);
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(AUTHORIZED), { root: ROOT, pin: AUTHORIZED });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql169_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: AUTHORIZED })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql169_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // SQL 168's phrase does not authorize SQL 169.
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'ROUTE_NEW_CHECK_TO_SAME_MORTGAGE_AGENT' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql169-cli-${process.pid}.json`);
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
