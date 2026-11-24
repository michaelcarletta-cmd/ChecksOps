/**
 * Production tool for SQL 172 (scripts/deployment-guard/sql172-check-endorsement-email-engagement-production-apply.mjs on
 * lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs). Owner 2026-11-23: "Yes build opened and
 * clicked" (Resend's opened and clicked events for a payee's endorsement request email, next to Delivered).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 172 included) through the shared refusals;
 * this file covers SQL 172's own:
 *
 *   - the pin has the release pin shape; it was execute-authorized (owner-approved pin change of 2026-11-23, #2049), is
 *     applied (2026-11-23, "SHOW_ENDORSEMENT_EMAIL_OPENED_AND_CLICKED") and retired (execute false, the apply run recorded in
 *     applied, its whole output read back), with the
 *     recorded production pre-state (read-only inspect SSM 03050f81; the derived pre-state) and the staging apply from
 *     the same pre-state (run 45276313813) as its acceptance; it is in step with the staging pin, the one-shot, the bypass
 *     inventory and the test lists;
 *   - predecessor SQL 170; one new SECURITY DEFINER function (EXECUTE checksops and the owner) and six columns on
 *     check_endorsements; no SQL 170 object, table, index, policy, trigger, constraint or table grant; no overlay plan
 *     entry yet; the runbook, one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; the committed pin allows only the manifest bound
 *     to its recorded pre-state; an approved, accepted copy evaluates for the manifest built from it,
 *     and refuses with execute false, another live hash, another staging reference or a wrong phrase; the CLI spends no
 *     receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql172-check-endorsement-email-engagement-pg.test.mjs; the executor path is
 * aws/tests/release-sql172-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql172-check-endorsement-email-engagement-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql172';
const SQL172_FILE = 'aws/workflows/sql/172_check_endorsement_email_engagement.sql';
const TABLE = 'public.check_endorsements';
const FUNCTIONS = Object.freeze(['public.aws_endorsement_email_engagement(text, text, timestamp with time zone)']);
const COLUMNS = Object.freeze(['email_first_opened_at', 'email_last_opened_at', 'email_open_count', 'email_first_clicked_at',
  'email_last_clicked_at', 'email_click_count']);
/** The expected pre-state: the function and the columns absent. */
const ABSENT_PRE = releaseStateHash(KEY, {});
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// SQL 172's recorded production pre-state (read-only inspect of 2026-11-23, SSM 03050f81, main 0756d147e): the six columns
// and the function absent, the derived pre-state.
const PRODUCTION_PRE = 'dbf6a7240cfc5dd737cd47e7f0f765cf6349c0a3a8625a39e02f4901c2e29897';
// The guarded staging apply from the same pre-state.
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/45276313813';
// The owner's words for SQL 172, quoted in the authorization.
const OWNER_WORDS = Object.freeze(['"Yes build opened and clicked"', '"Merge 2044 then run the SQL 172 staging read-live"', '"run the staging SQL executor deploy, then the SQL 172 read-live"', '"Merge 2045, 2046 and approve the SQL 172 staging apply"', '"Merge 2047 when green"', '"run the SQL 172 staging apply"', '"Run the SQL 172 production inspect"', '"Open the SQL 172 production pin PR"']);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql172-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-11-23T00:00:00.000Z',
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

test('pin: the release pin shape, applied and retired (owner approved 2026-11-23 on the staging apply; applied 2026-11-23), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)(\.|$)/.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Owner-approved pin change of 2026-11-23: the read-only production inspect (SSM 03050f81, main 0756d147e) recorded as
  // the pre-state; the staging apply (run 45276313813, from the same pre-state) as the acceptance.
  // Then applied 2026-11-23 under the owner's own words for that run, and retired.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-11-23; execute is false again/);
  for (const words of [...OWNER_WORDS, '"Merge 2050and SHOW_ENDORSEMENT_EMAIL_OPENED_AND_CLICKED"', '"SHOW_ENDORSEMENT_EMAIL_OPENED_AND_CLICKED"']) assert.ok(pin.authorization.includes(words), words);
  assert.ok(pin.authorization.includes('#2049'));
  const applied = pin.applied;
  assert.deepEqual([applied.date, applied.result, applied.apply_ssm_command_id, applied.inspect_ssm_command_id, applied.one_shot_run_id, applied.one_use_id, applied.one_use_id_consumed, applied.owner_approval],
    ['2026-11-23', 'applied', 'a071df6d-ac5d-42fc-a10c-5acd8e6e6d0b', '8c44f818-014a-4beb-abfa-bd9c2e8c51a7', '3f8c6c95-03dd-4a03-82c2-343480bf62a4', 'sql172-prod-9684d2f2-1fdb-4fb9-be08-d833dcfd09ad', true, 'SHOW_ENDORSEMENT_EMAIL_OPENED_AND_CLICKED']);
  assert.equal(applied.workstream_id, 'prod-sql172-endorsement-email-engagement-20261123');
  assert.equal(applied.source_commit, '25b6c54ce28beb314a76df8b5aa073525516e974');
  assert.equal(applied.source_tarball.sha256, 'f88246c80503db7c3fd6c2860bdea593f68e7f6d7d320fea7d645b2e7fa9e462');
  assert.match(applied.source_staged_by, /^sql53-temporary-transfer\.yml run 45288348430 /);
  assert.equal(applied.migration_source_sha256, pin.source_sha256);
  assert.equal(applied.manifest_sha256, '2a865b792eae6e6bfca5a56887cbf7fba5c76de240f0ed6fc2e4679a0c85d093');
  assert.deepEqual(applied.steps, ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
  assert.deepEqual(Object.keys(applied.contract_results), ['claim-ledger', 'tenant-isolation', 'financial-write-protections']);
  for (const c of Object.values(applied.contract_results)) assert.equal(c.ok, true);
  assert.equal(applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(applied.pre_apply_inspect.live_matches_expected, true);
  assert.deepEqual(applied.pre_apply_inspect.precondition_failures, []);
  assert.deepEqual(applied.pre_apply_inspect.predecessors, { sql170: true });
  assert.equal(applied.receipt.before_hash, pin.expected_live_definition_sha256);
  assert.equal(applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(applied.receipt.result, 'applied');
  assert.equal(applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(applied.post_apply_inspect.already_applied, true);
  assert.equal(applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(applied.post_apply_inspect.precondition_failures, []);
  const after = applied.post_apply_inspect.release_sql_inspect;
  assert.deepEqual(after.functions, [{ name: 'aws_endorsement_email_engagement(text, text, timestamp with time zone)', state: 'intended' }]);
  assert.deepEqual(after.columns, COLUMNS.map((c) => ({ name: `check_endorsements.${c}`, state: 'intended' })));
  assert.deepEqual(after.tables, []);
  assert.ok(after.function_acl.every((f) => JSON.stringify(f.acl) === JSON.stringify(['checksops EXECUTE', 'owner EXECUTE'])));
  assert.deepEqual(after.predecessors, { sql170: true });
  assert.deepEqual(applied.receipt.release_sql_inspect, after);
  // The whole output was read back: nothing is marked not captured.
  assert.equal(applied.output_recovery_note, undefined);
  assert.equal(applied.not_captured, undefined);
  for (const text of ['arrived complete through SSM', '4ee4e4cce628f11782ae0fbd6d733bbcf8d7a20f6f519ea01c28bbbb88a0d9f8', '6f706cccb70a373b89d8a14d7d12e3f699aba3232ce811914a7141647adf6bc0',
    'transfer run 45288348430', '8c44f818-014a-4beb-abfa-bd9c2e8c51a7', '18f0eb1b0ef75d3284f15357e15f0be97e2e3cca999b9384c707aea4dc37e709', '80348cb5a147128b11ddedaf89db5c7688a4643adb4fd99ed1410da18118412a',
    '59615f54-aed2-4c87-86c9-9c48b442f459', 'Production acceptance: not yet reported by the owner']) assert.ok(applied.one_shot_note.includes(text), text);
  for (const text of ['a071df6d-ac5d-42fc-a10c-5acd8e6e6d0b', '3f8c6c95-03dd-4a03-82c2-343480bf62a4', '8c44f818-014a-4beb-abfa-bd9c2e8c51a7']) assert.ok(pin.production_evidence['2026-11-23 apply'].includes(text), text);
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, ABSENT_PRE);
  assert.equal(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-11-23');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, '03050f81-bebc-4566-a116-35147b3410f6');
  assert.equal(pin.production_inspect.source_commit, '0756d147ebc3ce68d84193be2dab3d0b3a3a203f');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  for (const text of ['4b7c10502c7c82383c38344511403a0d9ee4e92b7586e636167c9be23201c0d5', '32b8b0c48735e61387810baf89031920ee4ab0e8ce9d5a013cfee0e9dc9a0709',
    'run 45276868976', 'prerequisites_missing [], predecessors { sql170: true }, successors_applied [], precondition_failures []', 'already_applied false',
    'ok true, read_only true, source_ok true, current_user, session_user and admin_login checksops_admin, pin_execute false, predecessors_applied true',
    'definer_writes check_endorsements ok', 'definer_can_write_relations', ABSENT_PRE]) {
    assert.ok(pin.production_inspect.note.includes(text), text);
  }
  assert.match(pin.production_inspect.note, /If already_applied is true, prerequisites_missing is not \[\] or precondition_failures is not \[\], stop/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no release-engine production inspect has been run for SQL 172 yet'));
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql172-check-endorsement-email-engagement, run 45276313813/);
  assert.match(pin.staging_acceptance.basis, /wave 64/);
  assert.match(pin.staging_acceptance.basis, /deploy run 45275236144/);
  assert.match(pin.staging_acceptance.basis, /read-live run 45267758829/);
  assert.ok(pin.staging_acceptance.basis.includes(`receipt before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.match(pin.staging_acceptance.basis, /Read-live run 45278111052 then reported already_applied true/);
  assert.match(pin.staging_acceptance.basis, /Production's pre-state \(production_inspect\) equals staging's/);
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  assert.equal(pin.filename, SQL172_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL172_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, FUNCTIONS);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, ['sql170']);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'SHOW_ENDORSEMENT_EMAIL_OPENED_AND_CLICKED');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql172-check-endorsement-email-engagement-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-172-apply.md');
  for (const file of [pin.tooling.production_tool, pin.tooling.runbook, pin.tooling.fingerprint_engine, pin.tooling.production_lib, ...pin.tooling.tests]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  }
  assert.equal(readPinnedReleaseSql(KEY, ROOT, pin).ok, true);
  // One-shot: the release tool (no hash in the registry).
  const tool = ONE_SHOT_TOOLS[KEY];
  assert.equal(tool.key, KEY);
  assert.equal(tool.script, RELEASE_PRODUCTION[KEY].cli);
  assert.deepEqual([...tool.args], []);
  assert.equal(tool.pin_rel, RELEASE_PRODUCTION[KEY].pin_rel);
  assert.equal(tool.allowed_key, 'sql172_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql172-check-endorsement-email-engagement-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql172-production-apply"\]/);
  assert.match(rows, /sql169, sql170, sql171, sql172, sql173, sql174\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql172-executor.test.mjs', 'aws/tests/release-sql172-production-apply.test.mjs', 'aws/tests/sql172-check-endorsement-email-engagement-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: predecessor SQL 170; one DEFINER function and six columns on check_endorsements, no SQL 170 object, nothing else; no overlay plan entry yet; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, ['sql170']);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.production_only, undefined);
  assert.equal(spec.production_noop, undefined);
  assert.deepEqual(spec.functions.map((f) => [f.identity, f.acl]), FUNCTIONS.map((f) => [f, ['checksops EXECUTE', 'owner EXECUTE']]));
  assert.deepEqual(spec.added_columns.map((c) => [c.table, c.column, c.acl]), COLUMNS.map((c) => [TABLE, c, []]));
  assert.deepEqual(spec.definer_writes, [TABLE]);
  assert.deepEqual(spec.altered_relations, [TABLE]);
  for (const absent of ['tables', 'views', 'policies', 'table_privileges', 'column_acl', 'dropped_functions', 'acl_functions', 'constraints', 'added_constraints', 'altered_columns', 'triggers', 'dropped_triggers', 'indexes']) {
    assert.equal(spec[absent], undefined, absent);
  }
  // No other release migration fingerprints this function or these columns; SQL 172 fingerprints no SQL 170 object.
  for (const key of Object.keys(RELEASE_SQL_SPECS).filter((k) => k !== KEY)) {
    const other = JSON.stringify(RELEASE_SQL_SPECS[key]);
    for (const name of ['aws_endorsement_email_engagement', ...COLUMNS]) assert.ok(!other.includes(name), `${key} ${name}`);
  }
  const own = JSON.stringify(spec);
  for (const name of ['aws_endorsement_email_sent', 'aws_endorsement_email_event', 'aws_endorsement_link_opened', 'check_endorsements_email_message_id_idx', 'link_open_count', 'email_message_id']) {
    assert.ok(!own.includes(name), name);
  }
  assert.match(COMMITTED.order_note, /^After SQL 170 \(aws\/workflows\/sql\/170_check_endorsement_email_status\.sql, applied to production 2026-11-19\)/);
  for (const text of ['"Yes build opened and clicked"', 'sql172_prerequisite_missing', 'sql172_definer_cannot_write',
    'sql172_column_conflict', 'definer_can_write_relations', 'predecessors_applied', 'No API, Lambda or SPA change is part of this pin', ABSENT_PRE]) {
    assert.ok(COMMITTED.order_note.includes(text), text);
  }
  // The API that calls the function is a later step: nothing in the overlay plan waits on SQL 172 yet.
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.equal(plan.sql_prerequisites?.[SQL172_FILE], undefined);
  assert.doesNotMatch(JSON.stringify(plan), /172_check_endorsement_email_engagement/);
  // Outside the DO blocks and function bodies: the columns, the function and its ACL only.
  const text = fs.readFileSync(path.join(ROOT, SQL172_FILE), 'utf8').replace(/--[^\n]*/g, '');
  const outside = text.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$');
  assert.equal([...outside.matchAll(/\bDO\s+\$/g)].length, 2);
  assert.deepEqual([...outside.matchAll(/\bCREATE OR REPLACE FUNCTION (public\.\w+)\(/g)].map((m) => m[1]), ['public.aws_endorsement_email_engagement']);
  assert.deepEqual([...outside.matchAll(/\bGRANT\s+([^;]+);/g)].map((m) => m[1].replace(/\s+/g, ' ')),
    FUNCTIONS.map((f) => `EXECUTE ON FUNCTION ${f} TO checksops`));
  assert.deepEqual([...outside.matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => m[1]), [...COLUMNS]);
  assert.doesNotMatch(outside, /\bDROP\b|\bPOLICY\b|\bTRIGGER\b|ROW LEVEL SECURITY|\bCONSTRAINT\b|\bCREATE\s+TABLE\b|\bCREATE\s+(UNIQUE\s+)?INDEX\b/i);
  assert.doesNotMatch(text, /\b(TRUNCATE|DELETE\s+FROM|INSERT\s+INTO)\b/i);
  // Every UPDATE is the function's, on check_endorsements, and sets only the engagement columns.
  const updates = [...text.matchAll(/\bUPDATE\s+(\S+)\s+\w+\s+SET([\s\S]*?)WHERE/gi)];
  assert.equal(updates.length, 2);
  for (const [, table, set] of updates) {
    assert.equal(table, TABLE);
    const assigned = [...set.matchAll(/(?:^|,)\s*(\w+)\s*=/g)].map((m) => m[1]);
    assert.equal(assigned.length, 3, set);
    assert.ok(assigned.every((c) => COLUMNS.includes(c)), set);
  }
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  for (const value of [COMMITTED.intended_replacement_sha256, COMMITTED.source_sha256, ABSENT_PRE, 'SHOW_ENDORSEMENT_EMAIL_OPENED_AND_CLICKED']) {
    assert.ok(runbook.includes(value), value);
  }
  assert.match(runbook, /\*\*Status:\*\* applied in staging \(wave 64, 2026-11-23, apply run 45276313813\); staging acceptance: the staging apply under the owner's run approval \("run the SQL 172 staging apply"; no separate acceptance statement\); applied to production \(2026-11-23\); the production pin is retired \(`execute: false`\)\./);
  assert.match(runbook, /\*\*Production apply \(2026-11-23\)\.\*\* /);
  assert.match(runbook, /\*\*Production inspect \(2026-11-23\)\.\*\* Read-only `--inspect` through SSM `03050f81-bebc-4566-a116-35147b3410f6`/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql172` \|/);
  assert.match(oneShot, /`sql170`, `sql171`, `sql172`, `sql173`, `sql174`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql172-check-endorsement-email-engagement-production-apply\.mjs --inspect/);
});

test('the pending (pre-authorization) pin refuses before connecting; the committed pin allows only its own manifest; execute false, other hashes and phrases refuse', async () => {
  // The pin before its owner-approved change: no pre-state, no owner approval, no staging acceptance.
  const PENDING = Object.freeze({ ...COMMITTED, authorization: 'pending', execute: false, expected_live_definition_sha256: null, staging_acceptance: { ok: false, reference: null, basis: 'Pending' } });
  const noPre = await evaluateReleaseProductionApply(KEY, manifest({ ...PENDING, expected_live_definition_sha256: PRE }), { root: ROOT, pin: PENDING });
  assert.equal(noPre.code, CODES.SQL_COLLISION);
  const withPre = { ...PENDING, expected_live_definition_sha256: PRE };
  // An execute-authorized copy of the committed (retired) pin allows only the manifest bound to its recorded pre-state; the
  // retired pin refuses before connecting.
  const AUTHORIZED = Object.freeze({ ...COMMITTED, execute: true, authorization: 'Owner approved 2026-11-23 (test copy of the execute-authorized pin before its record-and-retire change)' });
  assert.equal((await executeReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, false);
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(AUTHORIZED), { root: ROOT, pin: AUTHORIZED });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql172_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: AUTHORIZED })).ok, false);

  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(withPre), { root: ROOT, pin: withPre })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(withPre), { root: ROOT, pin: withPre, connect: neverConnect, consumedPath: consumedPath() })).ok, false);
  // execute true alone does not authorize it.
  const flipped = { ...withPre, execute: true };
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(flipped), { root: ROOT, pin: flipped })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql172_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // SQL 170's phrase does not authorize SQL 172.
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'SHOW_ENDORSEMENT_EMAIL_STATUS' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql172-cli-${process.pid}.json`);
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
