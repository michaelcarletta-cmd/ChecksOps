/**
 * Production tool for SQL 133 (scripts/deployment-guard/sql133-financial-totp-admin-reset-enrollment-
 * production-apply.mjs on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 133 included) through the
 * shared refusals; this file covers SQL 133's own:
 *
 *   - the pin has the release pin shape, is pending (execute false, no pre-state, no approval)
 *     and is in step with the staging pin, the one-shot, the bypass inventory and the test lists;
 *   - no predecessor; the one new function (EXECUTE for checksops and the owner, PUBLIC revoked), the
 *     prerequisites (the enrollment, tenant membership and identity tables and their columns,
 *     auth.uid(), role checksops), the four definer relations; no table, view, policy, trigger or
 *     drop, and no grant but the REVOKE from PUBLIC and the GRANT to checksops on this one function;
 *     the overlay plan holds admin-reset-totp.mjs behind this SQL; the API calls the function and
 *     checks for it first; the runbook, one-shot doc and README name it;
 *   - the pending pin refuses before connecting; an approved, accepted copy evaluates for the
 *     manifest built from it, and refuses with execute false, another live hash, another staging
 *     reference or a wrong phrase; the CLI spends no receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql133-financial-totp-admin-reset-pg.test.mjs; the
 * executor path is aws/tests/release-sql133-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql133-financial-totp-admin-reset-enrollment-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql133';
const SQL133_FILE = 'aws/workflows/sql/133_financial_totp_admin_reset_enrollment.sql';
const IDENTITY = 'public.financial_totp_admin_reset_enrollment(uuid, uuid)';
const TABLE = 'public.financial_totp_enrollments';
const RELATIONS = Object.freeze([TABLE, 'public.tenant_users', 'public.identity_accounts', 'public.profiles']);
const SQL133_IDENTITIES = Object.freeze([IDENTITY]);
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql133-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-10-30T00:00:00.000Z',
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
  assert.match(pin.production_inspect.note, /prerequisites_missing/);
  assert.match(pin.production_inspect.note, /definer_can_write_relations/);
  assert.match(pin.production_inspect.note, /functions_owned_by_login/);
  assert.match(pin.production_inspect.note, /function_results_match/);
  assert.match(pin.production_inspect.note, /function_acl_replaceable/);
  assert.match(pin.production_inspect.note, /SSM cfee4512-4988-4fd1-be77-b03d1b4cd50b/);
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [false, null]);
  assert.match(pin.staging_acceptance.basis, /read-live and the staging apply of SQL 133/);
  assert.equal(pin.filename, SQL133_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL133_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, SQL133_IDENTITIES);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_FINANCIAL_TOTP_ADMIN_RESET');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql133-financial-totp-admin-reset-enrollment-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-133-apply.md');
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
  assert.equal(tool.allowed_key, 'sql133_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(RELEASE_SQL_SPECS[KEY].runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql133-financial-totp-admin-reset-enrollment-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql133-production-apply"\]/);
  assert.match(rows, /sql129, sql130, sql131, sql132, sql133, sql134\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql133-executor.test.mjs', 'aws/tests/release-sql133-production-apply.test.mjs', 'aws/tests/sql133-financial-totp-admin-reset-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; the one new function, its prerequisites and the four definer relations; REVOKE from PUBLIC and GRANT to checksops, nothing else; the plan holds admin-reset-totp.mjs behind it; the API calls it and checks for it first; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.supersedes, undefined);
  assert.deepEqual(spec.functions.map((fn) => fn.identity), SQL133_IDENTITIES);
  for (const fn of spec.functions) {
    assert.deepEqual(fn.acl, ['checksops EXECUTE', 'owner EXECUTE'], fn.identity);
    assert.deepEqual(fn.revokes, ['PUBLIC EXECUTE'], fn.identity);
    assert.equal(fn.result, 'TABLE(cleared boolean)');
  }
  assert.equal(spec.dropped_functions, undefined);
  assert.equal(spec.acl_functions, undefined);
  assert.deepEqual(spec.prerequisites.slice(0, 6), [...RELATIONS, 'auth.uid()', 'role checksops']);
  for (const column of ['financial_totp_enrollments.application_user_id', 'tenant_users.tenant_id', 'tenant_users.user_id',
    'identity_accounts.application_user_id', 'identity_accounts.email', 'profiles.id', 'profiles.email']) {
    assert.ok(spec.prerequisites.includes(`column public.${column}`), column);
  }
  assert.deepEqual(spec.definer_writes, [...RELATIONS]);
  for (const absent of ['tables', 'views', 'policies', 'triggers', 'altered_relations']) assert.equal(spec[absent], undefined, absent);
  assert.match(COMMITTED.order_note, /^No predecessor: SQL 133 calls none of SQL 130, 131 or 132's functions/);
  assert.match(COMMITTED.order_note, /definer_can_write_relations/);
  assert.match(COMMITTED.order_note, /tolerates its absence \(the Cognito and profiles reset as before, financialTotpCleared false, never a 500\)/);
  assert.match(COMMITTED.order_note, /no API, Lambda or SPA change is part of this pin\./);
  // SQL 130's and SQL 131's production pins are applied and retired (#1453, #1463); SQL 132's is on
  // its own guarded path (pin #1467); this change touches none of them.
  assert.equal(loadReleaseProductionPin('sql130', ROOT).applied.result, 'applied');
  const sql131 = loadReleaseProductionPin('sql131', ROOT);
  assert.equal(sql131.execute, false);
  assert.equal(sql131.applied.result, 'applied');
  const sql132 = loadReleaseProductionPin('sql132', ROOT);
  assert.equal(sql132.migration, 'sql132');
  assert.equal(typeof sql132.execute, 'boolean');
  // The API member that calls the function pends its REPLACE on this pin: admin-reset-totp.mjs has
  // sql_before SQL 133, recorded in the overlay plan as not yet verified live, so the guarded Lambda path
  // refuses it until the record change.
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.deepEqual(plan.sql_prerequisites[SQL133_FILE], { verified_live: false, evidence: null });
  assert.equal(plan.members['admin-reset-totp.mjs'].sql_before, SQL133_FILE);
  assert.notEqual(plan.members['admin-reset-totp.mjs'].expected_live_sha256, plan.members['admin-reset-totp.mjs'].accepted_sha256, 'admin-reset-totp.mjs pends the reset REPLACE');
  // The API: the one call and the existence check, as checksops, inside the reset transaction before Cognito.
  const call = 'SELECT cleared FROM public.financial_totp_admin_reset_enrollment($1::uuid, $2::uuid)';
  const presentCall = 'SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS present';
  const api = fs.readFileSync(path.join(ROOT, 'aws/functions/api/admin-reset-totp.mjs'), 'utf8');
  assert.ok(api.includes(call));
  assert.ok(api.includes(presentCall));
  assert.ok(api.includes(`'${IDENTITY}'`));
  assert.match(api, /export const clearFinancialTotpEnrollment = async \(client, actorUserId, targetUserId\) => \{/);
  assert.ok(api.indexOf('await consumeResetStepUp(') < api.indexOf('await clearFinancialTotpEnrollment(client, mapping.application_user_id, userId)'));
  assert.ok(api.indexOf('await clearFinancialTotpEnrollment(client, mapping.application_user_id, userId)') < api.indexOf('new AdminGetUserCommand('));
  assert.equal([...api.matchAll(/financialTotpCleared: financial\.cleared/g)].length, 3, 'every success answer says whether the authenticator was cleared');
  // One DO block, one CREATE OR REPLACE FUNCTION, the REVOKE from PUBLIC and the GRANT to checksops on it; nothing else.
  const text = fs.readFileSync(path.join(ROOT, SQL133_FILE), 'utf8').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(text, /\bCREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|VIEW|TABLE|POLICY)\b/i);
  assert.doesNotMatch(text, /\b(DROP|ALTER)\b/);
  assert.equal([...text.matchAll(/\bCREATE\s+OR\s+REPLACE\s+FUNCTION\b/gi)].length, 1);
  assert.equal([...text.matchAll(/\bDO\s+\$/g)].length, 1);
  assert.deepEqual([...text.matchAll(/^\s*(GRANT|REVOKE)\b.*$/gim)].map((m) => m[0].trim()), [
    `REVOKE ALL ON FUNCTION ${IDENTITY} FROM PUBLIC;`,
    `GRANT EXECUTE ON FUNCTION ${IDENTITY} TO checksops;`,
  ]);
  assert.doesNotMatch(text, /financial_totp_(upsert_enrollment|get_enrollment|mark_verified|status|count_code_check)\b/);
  assert.doesNotMatch(text, /consume_financial_totp_rate_limit/);
  assert.match(text, /RAISE EXCEPTION 'platform_owner_protected'/);
  assert.match(text, /RAISE EXCEPTION 'cannot_reset_own_totp'/);
  assert.match(text, /RAISE EXCEPTION 'reset_target_not_teammate'/);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* staging pin execute-authorized \(wave 30\)/);
  assert.match(runbook, /read-live \(2026-10-30\)\.\*\* Run 41129536538/);
  assert.match(runbook, /\*\*Predecessor\.\*\* None/);
  assert.match(runbook, /"ok build the reset\s+after SQL 131 and the lockout fix"/);
  assert.match(runbook, /APPLY_FINANCIAL_TOTP_ADMIN_RESET/);
  assert.match(runbook, /No self-service reset/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql133` \|/);
  assert.match(oneShot, /`sql130`, `sql131`, `sql132`, `sql133`, `sql134`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql133-financial-totp-admin-reset-enrollment-production-apply\.mjs --inspect/);
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
  assert.equal(allowed.details.sql133_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY_FINANCIAL_TOTP_LOCKOUT' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed (pending) pin, read from disk, refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql133-cli-${process.pid}.json`);
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
