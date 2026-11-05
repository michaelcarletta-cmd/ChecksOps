/**
 * Production tool for SQL 143 (scripts/deployment-guard/sql143-mortgage-companies-member-delete-unused-production-
 * apply.mjs on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 143 included) through the shared
 * refusals; this file covers SQL 143's own:
 *
 *   - the pin has the release pin shape, is pending (execute false, no pre-state, no approval, production
 *     unverified), and is in step with the staging pin, the one-shot, the bypass inventory and the test lists;
 *   - predecessor SQL 142 (superseded); the two functions, the three member policies, SQL 142's two dropped and the
 *     in-use trigger on mortgage_companies; no table, view, column or grant; no overlay plan entry; the runbook,
 *     one-shot doc and README name it;
 *   - the pending pin refuses before connecting; an approved, accepted copy evaluates for the manifest built from
 *     it, and refuses with execute false, another live hash, another staging reference or a wrong phrase; the CLI
 *     spends no receipt.
 * The behaviour on PostgreSQL 16 is aws/tests/sql143-mortgage-companies-member-delete-tool-pg.test.mjs; the
 * executor path is aws/tests/release-sql143-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql143-mortgage-companies-member-delete-unused-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql143';
const SQL143_FILE = 'aws/workflows/sql/143_mortgage_companies_member_delete_unused.sql';
const PRE_SQL142 = 'c62a1b0b337cca713cd8551f1a1c70f507ef451e40731baa6e8479abae51038d';
const FUNCTIONS = ['public.aws_can_edit_mortgage_company_directory()', 'public.aws_mortgage_company_in_use_guard()'];
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql143-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-11-05T00:00:00.000Z',
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


test('pin: the release pin shape, pending, production unverified, in step with the staging pin, the one-shot, the inventory and the test lists', () => {
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
  for (const word of ['prerequisites_missing', 'already_applied', 'predecessors {sql142: true}', 'the seven counts 1', 'Production is unverified', PRE_SQL142]) {
    assert.ok(pin.production_inspect.note.includes(word), word);
  }
  for (const code of ['sql143_table_missing', 'sql143_rls_disabled', 'sql143_column_missing', 'sql143_reference_missing', 'sql143_owner_policy_missing',
    'sql143_owner_policy_collision', 'sql143_sql142_policy_collision', 'sql143_sql142_policy_missing', 'sql143_unexpected_policy',
    'sql143_guard_cannot_see_all_rows', 'sql143_function_missing', 'mortgage_companies_rls_enabled', 'mortgage_companies_id_uuid_is_active_boolean',
    'mortgage_company_references_uuid', 'mortgage_companies_owner_policy_intact', 'mortgage_companies_sql142_policies_replaceable',
    'mortgage_companies_no_unexpected_policy', 'mortgage_company_references_readable_by_login', 'The pre-state after SQL 142 is derivable',
    'Remove should delete it']) {
    assert.ok(pin.order_note.includes(code), code);
  }
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [false, null]);
  assert.match(pin.staging_acceptance.basis, /read-live and the staging apply of SQL 143/);
  assert.equal(pin.filename, SQL143_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, read(SQL143_FILE)));
  assert.deepEqual(pin.function_identities, FUNCTIONS);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, ['sql142']);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_MORTGAGE_COMPANIES_MEMBER_DELETE_UNUSED');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql143-mortgage-companies-member-delete-unused-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-143-apply.md');
  for (const file of [pin.tooling.production_tool, pin.tooling.runbook, pin.tooling.fingerprint_engine, pin.tooling.production_lib, ...pin.tooling.tests]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  }
  assert.equal(readPinnedReleaseSql(KEY, ROOT, pin).ok, true);
  const tool = ONE_SHOT_TOOLS[KEY];
  assert.equal(tool.key, KEY);
  assert.equal(tool.script, RELEASE_PRODUCTION[KEY].cli);
  assert.deepEqual([...tool.args], []);
  assert.equal(tool.pin_rel, RELEASE_PRODUCTION[KEY].pin_rel);
  assert.equal(tool.allowed_key, 'sql143_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql143-mortgage-companies-member-delete-unused-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql143-production-apply"\]/);
  assert.match(rows, /sql139, sql140, sql141, sql142, sql143\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = read('.github/workflows/deployment-guard.yml');
  for (const name of ['aws/tests/release-sql143-executor.test.mjs', 'aws/tests/release-sql143-production-apply.test.mjs', 'aws/tests/sql143-mortgage-companies-member-delete-tool-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: predecessor SQL 142, which it supersedes; the two functions, the three member policies, SQL 142\'s two dropped and the in-use trigger on mortgage_companies; no plan entry; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, ['sql142']);
  assert.deepEqual(spec.supersedes, ['sql142']);
  assert.deepEqual(spec.functions.map((fn) => fn.identity), FUNCTIONS);
  assert.deepEqual(spec.policies.map((p) => `${p.table} ${p.name}`), ['public.mortgage_companies aws_insert_mortgage_companies_member',
    'public.mortgage_companies aws_update_mortgage_companies_member', 'public.mortgage_companies aws_delete_mortgage_companies_member']);
  assert.deepEqual(spec.dropped_policies.map((p) => `${p.table} ${p.name}`), ['public.mortgage_companies aws_insert_mortgage_companies_tenant_admin',
    'public.mortgage_companies aws_update_mortgage_companies_tenant_admin']);
  assert.deepEqual(spec.triggers.map((tr) => `${tr.table} ${tr.name}`), ['public.mortgage_companies aws_mortgage_company_in_use_guard']);
  for (const none of ['tables', 'views', 'dropped_functions', 'dropped_triggers', 'added_columns', 'column_acl', 'table_privileges', 'indexes', 'acl_functions']) {
    assert.ok(spec[none] === undefined || spec[none].length === 0, none);
  }
  // The DB validator followed the staging apply (run 42023495275), as 4a3f4658e did for SQL 123, and justifies the
  // trigger by name (185). Its production overlay row waits for SQL 143 in production (sql_before), and staging
  // records SQL 143 live (read-live run 42023847018).
  const validator = read('aws/functions/api/db-readonly-validate.mjs');
  assert.match(validator, /trigger: 'aws_mortgage_company_in_use_guard',\n\s+functionName: 'aws_mortgage_company_in_use_guard'/);
  assert.match(validator, /export const EXPECTED_PUBLIC_TRIGGERS = 185;/);
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.deepEqual(Object.keys(plan.members).filter((m) => plan.members[m].sql_before === SQL143_FILE), ['db-readonly-validate.mjs']);
  const stagingLive = readJson('ops/deployment-guard/staging-sql-live.json').sql[SQL143_FILE];
  assert.equal(stagingLive.verified_live, true);
  for (const evidence of ['run 42023495275', 'read-live run 42023847018', `after ${COMMITTED.intended_replacement_sha256.slice(0, 8)}…`]) {
    assert.ok(stagingLive.evidence.includes(evidence), evidence);
  }
  const runbook = read(COMMITTED.tooling.runbook);
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.ok(runbook.includes(PRE_SQL142));
  assert.match(runbook, /\*\*Status:\*\* applied in staging \(wave 38, 2026-11-05\); staging acceptance: owner tested in staging \("SQL 143 accepted in staging"\); production pin pending \(production inspect next\)/);
  assert.match(runbook, /"SQL 143 accepted in staging"/);
  assert.match(runbook, /\*\*Staging apply \(2026-11-05\)\.\*\* Apply run 42023495275/);
  assert.match(runbook, /Read-live run 42023847018/);
  assert.match(runbook, /APPLY_MORTGAGE_COMPANIES_MEMBER_DELETE_UNUSED/);
  const oneShot = read('ops/production-sql-one-shot.md');
  assert.match(oneShot, /\| `sql143` \|/);
  assert.match(oneShot, /`sql140`, `sql141`, `sql142`, `sql143`\) \|/);
  assert.match(read('ops/deployment-guard/README.md'), /sql143-mortgage-companies-member-delete-unused-production-apply\.mjs --inspect/);
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
  assert.equal(allowed.details.sql143_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY_MORTGAGE_COMPANIES' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed (pending) pin, read from disk, refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql143-cli-${process.pid}.json`);
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
