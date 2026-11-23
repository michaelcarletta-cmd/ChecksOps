/**
 * Production tool for SQL 173 (scripts/deployment-guard/sql173-job-expenses-production-apply.mjs on
 * lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs). Owner 2026-11-23: "Proceed with the per
 * job build. Make sure it is for insurance jobs and cash jobs" (job costs paid outside ChecksOps recorded against an
 * insurance job or a cash job). release-sql90-97-production-apply.test.mjs runs every release key (SQL 173 included)
 * through the shared refusals; this file covers SQL 173's own:
 *
 *   - the pin has the release pin shape, is pending (execute false, no pre-state, no approval) and is in step with the
 *     staging pin, the one-shot, the bypass inventory and the test lists;
 *   - no predecessor; one new table (RLS on, one tenant SELECT policy, SELECT for checksops and authenticated) and two
 *     new SECURITY DEFINER functions (EXECUTE checksops and the owner); no existing object changed; no overlay plan entry
 *     yet; the runbook, one-shot doc and README name it;
 *   - the pending pin refuses before connecting; an approved, accepted copy evaluates for the manifest built from it,
 *     and refuses with execute false, another live hash, another staging reference or a wrong phrase; the CLI spends no
 *     receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql173-job-expenses-pg.test.mjs; the executor path is
 * aws/tests/release-sql173-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql173-job-expenses-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql173';
const SQL173_FILE = 'aws/workflows/sql/173_job_expenses.sql';
const TABLE = 'public.job_expenses';
const FUNCTIONS = Object.freeze([
  'public.aws_job_expense_add(uuid, uuid, uuid, text, bigint, date, text, text, text, text, text, uuid)',
  'public.aws_job_expense_delete(uuid, uuid, uuid)',
]);
/** The expected pre-state: the table, its policy and both functions absent. */
const ABSENT_PRE = releaseStateHash(KEY, {});
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql173-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
  for (const text of ['prerequisites_missing', 'predecessors {} (none)', 'already_applied false', 'precondition_failures', 'definer_can_write_relations', ABSENT_PRE]) {
    assert.ok(pin.production_inspect.note.includes(text), text);
  }
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [false, null]);
  assert.match(pin.staging_acceptance.basis, /read-live and the staging apply of SQL 173/);
  assert.equal(pin.filename, SQL173_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL173_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, FUNCTIONS);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'RECORD_JOB_EXPENSES');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql173-job-expenses-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-173-apply.md');
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
  assert.equal(tool.allowed_key, 'sql173_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql173-job-expenses-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql173-production-apply"\]/);
  assert.match(rows, /sql170, sql171, sql172, sql173\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql173-executor.test.mjs', 'aws/tests/release-sql173-production-apply.test.mjs', 'aws/tests/sql173-job-expenses-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; one new table with one tenant SELECT policy and two new DEFINER functions, nothing existing changed; no overlay plan entry yet; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.production_only, undefined);
  assert.equal(spec.production_noop, undefined);
  assert.deepEqual(spec.functions.map((f) => [f.identity, f.acl]), FUNCTIONS.map((f) => [f, ['checksops EXECUTE', 'owner EXECUTE']]));
  assert.deepEqual(spec.tables.map((t) => [t.name, t.rls, t.forced, t.acl]), [[TABLE, true, false, ['authenticated SELECT', 'checksops SELECT']]]);
  // The policy is the tenant-scoped SELECT policy of aws/rls/sql/12_final_select_policies.sql (cash_jobs' among them).
  assert.deepEqual(spec.policies, [{
    table: TABLE, name: 'aws_select_job_expenses', cmd: 'SELECT', roles: ['authenticated'], permissive: true,
    qual: '(public.aws_is_cross_tenant_reader() OR public.aws_can_access_tenant(tenant_id))', with_check: null,
  }]);
  const finalSelect = fs.readFileSync(path.join(ROOT, 'aws/rls/sql/12_final_select_policies.sql'), 'utf8');
  assert.ok(finalSelect.includes('CREATE POLICY aws_select_cash_jobs ON public.cash_jobs\n  FOR SELECT TO authenticated\n  USING (public.aws_is_cross_tenant_reader() OR public.aws_can_access_tenant(tenant_id));'));
  const fileText = fs.readFileSync(path.join(ROOT, SQL173_FILE), 'utf8');
  assert.ok(fileText.includes('CREATE POLICY aws_select_job_expenses ON public.job_expenses\n  FOR SELECT TO authenticated\n  USING (public.aws_is_cross_tenant_reader() OR public.aws_can_access_tenant(tenant_id));'));
  // The DEFINER reads claims, cash_jobs and check_intake_items past RLS (sql173_definer_cannot_read).
  assert.deepEqual(spec.definer_writes, ['public.claims', 'public.cash_jobs', 'public.check_intake_items']);
  for (const absent of ['views', 'table_privileges', 'column_acl', 'dropped_functions', 'acl_functions', 'indexes', 'added_columns', 'altered_columns', 'constraints', 'triggers', 'dropped_triggers', 'altered_relations', 'dropped_policies']) {
    assert.equal(spec[absent], undefined, absent);
  }
  // No other release migration names the table or the functions.
  for (const key of Object.keys(RELEASE_SQL_SPECS).filter((k) => k !== KEY)) {
    const other = JSON.stringify(RELEASE_SQL_SPECS[key]);
    for (const name of ['job_expenses', 'aws_job_expense_add', 'aws_job_expense_delete']) assert.ok(!other.includes(name), `${key} ${name}`);
  }
  assert.match(COMMITTED.order_note, /^No predecessor\. SQL 173 creates one table and two functions and replaces nothing/);
  for (const text of ['"Proceed with the per job build. Make sure it is for insurance jobs and cash jobs"', 'sql173_prerequisite_missing',
    'sql173_definer_cannot_read', 'sql173_unexpected_table', 'created_tables_absent_or_intended', 'created_tables_owned_by_login',
    'definer_can_write_relations', 'claimBelongsToTenant', 'No API, Lambda or SPA change is part of this pin', ABSENT_PRE]) {
    assert.ok(COMMITTED.order_note.includes(text), text);
  }
  // The API that calls the functions is a later step: nothing in the overlay plan waits on SQL 173 yet.
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.equal(plan.sql_prerequisites?.[SQL173_FILE], undefined);
  assert.doesNotMatch(JSON.stringify(plan), /173_job_expenses/);
  // The file: three guarded DO blocks, the table, its three indexes, RLS, the policy, the grants, the two functions with
  // their ACLs and comments; no other object, and no row written outside the functions.
  const text = fileText.replace(/--[^\n]*/g, '');
  const outside = text.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$');
  const bare = outside.replace(/'(?:[^']|'')*'/g, "''");
  assert.equal([...outside.matchAll(/\bDO\s+\$/g)].length, 3);
  assert.deepEqual([...outside.matchAll(/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(TABLE|INDEX|FUNCTION|POLICY)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+?)(?:\(|\s)/gi)].map((m) => `${m[1].toUpperCase()} ${m[2]}`),
    ['TABLE public.job_expenses', 'INDEX job_expenses_tenant_idempotency_key', 'INDEX job_expenses_tenant_claim_idx', 'INDEX job_expenses_tenant_cash_job_idx',
      'POLICY aws_select_job_expenses', 'FUNCTION public.aws_job_expense_add', 'FUNCTION public.aws_job_expense_delete']);
  assert.deepEqual([...outside.matchAll(/\bALTER\s+TABLE\s+(\S+)\s+([^;]+);/gi)].map((m) => `${m[1]} ${m[2].trim()}`), [`${TABLE} ENABLE ROW LEVEL SECURITY`]);
  assert.deepEqual([...outside.matchAll(/\bDROP\s+[^;]+;/gi)].map((m) => m[0]), ['DROP POLICY IF EXISTS aws_select_job_expenses ON public.job_expenses;']);
  assert.deepEqual([...bare.matchAll(/\b(GRANT|REVOKE)\s+[^;]+;/gi)].map((m) => m[0].replace(/\s+/g, ' ')), [
    'GRANT SELECT ON TABLE public.job_expenses TO checksops, authenticated;',
    `REVOKE ALL ON FUNCTION ${FUNCTIONS[0]} FROM PUBLIC;`,
    `REVOKE ALL ON FUNCTION ${FUNCTIONS[1]} FROM PUBLIC;`,
    `GRANT EXECUTE ON FUNCTION ${FUNCTIONS[0]} TO checksops;`,
    `GRANT EXECUTE ON FUNCTION ${FUNCTIONS[1]} TO checksops;`,
  ]);
  assert.doesNotMatch(bare, /\bTRIGGER\b|\bFORCE\b|\bFOR\s+(INSERT|UPDATE|DELETE|ALL)\b/i);
  assert.doesNotMatch(outside, /\b(TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+public\.)/i);
  // Inside the functions: the only writes are to job_expenses.
  assert.deepEqual([...text.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(public\.\w+)/gi)].map((m) => m[1]), [TABLE, TABLE]);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  for (const value of [COMMITTED.intended_replacement_sha256, COMMITTED.source_sha256, ABSENT_PRE, 'RECORD_JOB_EXPENSES']) {
    assert.ok(runbook.includes(value), value);
  }
  assert.match(runbook, /\*\*Status:\*\* tooling built; staging and production pins pending \(`execute: false`\)\. Nothing applied or read\./);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql173` \|/);
  assert.match(oneShot, /`sql171`, `sql172`, `sql173`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql173-job-expenses-production-apply\.mjs --inspect/);
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
  assert.equal(allowed.details.sql173_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // SQL 172's phrase does not authorize SQL 173.
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'SHOW_ENDORSEMENT_EMAIL_OPENED_AND_CLICKED' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed (pending) pin, read from disk, refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql173-cli-${process.pid}.json`);
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
