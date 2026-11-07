/**
 * Production tool for SQL 146 (scripts/deployment-guard/sql146-moov-status-catch-up-writes-production-apply.mjs on
 * lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 146 included) through the
 * shared refusals; this file covers SQL 146's own:
 *
 *   - the pin has the release pin shape; it is execute-authorized (owner-approved pin change of 2026-11-07)
 *     with the recorded production pre-state (read-only inspect; the derived one, the same one staging had) and
 *     the staging apply as its acceptance; it is in step with the staging pin, the one-shot, the bypass inventory
 *     and the test lists;
 *   - no predecessor; the two new DEFINER functions (EXECUTE for checksops and the owner; PUBLIC, anon,
 *     authenticated and service_role revoked, RETURNS jsonb), the prerequisites (the payment transfer and
 *     obligation columns, is_platform_owner(), SQL 91's webhook apply helper, auth.uid(), role checksops), the
 *     two definer relations; no table, view, policy, trigger or drop, and no grant but the REVOKEs and the GRANTs
 *     to checksops on these two functions; the runbook, one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; the committed pin allows only the manifest
 *     bound to its recorded pre-state; an approved, accepted copy evaluates for the manifest built from it, and refuses with execute false, another live hash, another staging
 *     reference or a wrong phrase; the CLI spends no receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql146-moov-status-catch-up-writes-pg.test.mjs; the executor path is
 * aws/tests/release-sql146-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql146-moov-status-catch-up-writes-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql146';
const SQL146_FILE = 'aws/workflows/sql/146_moov_status_catch_up_writes.sql';
const LOCK_IDENTITY = 'public.aws_moov_catch_up_lock_rows(text, text, uuid[])';
const LEG_IDENTITY = 'public.aws_moov_apply_collection_leg_status(text, text, bigint, text, text, text, timestamp with time zone)';
const IDENTITIES = Object.freeze([LOCK_IDENTITY, LEG_IDENTITY]);
const RELATIONS = Object.freeze(['public.payment_transfers', 'public.tenant_maintenance_payments']);
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
// The derived pre-state (both functions absent; derived by release-sql146-executor.test.mjs).
const ABSENT_PRE = '1ef789645da5ce865cbb095bea1eff6775a4bedc87251e8152f41a771e659c40';
// SQL 146's recorded production pre-state (read-only inspect of 2026-11-07, SSM df96f4d3, main 73610863c): both
// functions absent, the derived pre-state; staging recorded the same (read-live runs 42403055167, 42405651492).
const PRODUCTION_PRE = ABSENT_PRE;
// The guarded staging apply (wave 41).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/42405866540';
const OWNER_WORDS = Object.freeze(['"build the catch-up update fix"', '"record the SQL 146 staging pin"', '"apply SQL 146 in staging"', '"SQL 146 accepted in staging"', '"run the read-only SQL 146 production inspect"', '"record the SQL 146 production pin"']);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql146-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-11-07T00:00:00.000Z',
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
  // Owner-approved pin change of 2026-11-07: the read-only production inspect (SSM df96f4d3, main 73610863c)
  // recorded as the pre-state; the staging apply (run 42405866540) as the acceptance. The owner's words for the pin
  // name the staging steps, the inspect and this pin: the production apply still needs the owner's words for that run.
  assert.equal(pin.execute, true);
  assert.match(pin.authorization, /^Owner approved 2026-11-07 /);
  for (const words of OWNER_WORDS) assert.ok(pin.authorization.includes(words), words);
  assert.match(pin.authorization, /none of them words for the production apply/);
  assert.ok(pin.authorization.includes(`${PRODUCTION_PRE} -> ${pin.intended_replacement_sha256}`));
  assert.match(pin.authorization, /execute true takes effect only when the owner reviews and merges this change\. It does not itself run or approve a run/);
  assert.match(pin.authorization, /each apply still needs the owner's run-time approval/);
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied, undefined);
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-11-07');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, 'df96f4d3-ef1c-4a02-9684-19bfaac45101');
  assert.equal(pin.production_inspect.source_commit, '73610863c4ab6e18f8b2828b0cb4b0a60e22402d');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('b0972af991125891631b907fa7bad83103c713d743b16001ccef96c01c09fa7f'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.match(pin.production_inspect.note, /both functions absent/);
  assert.match(pin.production_inspect.note, /definer_writes ok true on both relations \(payment_transfers, tenant_maintenance_payments\)/);
  assert.match(pin.production_inspect.note, /prerequisites_missing \[\], missing_dependencies \[\], predecessors \{\} \(none\)/);
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no release-engine production inspect has been run for SQL 146 yet.'));
  assert.match(pin.production_inspect.note, /prerequisites_missing/);
  assert.match(pin.production_inspect.note, /definer_can_write_relations/);
  assert.match(pin.production_inspect.note, /functions_owned_by_login/);
  assert.match(pin.production_inspect.note, /function_results_match/);
  assert.match(pin.production_inspect.note, /function_acl_replaceable/);
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql146-moov-status-catch-up-writes, run 42405866540/);
  assert.match(pin.staging_acceptance.basis, /deploy run 42405240604/);
  assert.match(pin.staging_acceptance.basis, /Read-live run 42406066179 then reported already_applied true/);
  assert.match(pin.staging_acceptance.basis, /under the owner's words "apply SQL 146 in staging"/);
  assert.match(pin.staging_acceptance.basis, /"SQL 146 accepted in staging"/);
  assert.ok(pin.staging_acceptance.basis.includes(`before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // The staging pin recorded the same pre-state (wave 41).
  assert.equal(staging.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.equal(pin.filename, SQL146_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL146_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, [...IDENTITIES]);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_MOOV_STATUS_CATCH_UP_WRITES');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql146-moov-status-catch-up-writes-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-146-apply.md');
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
  assert.equal(tool.allowed_key, 'sql146_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(RELEASE_SQL_SPECS[KEY].runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql146-moov-status-catch-up-writes-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql146-production-apply"\]/);
  assert.match(rows, /sql144, sql145, sql146\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql146-executor.test.mjs', 'aws/tests/release-sql146-production-apply.test.mjs', 'aws/tests/sql146-moov-status-catch-up-writes-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; the two new DEFINER functions, their prerequisites and the two definer relations; the REVOKEs and the GRANTs to checksops, nothing else; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.supersedes, undefined);
  assert.deepEqual(spec.functions.map((fn) => fn.identity), [...IDENTITIES]);
  for (const fn of spec.functions) {
    assert.deepEqual(fn.acl, ['checksops EXECUTE', 'owner EXECUTE'], fn.identity);
    assert.deepEqual(fn.revokes, ['PUBLIC EXECUTE', 'anon EXECUTE', 'authenticated EXECUTE', 'service_role EXECUTE'], fn.identity);
    assert.equal(fn.result, undefined, fn.identity);
  }
  assert.equal(spec.dropped_functions, undefined);
  assert.equal(spec.acl_functions, undefined);
  assert.deepEqual(spec.prerequisites.slice(0, 6), ['public.payment_transfers', 'public.tenant_maintenance_payments', 'public.is_platform_owner()',
    'public.aws_moov_webhook_apply_active()', 'auth.uid()', 'role checksops']);
  for (const column of ['payment_transfers.provider_transfer_id', 'payment_transfers.leg_role', 'payment_transfers.provider_metadata',
    'payment_transfers.amount_cents', 'payment_transfers.completed_at', 'tenant_maintenance_payments.status']) {
    assert.ok(spec.prerequisites.includes(`column public.${column}`), column);
  }
  assert.deepEqual(spec.definer_writes, [...RELATIONS]);
  for (const absent of ['tables', 'views', 'policies', 'triggers', 'altered_relations']) assert.equal(spec[absent], undefined, absent);
  assert.match(COMMITTED.order_note, /^No predecessor: SQL 146 creates two new SECURITY DEFINER functions/);
  assert.match(COMMITTED.order_note, /definer_can_write_relations/);
  assert.match(COMMITTED.order_note, /SQL 91's aws_moov_webhook_apply_active\(\)/);
  assert.match(COMMITTED.order_note, /No API, Lambda or SPA change is part of this pin\./);
  // One prerequisite DO block, two CREATE OR REPLACE FUNCTIONs, one REVOKE DO block; the REVOKEs from PUBLIC and the
  // GRANTs to checksops on them; nothing else. The only write is the leg writer's UPDATE; the lock only locks.
  const text = fs.readFileSync(path.join(ROOT, SQL146_FILE), 'utf8').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(text, /\bCREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|VIEW|TABLE|POLICY)\b/i);
  assert.doesNotMatch(text, /\b(DROP|ALTER)\b/);
  assert.deepEqual([...text.matchAll(/\b(INSERT\s+INTO\s+\S+|UPDATE\s+public\.\S+|DELETE|TRUNCATE)\b/g)].map((m) => m[0]),
    ['UPDATE public.payment_transfers']);
  assert.equal([...text.matchAll(/\bFOR UPDATE\b/g)].length, 3);
  assert.equal([...text.matchAll(/\bCREATE\s+OR\s+REPLACE\s+FUNCTION\b/gi)].length, 2);
  assert.equal([...text.matchAll(/\bDO\s+\$/g)].length, 2);
  const signature = (identity) => identity.replace('timestamp with time zone', 'timestamptz');
  assert.deepEqual([...text.matchAll(/^\s*(GRANT|REVOKE)\b.*$/gim)].map((m) => m[0].trim()), [
    ...IDENTITIES.map((identity) => `REVOKE ALL ON FUNCTION ${signature(identity)} FROM PUBLIC;`),
    ...IDENTITIES.map((identity) => `GRANT EXECUTE ON FUNCTION ${signature(identity)} TO checksops;`),
  ]);
  for (const identity of IDENTITIES) {
    assert.ok(text.includes(`EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ${signature(identity)} FROM %I', v_role);`), identity);
  }
  assert.match(text, /FOREACH v_role IN ARRAY ARRAY\['anon', 'authenticated', 'service_role'\] LOOP/);
  for (const refusal of ['moov_catch_up_webhook_apply_required', 'moov_catch_up_forbidden', 'moov_collection_leg_webhook_apply_required', 'moov_collection_leg_forbidden']) {
    assert.match(text, new RegExp(`RAISE EXCEPTION '${refusal}'\\s+USING ERRCODE = '42501'`), refusal);
  }
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* applied in staging \(wave 41, 2026-11-07\); staging acceptance: owner \("SQL 146 accepted in staging"\); production pin execute-authorized; not applied to production/);
  assert.match(runbook, /SSM\s+`df96f4d3-ef1c-4a02-9684-19bfaac45101`/);
  assert.match(runbook, /\*\*Staging apply \(2026-11-07\)\.\*\* Apply run 42405866540/);
  assert.match(runbook, /Read-live run 42406066179/);
  assert.match(runbook, /"SQL 146 accepted in staging"/);
  assert.match(runbook, /\*\*Predecessor\.\*\* None/);
  assert.match(runbook, /Owner\s+2026-11-07: "build the catch-up update fix"/);
  for (const evidence of ['42395703811', '42395949680', '236f3dd28e0e108219f75e566acbac4bb60a80ddfb8e673b1df0c6422c8b2331', 'catch_up_state_changed_since_plan']) {
    assert.ok(runbook.includes(evidence), evidence);
  }
  assert.match(runbook, /APPLY_MOOV_STATUS_CATCH_UP_WRITES/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql146` \|/);
  assert.match(oneShot, /`sql144`, `sql145`, `sql146`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql146-moov-status-catch-up-writes-production-apply\.mjs --inspect/);
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
  assert.equal(committedOk.details.sql146_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(COMMITTED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(COMMITTED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql146_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY_TENANT_INCOMING_TRANSFERS' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql146-cli-${process.pid}.json`);
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
