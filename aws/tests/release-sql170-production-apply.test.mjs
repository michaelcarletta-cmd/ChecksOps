/**
 * Production tool for SQL 170 (scripts/deployment-guard/sql170-check-endorsement-email-status-production-apply.mjs on
 * lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs). Owner 2026-11-19: "Is there anyway for
 * tenants to see if an email has been delivered and opened? For this to show up near the payee signature request", then
 * "Yeah build 1 and 2".
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 170 included) through the shared refusals;
 * this file covers SQL 170's own:
 *
 *   - the pin has the release pin shape; it is execute-authorized (owner-approved pin change of 2026-11-19) with the
 *     recorded production pre-state (read-only inspect SSM 67613a6c; the derived absent state) and the staging apply from
 *     the same pre-state (run 44576208345) as its acceptance; it is in step with the staging pin, the one-shot, the bypass
 *     inventory and the test lists;
 *   - no predecessor; three new SECURITY DEFINER functions (EXECUTE checksops and the owner), eight columns on
 *     check_endorsements and one partial index; no table, policy, trigger, constraint or table grant; no overlay plan
 *     entry yet; the runbook, one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; the committed pin allows only the manifest bound
 *     to its recorded pre-state; an approved, accepted copy evaluates for the manifest built from it,
 *     and refuses with execute false, another live hash, another staging reference or a wrong phrase; the CLI spends no
 *     receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql170-check-endorsement-email-status-pg.test.mjs; the executor path is
 * aws/tests/release-sql170-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql170-check-endorsement-email-status-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql170';
const SQL170_FILE = 'aws/workflows/sql/170_check_endorsement_email_status.sql';
const TABLE = 'public.check_endorsements';
const INDEX = 'check_endorsements_email_message_id_idx';
const FUNCTIONS = Object.freeze([
  'public.aws_endorsement_email_event(text, text, timestamp with time zone, text)',
  'public.aws_endorsement_email_sent(uuid, text)',
  'public.aws_endorsement_link_opened(uuid)',
]);
const COLUMNS = Object.freeze(['email_message_id', 'email_delivered_at', 'email_bounced_at', 'email_bounce_reason',
  'email_complained_at', 'link_first_opened_at', 'link_last_opened_at', 'link_open_count']);
/** The expected pre-state: the functions, the columns and the index absent. */
const ABSENT_PRE = releaseStateHash(KEY, {});
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// SQL 170's recorded production pre-state (read-only inspect of 2026-11-19, SSM 67613a6c, main bc3d16a92): the columns,
// index and functions absent, the derived pre-state.
const PRODUCTION_PRE = '747d10df6bd187e566fff75f14e2c2be43f14e350e70a7fabb8457931a3a7dc4';
// The guarded staging apply from the same pre-state.
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/44576208345';
// The owner's words for SQL 170, quoted in the authorization.
const OWNER_WORDS = Object.freeze(['"Yeah build 1 and 2"', '"Merge 2019 once green"', '"run the staging SQL executor deploy, then the SQL 170 read-live"', '"approve the SQL 170 staging apply"', '"Merge 2021 when green"', '"run the SQL 170 staging apply"', '"run the SQL 170 production inspect"', '"open the SQL 170 production pin PR"']);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql170-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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

test('pin: the release pin shape, execute-authorized on the staging apply, in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Owner-approved pin change of 2026-11-19: the read-only production inspect (SSM 67613a6c, main bc3d16a92) recorded as
  // the pre-state; the staging apply (run 44576208345, from the same pre-state) as the acceptance.
  assert.equal(pin.execute, true);
  assert.match(pin.authorization, /^Owner approved 2026-11-19 /);
  for (const words of OWNER_WORDS) assert.ok(pin.authorization.includes(words), words);
  assert.match(pin.authorization, /none of them words for the production apply/);
  assert.ok(pin.authorization.includes(`${PRODUCTION_PRE} -> ${pin.intended_replacement_sha256}`));
  assert.match(pin.authorization, /execute true takes effect only when the owner reviews and merges this change\. It does not itself run or approve a run/);
  assert.match(pin.authorization, /each apply still needs the owner's run-time approval/);
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, ABSENT_PRE);
  assert.equal(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied, undefined);
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-11-19');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, '67613a6c-45ae-4d2e-b1ba-5adb161b80a1');
  assert.equal(pin.production_inspect.source_commit, 'bc3d16a928330b66a76c59e86792fd734e6e5f5e');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  for (const text of ['e48f8139dae4de7f79e898fad14d3c7049c76366d556cc53faa9491b4239acb1', 'f6844c88119c7e1a38ea22f324af5acce4377559c209262892a683328ad4ebe2',
    'run 44576498107', 'prerequisites_missing [], predecessors {} (none), successors_applied [], precondition_failures []', 'already_applied false',
    'ok true, read_only true, source_ok true, current_user, session_user and admin_login checksops_admin, pin_execute false, predecessors_applied true',
    'definer_writes check_endorsements ok', 'definer_can_write_relations', ABSENT_PRE]) {
    assert.ok(pin.production_inspect.note.includes(text), text);
  }
  assert.match(pin.production_inspect.note, /If already_applied is true, prerequisites_missing is not \[\] or precondition_failures is not \[\], stop/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no release-engine production inspect has been run for SQL 170 yet'));
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql170-check-endorsement-email-status, run 44576208345/);
  assert.match(pin.staging_acceptance.basis, /wave 62/);
  assert.match(pin.staging_acceptance.basis, /deploy run 44575220951/);
  assert.match(pin.staging_acceptance.basis, /read-live run 44569070362/);
  assert.ok(pin.staging_acceptance.basis.includes(`receipt before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.match(pin.staging_acceptance.basis, /Read-live run 44577378245 then reported already_applied true/);
  assert.match(pin.staging_acceptance.basis, /Production's pre-state \(production_inspect\) equals staging's/);
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  assert.equal(pin.filename, SQL170_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL170_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, FUNCTIONS);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'SHOW_ENDORSEMENT_EMAIL_STATUS');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql170-check-endorsement-email-status-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-170-apply.md');
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
  assert.equal(tool.allowed_key, 'sql170_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql170-check-endorsement-email-status-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql170-production-apply"\]/);
  assert.match(rows, /sql167, sql168, sql169, sql170\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql170-executor.test.mjs', 'aws/tests/release-sql170-production-apply.test.mjs', 'aws/tests/sql170-check-endorsement-email-status-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; three DEFINER functions, eight columns and one index on check_endorsements, nothing else; no overlay plan entry yet; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.production_only, undefined);
  assert.equal(spec.production_noop, undefined);
  assert.deepEqual(spec.functions.map((f) => [f.identity, f.acl]), FUNCTIONS.map((f) => [f, ['checksops EXECUTE', 'owner EXECUTE']]));
  assert.deepEqual(spec.added_columns.map((c) => [c.table, c.column, c.acl]), COLUMNS.map((c) => [TABLE, c, []]));
  assert.deepEqual(spec.indexes.map((i) => [i.table, i.name]), [[TABLE, INDEX]]);
  assert.deepEqual(spec.definer_writes, [TABLE]);
  assert.deepEqual(spec.altered_relations, [TABLE]);
  for (const absent of ['tables', 'views', 'policies', 'table_privileges', 'column_acl', 'dropped_functions', 'acl_functions', 'constraints', 'added_constraints', 'altered_columns', 'triggers', 'dropped_triggers']) {
    assert.equal(spec[absent], undefined, absent);
  }
  // No other release migration fingerprints these functions, columns or the index.
  for (const key of Object.keys(RELEASE_SQL_SPECS).filter((k) => k !== KEY)) {
    const other = JSON.stringify(RELEASE_SQL_SPECS[key]);
    for (const name of ['aws_endorsement_email_sent', 'aws_endorsement_email_event', 'aws_endorsement_link_opened', INDEX, 'link_open_count', 'email_message_id']) {
      assert.ok(!other.includes(name), `${key} ${name}`);
    }
  }
  assert.match(COMMITTED.order_note, /^No predecessor\. SQL 170 adds what a payee's endorsement request needs/);
  for (const text of ['"Yeah build 1 and 2"', 'no tracking pixel', 'sql170_prerequisite_missing', 'sql170_definer_cannot_write',
    'sql170_column_conflict', 'definer_can_write_relations', 'No API, Lambda or SPA change is part of this pin', ABSENT_PRE]) {
    assert.ok(COMMITTED.order_note.includes(text), text);
  }
  // The API that calls the functions is a later step: nothing in the overlay plan waits on SQL 170 yet.
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.equal(plan.sql_prerequisites?.[SQL170_FILE], undefined);
  assert.doesNotMatch(JSON.stringify(plan), /170_check_endorsement_email_status/);
  // Outside the DO blocks and function bodies: the columns, the index, the three functions and their ACL only.
  const text = fs.readFileSync(path.join(ROOT, SQL170_FILE), 'utf8').replace(/--[^\n]*/g, '');
  const outside = text.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$');
  assert.equal([...outside.matchAll(/\bDO\s+\$/g)].length, 2);
  assert.deepEqual([...outside.matchAll(/\bCREATE OR REPLACE FUNCTION (public\.\w+)\(/g)].map((m) => m[1]),
    ['public.aws_endorsement_email_sent', 'public.aws_endorsement_email_event', 'public.aws_endorsement_link_opened']);
  assert.deepEqual([...outside.matchAll(/\bGRANT\s+([^;]+);/g)].map((m) => m[1].replace(/\s+/g, ' ')),
    ['public.aws_endorsement_email_sent(uuid, text)', 'public.aws_endorsement_email_event(text, text, timestamp with time zone, text)', 'public.aws_endorsement_link_opened(uuid)']
      .map((f) => `EXECUTE ON FUNCTION ${f} TO checksops`));
  assert.deepEqual([...outside.matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => m[1]), [...COLUMNS]);
  assert.doesNotMatch(outside, /\bDROP\b|\bPOLICY\b|\bTRIGGER\b|ROW LEVEL SECURITY|\bCONSTRAINT\b|\bCREATE\s+TABLE\b/i);
  assert.doesNotMatch(text, /\b(TRUNCATE|DELETE\s+FROM|INSERT\s+INTO)\b/i);
  // Every UPDATE is a function's, on check_endorsements, and none sets status, signed_at, the token or updated_at.
  const updates = [...text.matchAll(/\bUPDATE\s+(\S+)\s+\w+\s+SET([\s\S]*?)WHERE/gi)];
  assert.equal(updates.length, 5);
  for (const [, table, set] of updates) {
    assert.equal(table, TABLE);
    assert.doesNotMatch(set, /\b(status|signed_at|token|token_expires_at|updated_at)\s*=/);
  }
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  for (const value of [COMMITTED.intended_replacement_sha256, COMMITTED.source_sha256, ABSENT_PRE, 'SHOW_ENDORSEMENT_EMAIL_STATUS']) {
    assert.ok(runbook.includes(value), value);
  }
  assert.match(runbook, /\*\*Status:\*\* applied in staging \(wave 62, 2026-11-19, apply run 44576208345\); staging acceptance: the staging apply under the owner's run approval \(\"run the SQL 170 staging apply\"; no separate acceptance statement\); production pin execute-authorized on production's own pre-state \(read-only inspect SSM `67613a6c-45ae-4d2e-b1ba-5adb161b80a1`, 2026-11-19\) by the owner-reviewed pin change; not applied in production\./);
  assert.match(runbook, /\*\*Production inspect \(2026-11-19\)\.\*\* Read-only `--inspect` through SSM `67613a6c-45ae-4d2e-b1ba-5adb161b80a1`/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql170` \|/);
  assert.match(oneShot, /`sql168`, `sql169`, `sql170`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql170-check-endorsement-email-status-production-apply\.mjs --inspect/);
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

  // The committed (authorized) pin allows only the manifest bound to its recorded pre-state: not another hash, not the
  // intended state.
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql170_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(COMMITTED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(COMMITTED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql170_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // SQL 169's phrase does not authorize SQL 170.
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'KEEP_CHARGES_WHEN_CHECK_IS_DELETED' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql170-cli-${process.pid}.json`);
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
