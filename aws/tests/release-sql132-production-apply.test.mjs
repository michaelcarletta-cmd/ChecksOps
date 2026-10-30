/**
 * Production tool for SQL 132 (scripts/deployment-guard/sql132-financial-totp-code-check-lockout-
 * production-apply.mjs on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 132 included) through the
 * shared refusals; this file covers SQL 132's own:
 *
 *   - the pin has the release pin shape; it is execute-authorized (owner-approved pin change of
 *     2026-10-30) with the recorded production pre-state (derived from the spec in
 *     release-sql132-executor.test.mjs; the same one staging had) and the staging apply as its
 *     acceptance; it is in step with the staging pin, the one-shot, the bypass inventory and the test lists;
 *   - predecessor SQL 130 (applied and retired, untouched here); the one new function (EXECUTE for
 *     checksops and the owner, PUBLIC revoked), the prerequisites (the enrollment table and its
 *     columns, mark_verified, auth.uid(), role checksops), the definer write; no table, view, policy,
 *     trigger or drop, and no grant but the REVOKE from PUBLIC and the GRANT to checksops on this one
 *     function; no plan entry; the API calls the function the same way in both members and checks
 *     for it first; the runbook, one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; the committed pin allows only
 *     the manifest bound to its recorded pre-state; an approved, accepted copy evaluates for the
 *     manifest built from it, and refuses with execute false, another live hash, another staging
 *     reference or a wrong phrase; the CLI spends no receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql132-financial-totp-lockout-pg.test.mjs; the
 * executor path is aws/tests/release-sql132-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql132-financial-totp-code-check-lockout-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql132';
const SQL132_FILE = 'aws/workflows/sql/132_financial_totp_code_check_lockout.sql';
const IDENTITY = 'public.financial_totp_count_code_check(uuid)';
const TABLE = 'public.financial_totp_enrollments';
const SQL132_IDENTITIES = Object.freeze([IDENTITY]);
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// SQL 132's recorded production pre-state (read-only inspect of 2026-10-30, SSM ea2ce576, main 42068df3f):
// the function absent, everything else in place; staging recorded the same pre-state (read-live run 41113777003).
const PRODUCTION_PRE = 'e1a1d4edb115e3fa0881112e6759c2d7ee1e9d8c6b3e24a7611b655dcf75741f';
// The guarded staging apply (wave 29).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/41117004966';
const OWNER_WORDS = Object.freeze(['"restart SQL 131 and the lockout fix"', '"Merge SQL 131 and the lockout fix when green"', '"continue with SQL 132 staging"', '"merge 1461 when green"', '"apply SQL 132 in staging"']);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql132-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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

test('pin: the release pin shape, execute-authorized on the staging apply, in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Owner-approved pin change of 2026-10-30: the read-only production inspect (SSM ea2ce576, main 42068df3f)
  // recorded as the pre-state; the staging apply (run 41117004966) as the acceptance. The owner's words so far
  // name the restart, the merges and the staging step: the production apply still needs the owner's words for that run.
  assert.equal(pin.execute, true);
  assert.match(pin.authorization, /^Owner approved 2026-10-30 /);
  for (const words of OWNER_WORDS) assert.ok(pin.authorization.includes(words), words);
  assert.match(pin.authorization, /none of them words for the production apply/);
  assert.ok(pin.authorization.includes(`${PRODUCTION_PRE} -> ${pin.intended_replacement_sha256}`));
  assert.match(pin.authorization, /execute true takes effect only when the owner reviews and merges this change\. It does not itself run or approve a run/);
  assert.match(pin.authorization, /each apply still needs the owner's run-time approval/);
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied, undefined);
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-10-30');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, 'ea2ce576-471a-4a90-bb50-e52b3430e6ec');
  assert.equal(pin.production_inspect.source_commit, '42068df3f516653ebb96cffbf4d522f0117db4ac');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('4000d070b6f33d354b8a102fc08319ddcc624e8acf73ab07f9ce1c54247b6e33'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.match(pin.production_inspect.note, /financial_totp_count_code_check\(uuid\) absent, function_acl \[\]; definer_writes financial_totp_enrollments ok true/);
  assert.match(pin.production_inspect.note, /predecessors \{sql130: true\}, predecessors_applied true/);
  assert.match(pin.production_inspect.note, /dropped_function_dependents 0, dropped_function_callers \[\]/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: '));
  assert.match(pin.production_inspect.note, /SSM cfee4512-4988-4fd1-be77-b03d1b4cd50b/);
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql132-financial-totp-code-check-lockout, run 41117004966/);
  assert.match(pin.staging_acceptance.basis, /deploy run 41116686272/);
  assert.match(pin.staging_acceptance.basis, /Read-live run 41117375887 then reported already_applied true/);
  assert.ok(pin.staging_acceptance.basis.includes(`receipt before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // The staging pin recorded the same pre-state (wave 29): the function absent in both environments.
  assert.equal(staging.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.equal(pin.filename, SQL132_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL132_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, SQL132_IDENTITIES);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, ['sql130']);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_FINANCIAL_TOTP_LOCKOUT');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql132-financial-totp-code-check-lockout-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-132-apply.md');
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
  assert.equal(tool.allowed_key, 'sql132_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(RELEASE_SQL_SPECS[KEY].runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql132-financial-totp-code-check-lockout-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql132-production-apply"\]/);
  assert.match(rows, /sql128, sql129, sql130, sql131, sql132\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql132-executor.test.mjs', 'aws/tests/release-sql132-production-apply.test.mjs', 'aws/tests/sql132-financial-totp-lockout-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: predecessor SQL 130 (untouched); the one new function, its prerequisites and definer write; REVOKE from PUBLIC and GRANT to checksops, nothing else; no plan entry; the API calls it the same way in both members and checks for it first; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, ['sql130']);
  assert.equal(spec.supersedes, undefined);
  assert.deepEqual(spec.functions.map((fn) => fn.identity), SQL132_IDENTITIES);
  for (const fn of spec.functions) {
    assert.deepEqual(fn.acl, ['checksops EXECUTE', 'owner EXECUTE'], fn.identity);
    assert.deepEqual(fn.revokes, ['PUBLIC EXECUTE'], fn.identity);
    assert.equal(fn.result, 'TABLE(allowed boolean, failed_attempts integer, retry_after_seconds integer)');
  }
  assert.equal(spec.dropped_functions, undefined);
  assert.equal(spec.acl_functions, undefined);
  assert.deepEqual(spec.prerequisites.slice(0, 4), [TABLE, 'public.financial_totp_mark_verified(uuid, bigint)', 'auth.uid()', 'role checksops']);
  for (const column of ['application_user_id', 'failed_attempts', 'locked_until']) {
    assert.ok(spec.prerequisites.includes(`column ${TABLE}.${column}`), column);
  }
  assert.deepEqual(spec.definer_writes, [TABLE]);
  for (const absent of ['tables', 'views', 'policies', 'triggers', 'altered_relations']) assert.equal(spec[absent], undefined, absent);
  assert.match(COMMITTED.order_note, /^Predecessor SQL 130 \(applied to staging and production on 2026-10-30\)/);
  assert.match(COMMITTED.order_note, /definer_can_write_relations/);
  assert.match(COMMITTED.order_note, /tolerates its absence \(no count, no lockout, never a 500\)/);
  assert.match(COMMITTED.order_note, /no API, Lambda or SPA change is part of this pin\./);
  // SQL 130's production pin is as applied and retired; this change does not touch it.
  const sql130 = loadReleaseProductionPin('sql130', ROOT);
  assert.equal(sql130.execute, false);
  assert.equal(sql130.applied.result, 'applied');
  // The API members that call the function pend their REPLACE on this pin: auth-financial-totp.mjs has
  // sql_before SQL 132, recorded in the overlay plan as not yet verified live, so the guarded Lambda path
  // refuses it until the record change; checkalt-register.mjs keeps SQL 81, its recorded dependency.
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.deepEqual(plan.sql_prerequisites[SQL132_FILE], { verified_live: false, evidence: null });
  assert.equal(plan.members['auth-financial-totp.mjs'].sql_before, SQL132_FILE);
  assert.equal(plan.members['providers/production/checkalt-register.mjs'].sql_before, 'aws/workflows/sql/81_checkalt_production_register.sql');
  for (const member of ['auth-financial-totp.mjs', 'providers/production/checkalt-register.mjs']) {
    assert.notEqual(plan.members[member].expected_live_sha256, plan.members[member].accepted_sha256, `${member} pends the lockout REPLACE`);
  }
  // The API: the same count call and the same existence check in both members, as checksops.
  const call = 'SELECT allowed, failed_attempts, retry_after_seconds FROM public.financial_totp_count_code_check($1::uuid)';
  const presentCall = 'SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS present';
  const totp = fs.readFileSync(path.join(ROOT, 'aws/functions/api/auth-financial-totp.mjs'), 'utf8');
  const checkalt = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/production/checkalt-register.mjs'), 'utf8');
  for (const api of [totp, checkalt]) {
    assert.ok(api.includes(call));
    assert.ok(api.includes(presentCall));
    assert.ok(api.includes(`'${IDENTITY}'`));
  }
  assert.match(totp, /export const countCodeCheck = async \(client, userId\) => \{/);
  assert.doesNotMatch(totp, /error: 'rate_limited', \.\.\.financialGate\(\) \}/, 'a locked enrollment no longer answers differently from a wrong code');
  // One DO block, one CREATE OR REPLACE FUNCTION, the REVOKE from PUBLIC and the GRANT to checksops on it; nothing else.
  const text = fs.readFileSync(path.join(ROOT, SQL132_FILE), 'utf8').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(text, /\bCREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|VIEW|TABLE|POLICY)\b/i);
  assert.doesNotMatch(text, /\b(DROP|ALTER)\b/);
  assert.equal([...text.matchAll(/\bCREATE\s+OR\s+REPLACE\s+FUNCTION\b/gi)].length, 1);
  assert.equal([...text.matchAll(/\bDO\s+\$/g)].length, 1);
  assert.deepEqual([...text.matchAll(/^\s*(GRANT|REVOKE)\b.*$/gim)].map((m) => m[0].trim()), [
    `REVOKE ALL ON FUNCTION ${IDENTITY} FROM PUBLIC;`,
    `GRANT EXECUTE ON FUNCTION ${IDENTITY} TO checksops;`,
  ]);
  assert.doesNotMatch(text, /financial_totp_(upsert_enrollment|get_enrollment|status)\b/);
  assert.doesNotMatch(text, /consume_financial_totp_rate_limit/);
  assert.match(text, /WHEN e\.failed_attempts \+ 1 >= 10 THEN v_now \+ interval '15 minutes'/);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* applied to staging \(wave 29\); production pin execute-authorized; not applied to production/);
  assert.match(runbook, /SSM\s+`ea2ce576-471a-4a90-bb50-e52b3430e6ec`/);
  assert.match(runbook, /Staging apply \(2026-10-30\)\.\*\* Run 41117004966/);
  assert.match(runbook, /read-live \(2026-10-30\)\.\*\* Run 41113777003/);
  assert.match(runbook, /\*\*Predecessor\.\*\* SQL 130/);
  assert.match(runbook, /"restart SQL 131 and the\s+lockout fix"/);
  assert.match(runbook, /APPLY_FINANCIAL_TOTP_LOCKOUT/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql132` \|/);
  assert.match(oneShot, /`sql129`, `sql130`, `sql131`, `sql132`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql132-financial-totp-code-check-lockout-production-apply\.mjs --inspect/);
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

  // The committed (authorized) pin allows only the manifest bound to its recorded pre-state: not
  // another hash, not the intended state.
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql132_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(COMMITTED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(COMMITTED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql132_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY_FINANCIAL_TOTP_RATE_LIMIT_CODE_CHECK_NO_PUBLIC' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql132-cli-${process.pid}.json`);
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
