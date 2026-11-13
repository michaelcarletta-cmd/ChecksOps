/**
 * Production tool for SQL 163 (scripts/deployment-guard/sql163-mortgage-desk-check-timeline-homeowner-link-production-apply.mjs
 * on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs). Owner 2026-11-12: the Mortgage Desk
 * agent sees the request's check and the homeowner timeline, and sends the homeowner link; 2026-11-13 "Start the desk
 * fixes". release-sql90-97-production-apply.test.mjs runs every release key (SQL 163 included) through the shared
 * refusals; this file covers SQL 163's own:
 *
 *   - the pin has the release pin shape, is execute-authorized from the recorded production inspect (owner 2026-11-13:
 *     "Open the SQL 163 production pin PR") with the staging acceptance, and is in step with the
 *     staging pin, the one-shot, the bypass inventory and the test lists;
 *   - no predecessor; three new SECURITY DEFINER functions (EXECUTE checksops and the owner), nothing replaced; no
 *     table, policy, trigger or table grant; the API change holds one overlay member on it (recorded live from this pin's
 *     production apply); the runbook, one-shot doc and README name it;
 *   - the pending pin refuses before connecting; an approved, accepted copy evaluates for the manifest built from it,
 *     and refuses with execute false, another live hash, another staging reference or a wrong phrase; the CLI spends no
 *     receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql163-mortgage-desk-check-timeline-homeowner-link-pg.test.mjs; the
 * executor path is aws/tests/release-sql163-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql163-mortgage-desk-check-timeline-homeowner-link-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql163';
const SQL163_FILE = 'aws/workflows/sql/163_mortgage_desk_check_timeline_homeowner_link.sql';
const ACLS = Object.freeze({
  'public.aws_mortgage_desk_request_check(uuid)': ['checksops EXECUTE', 'owner EXECUTE'],
  'public.aws_mortgage_desk_homeowner_timeline(uuid)': ['checksops EXECUTE', 'owner EXECUTE'],
  'public.aws_mortgage_desk_homeowner_link(uuid, text)': ['checksops EXECUTE', 'owner EXECUTE'],
});
const IDENTITIES = Object.freeze(Object.keys(ACLS));
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql163-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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

test('pin: the release pin shape, applied and retired (owner approved 2026-11-13 from the recorded inspect; applied 2026-11-13), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)(\.|$)/.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Owner-approved pin change of 2026-11-13 (#1859), then applied 2026-11-13 and retired (the apply run had the owner's own words, passed verbatim).
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-11-13; execute is false again/);
  assert.ok(pin.authorization.includes('#1859'));
  assert.ok(pin.authorization.includes('"apply SQL 163 in production"'));
  assert.equal(pin.expected_live_definition_sha256, releaseStateHash(KEY, {}));
  assert.equal(pin.expected_live_definition_sha256, '23d41c1086f3f15412a5d374e056eaaf1bef7f428d81b0ffbdda666a5250de87');
  const applied = pin.applied;
  assert.deepEqual([applied.date, applied.result, applied.apply_ssm_command_id, applied.one_shot_run_id, applied.one_use_id, applied.one_use_id_consumed, applied.owner_approval],
    ['2026-11-13', 'applied', '7ac690d7-02c5-4d2b-8615-4fb60ae9fea8', 'ff02a75e-8eb6-4dbb-8135-eca122148c01', 'sql163-prod-3abeb1bd-42b2-4f37-827e-c692bf050c59', true, 'apply SQL 163 in production']);
  assert.equal(applied.migration_source_sha256, pin.source_sha256);
  // The apply run's output was cut by the operator's SSM script (the last 18000 of 24660 bytes): its steps and manifest hash
  // were not captured, so this record does not claim them; the applied object arrived whole.
  assert.equal(applied.steps, undefined);
  assert.equal(applied.manifest_sha256, undefined);
  for (const text of ['transfer run 43422337998', 'e4849ce4-9272-4ad4-b47c-7c6c40b463e3', "The apply run's JSON did NOT arrive whole", 'Production acceptance: not yet reported by the owner']) assert.ok(applied.one_shot_note.includes(text), text);
  assert.deepEqual(Object.values(applied.contract_results).map((c) => c.evidence.split(' ')[0]), ['4/4', '6/6', '43/43']);
  assert.equal(applied.receipt.before_hash, pin.expected_live_definition_sha256);
  assert.equal(applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(applied.post_apply_inspect.already_applied, true);
  assert.deepEqual(applied.post_apply_inspect.release_sql_inspect.functions.map((f) => f.state), ['intended', 'intended', 'intended']);
  assert.deepEqual(applied.receipt.release_sql_inspect, applied.post_apply_inspect.release_sql_inspect);
  for (const text of ['7ac690d7-02c5-4d2b-8615-4fb60ae9fea8', 'ff02a75e-8eb6-4dbb-8135-eca122148c01', 'e4849ce4-9272-4ad4-b47c-7c6c40b463e3']) assert.ok(pin.production_evidence['2026-11-13 apply'].includes(text), text);
  const inspect = pin.production_inspect;
  assert.deepEqual([inspect.status, inspect.date, inspect.ssm_command_id, inspect.source_commit, inspect.read_only, inspect.connected_as],
    ['recorded', '2026-11-13', '51819aad-a6bf-487f-99e4-5de65b6db29c', '8d6488e0fef93d3ff3697a6423603d546e7faa08', true, 'checksops_admin']);
  assert.equal(inspect.live_definition_sha256, pin.expected_live_definition_sha256);
  assert.deepEqual(inspect.precondition_failures, []);
  assert.equal(inspect.apply_preconditions_met, false);
  for (const text of ['04e4ba7fef49890a355e396b32d605efe4d94645c60a7a9fb4790b3a4931cb5f', 'transfer run 43416792640', '== source_sha256', 'already_applied false', 'precondition_failures []',
    'If already_applied is true, or precondition_failures is not [], stop.', ' Earlier: Pending: no release-engine production inspect has been run for SQL 163 yet.']) {
    assert.ok(inspect.note.includes(text), text);
  }
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43361518188']);
  for (const text of ['43361164060', '43361792245', pin.expected_live_definition_sha256, pin.intended_replacement_sha256]) {
    assert.ok(pin.staging_acceptance.basis.includes(text), text);
  }
  assert.equal(pin.filename, SQL163_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL163_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, [...IDENTITIES]);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'SHOW_MORTGAGE_DESK_AGENTS_CHECK_TIMELINE_AND_HOMEOWNER_LINK');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql163-mortgage-desk-check-timeline-homeowner-link-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-163-apply.md');
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
  assert.equal(tool.allowed_key, 'sql163_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql163-mortgage-desk-check-timeline-homeowner-link-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql163-production-apply"\]/);
  assert.match(rows, /sql161, sql162, sql163\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql163-executor.test.mjs', 'aws/tests/release-sql163-production-apply.test.mjs', 'aws/tests/sql163-mortgage-desk-check-timeline-homeowner-link-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; three new SECURITY DEFINER functions with their ACLs, nothing replaced; no table, policy, trigger or table grant; the API change holds one overlay member on it; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.production_only, undefined);
  assert.equal(spec.production_noop, undefined);
  assert.deepEqual(spec.functions.map((fn) => [fn.identity, fn.acl]), Object.entries(ACLS));
  for (const name of ['public.mortgage_handling_requests', 'public.check_intake_items', 'public.homeowner_ledger_events', 'public.homeowner_ledger_tokens', 'column public.homeowner_ledger_events.payload_json', 'column public.mortgage_handling_requests.homeowner_email', 'public.aws_mortgage_desk_readable_request(uuid)', 'role checksops']) {
    assert.ok(spec.prerequisites.includes(name), name);
  }
  assert.deepEqual(spec.definer_writes, ['public.check_intake_items', 'public.claims', 'public.homeowner_ledger_events', 'public.homeowner_ledger_tokens', 'public.mortgage_handling_requests']);
  for (const absent of ['tables', 'views', 'policies', 'table_privileges', 'column_acl', 'dropped_functions', 'acl_functions', 'indexes', 'added_columns', 'constraints', 'triggers', 'altered_relations']) assert.equal(spec[absent], undefined, absent);
  // No other release migration defines or touches these functions.
  for (const key of Object.keys(RELEASE_SQL_SPECS).filter((k) => k !== KEY)) {
    for (const fn of IDENTITIES) assert.ok(!JSON.stringify(RELEASE_SQL_SPECS[key]).includes(fn.replace(/\(.*$/, '(')), `${key} ${fn}`);
  }
  assert.match(COMMITTED.order_note, /^No predecessor\. SQL 163 adds three SECURITY DEFINER functions and replaces nothing/);
  for (const text of ['"Start the desk fixes"', 'definer_can_write_relations', 'db-readonly-validate trigger count is not affected',
    'no API, Lambda or SPA change is part of this pin', releaseStateHash(KEY, {})]) {
    assert.ok(COMMITTED.order_note.includes(text), text);
  }
  // The pin itself changed no API member. The API change (2026-11-13, "Start the desk API and website PRs", its own planning
  // change) holds mortgage-desk-esign.mjs on SQL 163, which the plan records verified live from this pin's production apply
  // (one-shot SSM 7ac690d7, receipt before 23d41c10…, after ef536373…).
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.equal(plan.sql_prerequisites[SQL163_FILE].verified_live, true);
  for (const evidence of ['SSM 7ac690d7-02c5-4d2b-8615-4fb60ae9fea8', 'one_use_id sql163-prod-3abeb1bd-42b2-4f37-827e-c692bf050c59',
    `before ${COMMITTED.expected_live_definition_sha256.slice(0, 8)}…, after ${COMMITTED.intended_replacement_sha256.slice(0, 8)}…`]) {
    assert.ok(plan.sql_prerequisites[SQL163_FILE].evidence.includes(evidence), evidence);
  }
  assert.deepEqual(Object.keys(plan.members).filter((m) => plan.members[m].sql_before === SQL163_FILE), ['mortgage-desk-esign.mjs']);
  // The file: the prerequisite DO block, three functions, their REVOKEs from PUBLIC, the role REVOKE DO block and the GRANTs to checksops; nothing else.
  const text = fs.readFileSync(path.join(ROOT, SQL163_FILE), 'utf8').replace(/--[^\n]*/g, '');
  const outside = text.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$');
  assert.deepEqual([...outside.matchAll(/^\s*GRANT\b.*$/gim)].map((m) => m[0].trim()), IDENTITIES.map((identity) => `GRANT EXECUTE ON FUNCTION ${identity} TO checksops;`));
  assert.deepEqual([...outside.matchAll(/^\s*REVOKE\b.*$/gim)].map((m) => m[0].trim()), IDENTITIES.map((identity) => `REVOKE ALL ON FUNCTION ${identity} FROM PUBLIC;`));
  assert.deepEqual([...outside.matchAll(/^\s*CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(\S+?)\(/gim)].map((m) => m[1]), IDENTITIES.map((identity) => identity.replace(/\(.*$/, '')));
  assert.doesNotMatch(outside, /\bCREATE\s+(TABLE|POLICY|VIEW|INDEX|TRIGGER)\b|\bALTER\s+TABLE\b|\bDROP\b/i);
  assert.doesNotMatch(outside, /\b(TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+public\.)/i);
  assert.equal([...outside.matchAll(/\bDO\s+\$/g)].length, 2);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  for (const value of [COMMITTED.intended_replacement_sha256, COMMITTED.source_sha256, releaseStateHash(KEY, {}), 'SHOW_MORTGAGE_DESK_AGENTS_CHECK_TIMELINE_AND_HOMEOWNER_LINK']) {
    assert.ok(runbook.includes(value), value);
  }
  assert.match(runbook, /\*\*Status:\*\* applied to staging \(wave 54\) and to production \(2026-11-13\); the production pin is retired/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql163` \|/);
  assert.match(oneShot, /`sql161`, `sql162`, `sql163`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql163-mortgage-desk-check-timeline-homeowner-link-production-apply\.mjs --inspect/);
});

test('a pending copy refuses before connecting; the committed pin allows only its own manifest; execute false, other hashes and phrases refuse', async () => {
  // An execute-authorized copy of the committed (retired) pin evaluates for its own manifest; the retired pin refuses before connecting.
  const AUTHORIZED = Object.freeze({ ...COMMITTED, execute: true, authorization: 'Owner approved 2026-11-13 (test copy of the execute-authorized pin before its record-and-retire change)' });
  const own = await evaluateReleaseProductionApply(KEY, manifest(AUTHORIZED), { root: ROOT, pin: AUTHORIZED });
  assert.equal((await executeReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, false);
  assert.equal(own.ok, true, JSON.stringify(own));
  assert.equal(own.details.sql163_production_apply_allowed, true);
  const PENDING_COPY = { ...COMMITTED, authorization: 'pending', execute: false, expected_live_definition_sha256: null, staging_acceptance: { ok: false, reference: null, basis: 'test' } };
  const noPre = await evaluateReleaseProductionApply(KEY, manifest({ ...PENDING_COPY, expected_live_definition_sha256: PRE }), { root: ROOT, pin: PENDING_COPY });
  assert.equal(noPre.code, CODES.SQL_COLLISION);
  const withPre = { ...PENDING_COPY, expected_live_definition_sha256: PRE };
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(withPre), { root: ROOT, pin: withPre })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(withPre), { root: ROOT, pin: withPre, connect: neverConnect, consumedPath: consumedPath() })).ok, false);
  // execute true alone does not authorize it.
  const flipped = { ...withPre, execute: true };
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(flipped), { root: ROOT, pin: flipped })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql163_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // SQL 162's phrase does not authorize SQL 163.
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'SHOW_PARTNERS_SHARED_CHECK_SOURCE_SENDS' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with a manifest for another pre-state refuses against the committed pin without connecting or spending a
  // receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql163-cli-${process.pid}.json`);
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
