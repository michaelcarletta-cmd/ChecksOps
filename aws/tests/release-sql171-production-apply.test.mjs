/**
 * Production tool for SQL 171 (scripts/deployment-guard/sql171-device-push-tokens-production-apply.mjs on
 * lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs). Owner 2026-11-19: app notifications when
 * signatures are received, funds are disbursed or received, the wallet changes, or a message arrives (the app side is PR
 * 2016); this file is where the API keeps the phones' push tokens.
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 171 included) through the shared refusals;
 * this file covers SQL 171's own:
 *
 *   - the pin has the release pin shape; it was execute-authorized (owner-approved pin change of 2026-11-19, #2027), is
 *     applied (2026-11-19, "REGISTER_PHONES_FOR_PUSH_NOTIFICATIONS") and retired (execute false, the apply run recorded in
 *     applied, its whole output read back), with the
 *     recorded production pre-state (read-only inspect SSM ffa9f784; the derived absent state) and the staging apply from
 *     the same pre-state (run 44614240107) as its acceptance; it is in step with the staging pin, the one-shot, the bypass
 *     inventory and the test lists;
 *   - no predecessor; one new table (device_push_tokens: RLS on, no policy, no grant) and two new SECURITY DEFINER
 *     functions (EXECUTE checksops and the owner); no existing object changed; the overlay plan holds push-register-device.mjs
 *     on it, recorded live; the runbook,
 *     one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; the committed pin allows only the manifest bound
 *     to its recorded pre-state; an approved, accepted copy evaluates for the manifest built from it,
 *     and refuses with execute false, another live hash, another staging reference or a wrong phrase; the CLI spends no
 *     receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql171-device-push-tokens-pg.test.mjs; the executor path is
 * aws/tests/release-sql171-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql171-device-push-tokens-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql171';
const SQL171_FILE = 'aws/workflows/sql/171_device_push_tokens.sql';
const TABLE = 'public.device_push_tokens';
const FNS = Object.freeze(['public.aws_push_register_device(text, text)', 'public.aws_push_unregister_device(text)']);
const ACL = Object.freeze(['checksops EXECUTE', 'owner EXECUTE']);
/** The expected pre-state: the table and both functions absent. */
const ABSENT = releaseStateHash(KEY, {});
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// SQL 171's recorded production pre-state (read-only inspect of 2026-11-19, SSM ffa9f784, main dc9e02688): the table and both
// functions absent, the derived pre-state.
const PRODUCTION_PRE = 'fb6d8c05258dd4094a5b48c9ca3e703ce4cbc2884bcfa07e81f9c35968a8b555';
// The guarded staging apply from the same pre-state.
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/44614240107';
// The owner's words for SQL 171, quoted in the authorization.
const OWNER_WORDS = Object.freeze(['"run staging read-live"', '"deploy staging executor"', '"approve the SQL 171 staging apply"', '"deploy and apply SQL 171 on staging"', '"run the SQL 171 production inspect"', '"approve the SQL 171 production pin"']);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql171-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-11-19T00:00:00.000Z',
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

test('pin: the release pin shape, applied and retired (owner approved 2026-11-19 on the staging apply; applied 2026-11-19), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)(\.|$)/.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Owner-approved pin change of 2026-11-19: the read-only production inspect (SSM ffa9f784, main dc9e02688) recorded as
  // the pre-state; the staging apply (run 44614240107, from the same pre-state) as the acceptance.
  // Then applied 2026-11-19 under the owner's own words for that run, and retired.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-11-19; execute is false again/);
  for (const words of [...OWNER_WORDS, '"merge 2027"', '"REGISTER_PHONES_FOR_PUSH_NOTIFICATIONS"']) assert.ok(pin.authorization.includes(words), words);
  assert.ok(pin.authorization.includes('#2027'));
  const applied = pin.applied;
  assert.deepEqual([applied.date, applied.result, applied.apply_ssm_command_id, applied.inspect_ssm_command_id, applied.one_shot_run_id, applied.one_use_id, applied.one_use_id_consumed, applied.owner_approval],
    ['2026-11-19', 'applied', '64a77757-c18c-4b10-bdfe-b0555632e893', 'f36eab39-9c69-4fde-a561-dbede503359a', '6a62cd62-ede8-40bf-a096-3ba44bdd9fbe', 'sql171-prod-19a5dee9-0cde-4c6b-833d-b7754cecd65a', true, 'REGISTER_PHONES_FOR_PUSH_NOTIFICATIONS']);
  assert.equal(applied.workstream_id, 'prod-sql171-device-push-tokens-20261119');
  assert.equal(applied.source_commit, 'd3bd9476fe1ac857c3f9b5950098470a360a22d1');
  assert.equal(applied.source_tarball.sha256, 'ddadb58ac09ff51a5a44ec4ad14939acffa68fc72e059f723928902fa8aafb86');
  assert.match(applied.source_staged_by, /^sql53-temporary-transfer\.yml run 44625822986 /);
  assert.equal(applied.migration_source_sha256, pin.source_sha256);
  assert.equal(applied.manifest_sha256, 'f7a539deafc7ce2dc99a86d92f40cf0fa74b539aa05ccfcb1bb8a0f7bbcc6e1b');
  assert.deepEqual(applied.steps, ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
  assert.deepEqual(Object.keys(applied.contract_results), ['claim-ledger', 'tenant-isolation', 'financial-write-protections']);
  for (const c of Object.values(applied.contract_results)) assert.equal(c.ok, true);
  assert.equal(applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(applied.pre_apply_inspect.live_matches_expected, true);
  assert.deepEqual(applied.pre_apply_inspect.precondition_failures, []);
  assert.equal(applied.receipt.before_hash, pin.expected_live_definition_sha256);
  assert.equal(applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(applied.receipt.result, 'applied');
  assert.equal(applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(applied.post_apply_inspect.already_applied, true);
  assert.equal(applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(applied.post_apply_inspect.precondition_failures, []);
  const after = applied.post_apply_inspect.release_sql_inspect;
  assert.deepEqual(after.tables, [{ name: 'device_push_tokens', state: 'intended', rls: true, column_count: 6, policy_count: 0 }]);
  assert.ok(after.functions.length === 2 && after.functions.every((f) => f.state === 'intended'));
  assert.ok(after.function_acl.every((f) => JSON.stringify(f.acl) === JSON.stringify(['checksops EXECUTE', 'owner EXECUTE'])));
  assert.deepEqual(applied.receipt.release_sql_inspect, after);
  // The whole output was read back: nothing is marked not captured.
  assert.equal(applied.output_recovery_note, undefined);
  assert.equal(applied.not_captured, undefined);
  for (const text of ['arrived complete through SSM', '851d1025fcdaa82e8951e5d7e70a81b3b24b26d62fafc1acba4884d8f3301bb7', '0025de9fe1357fbc47826c95e15d1d4df19da42c7b0d07c964f7a9be65f7bf51',
    'transfer run 44625822986', 'f36eab39-9c69-4fde-a561-dbede503359a', 'd90008b85ffd1a3dfbe09853515190565978b161c59a2a899266a234c1206c21', '553c3ea2-025d-437a-a4ad-c6fd58d278d5',
    'left on the runner under /var/tmp', 'Production acceptance: not yet reported by the owner']) assert.ok(applied.one_shot_note.includes(text), text);
  for (const text of ['64a77757-c18c-4b10-bdfe-b0555632e893', '6a62cd62-ede8-40bf-a096-3ba44bdd9fbe', 'f36eab39-9c69-4fde-a561-dbede503359a']) assert.ok(pin.production_evidence['2026-11-19 apply'].includes(text), text);
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, ABSENT);
  assert.equal(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-11-19');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, 'ffa9f784-a7f8-49ff-b10e-895b1aae7f0b');
  assert.equal(pin.production_inspect.source_commit, 'dc9e02688b79f83314fd2148f41ba89659902d73');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  for (const text of ['04ab7add22f12f91829d24d51eb4503ad6961308c57a00193bb1c17869c5e2f6', 'f27fb009cfd918a74c4ed9cf15c044b8b83ca6d10d988f18b3f1664a83c870b1',
    'run 44615906274', 'prerequisites_missing [], predecessors {} (none), successors_applied [], precondition_failures []', 'already_applied false',
    'ok true, read_only true, source_ok true, current_user, session_user and admin_login checksops_admin, pin_execute false, predecessors_applied true',
    'the table device_push_tokens and both functions', 'the table or a function present', ABSENT]) {
    assert.ok(pin.production_inspect.note.includes(text), text);
  }
  assert.match(pin.production_inspect.note, /If already_applied is true, prerequisites_missing is not \[\] or precondition_failures is not \[\], stop/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no release-engine production inspect has been run for SQL 171 yet'));
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql171-device-push-tokens, run 44614240107/);
  assert.match(pin.staging_acceptance.basis, /wave 63/);
  assert.match(pin.staging_acceptance.basis, /deploy run 44613639425/);
  assert.match(pin.staging_acceptance.basis, /read-live run 44610159066/);
  assert.ok(pin.staging_acceptance.basis.includes(`expected live ${PRODUCTION_PRE}`));
  assert.ok(pin.staging_acceptance.basis.includes(`live ${pin.intended_replacement_sha256} == intended`));
  assert.match(pin.staging_acceptance.basis, /Read-live run 44614848373 then reported already_applied true/);
  assert.match(pin.staging_acceptance.basis, /Production's pre-state \(production_inspect\) equals staging's/);
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  assert.equal(pin.filename, SQL171_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL171_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, FNS);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'REGISTER_PHONES_FOR_PUSH_NOTIFICATIONS');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql171-device-push-tokens-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-171-apply.md');
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
  assert.equal(tool.allowed_key, 'sql171_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql171-device-push-tokens-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql171-production-apply"\]/);
  assert.match(rows, /sql168, sql169, sql170, sql171, sql172, sql173\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql171-executor.test.mjs', 'aws/tests/release-sql171-production-apply.test.mjs', 'aws/tests/sql171-device-push-tokens-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; one new table and two new DEFINER functions, nothing existing changed; the overlay plan holds push-register-device.mjs on it, recorded live; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.production_only, undefined);
  assert.equal(spec.production_noop, undefined);
  assert.deepEqual(spec.functions, FNS.map((identity) => ({ identity, acl: [...ACL] })));
  assert.deepEqual(spec.tables.map((t) => [t.name, t.rls, t.forced, t.acl]), [[TABLE, true, false, []]]);
  assert.deepEqual(spec.prerequisites, ['auth.uid()', 'gen_random_uuid()', 'role checksops']);
  for (const absent of ['views', 'policies', 'table_privileges', 'column_acl', 'dropped_functions', 'acl_functions', 'indexes', 'added_columns', 'altered_columns', 'constraints', 'triggers', 'dropped_triggers', 'definer_writes', 'altered_relations']) {
    assert.equal(spec[absent], undefined, absent);
  }
  // No other release migration names the table or the functions.
  for (const key of Object.keys(RELEASE_SQL_SPECS).filter((k) => k !== KEY)) {
    const other = JSON.stringify(RELEASE_SQL_SPECS[key]);
    for (const name of ['device_push_tokens', 'aws_push_register_device', 'aws_push_unregister_device']) assert.ok(!other.includes(name), `${key} ${name}`);
  }
  assert.match(COMMITTED.order_note, /^No predecessor\. SQL 171 creates one table and two functions and replaces nothing/);
  for (const text of ['PR 2016', 'sql171_prerequisite_missing', 'sql171_unexpected_table', 'created_tables_absent_or_intended',
    'created_tables_owned_by_login', 'at most 20 per user', 'No API, Lambda or SPA change is part of this pin', ABSENT]) {
    assert.ok(COMMITTED.order_note.includes(text), text);
  }
  // The API route that calls the functions (push-register-device, the app push registration plan of 2026-11-19, planning
  // only) is the one member held on it; production records it verified live from this pin's applied record (#2028), staging
  // from its apply run.
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.deepEqual(Object.keys(plan.members).filter((m) => plan.members[m].sql_before === SQL171_FILE), ['push-register-device.mjs']);
  const pre = plan.sql_prerequisites[SQL171_FILE];
  assert.equal(pre.verified_live, true);
  assert.ok(pre.evidence.includes(`SSM ${COMMITTED.applied.apply_ssm_command_id}`));
  assert.ok(pre.evidence.includes(COMMITTED.applied.one_use_id));
  assert.ok(pre.evidence.includes('#2028'));
  assert.equal(readJson('ops/deployment-guard/staging-sql-live.json').sql[SQL171_FILE].verified_live, true);
  // The file: two guarded DO blocks, the table, its index, RLS, the two functions with their ACLs and comments; no other
  // object, and no row written.
  const text = fs.readFileSync(path.join(ROOT, SQL171_FILE), 'utf8').replace(/--[^\n]*/g, '');
  const outside = text.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$');
  // String literals (the COMMENT texts) blanked.
  const bare = outside.replace(/'(?:[^']|'')*'/g, "''");
  assert.equal([...outside.matchAll(/\bDO\s+\$/g)].length, 2);
  assert.deepEqual([...outside.matchAll(/\bCREATE\s+(?:OR\s+REPLACE\s+)?(TABLE|INDEX|FUNCTION)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+?)(?:\(|\s)/gi)].map((m) => `${m[1].toUpperCase()} ${m[2]}`),
    ['TABLE public.device_push_tokens', 'INDEX device_push_tokens_user_idx', 'FUNCTION public.aws_push_register_device', 'FUNCTION public.aws_push_unregister_device']);
  assert.deepEqual([...outside.matchAll(/\bALTER\s+TABLE\s+(\S+)\s+([^;]+);/gi)].map((m) => `${m[1]} ${m[2].trim()}`), [`${TABLE} ENABLE ROW LEVEL SECURITY`]);
  assert.deepEqual([...bare.matchAll(/\b(GRANT|REVOKE)\s+[^;]+;/gi)].map((m) => m[0]), [
    'REVOKE ALL ON FUNCTION public.aws_push_register_device(text, text) FROM PUBLIC;',
    'GRANT EXECUTE ON FUNCTION public.aws_push_register_device(text, text) TO checksops;',
    'REVOKE ALL ON FUNCTION public.aws_push_unregister_device(text) FROM PUBLIC;',
    'GRANT EXECUTE ON FUNCTION public.aws_push_unregister_device(text) TO checksops;',
  ]);
  assert.doesNotMatch(bare, /\bDROP\b|\bPOLICY\b|\bTRIGGER\b|\bFORCE\b/i);
  assert.doesNotMatch(outside, /\b(TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+public\.)/i);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  for (const value of [COMMITTED.intended_replacement_sha256, COMMITTED.source_sha256, ABSENT, 'REGISTER_PHONES_FOR_PUSH_NOTIFICATIONS']) {
    assert.ok(runbook.includes(value), value);
  }
  assert.match(runbook, /\*\*Status:\*\* applied in staging \(wave 63, 2026-11-19, apply run 44614240107\); staging acceptance: the staging apply under the owner\'s run approval \(\"deploy and apply SQL 171 on staging\"; no separate acceptance statement\); applied to production \(2026-11-19\); the production pin is retired \(`execute: false`\)\./);
  assert.match(runbook, /\*\*Production apply \(2026-11-19\)\.\*\* /);
  assert.match(runbook, /\*\*Production inspect \(2026-11-19\)\.\*\* Read-only `--inspect` through SSM `ffa9f784-a7f8-49ff-b10e-895b1aae7f0b`/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql171` \|/);
  assert.match(oneShot, /`sql169`, `sql170`, `sql171`, `sql172`, `sql173`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql171-device-push-tokens-production-apply\.mjs --inspect/);
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
  const AUTHORIZED = Object.freeze({ ...COMMITTED, execute: true, authorization: 'Owner approved 2026-11-19 (test copy of the execute-authorized pin before its record-and-retire change)' });
  assert.equal((await executeReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, false);
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(AUTHORIZED), { root: ROOT, pin: AUTHORIZED });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql171_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: AUTHORIZED })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql171_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // SQL 170's phrase does not authorize SQL 171.
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'SHOW_ENDORSEMENT_EMAIL_STATUS' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql171-cli-${process.pid}.json`);
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
