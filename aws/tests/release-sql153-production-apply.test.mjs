/**
 * Production tool for SQL 153 (scripts/deployment-guard/sql153-second-mortgagee-fee-production-apply.mjs on
 * lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs). Owner 2026-11-10/11: the flat $5 for a
 * check's 2nd mortgage company; tooling "Option B".
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 153 included) through the shared refusals;
 * this file covers SQL 153's own:
 *
 *   - the pin has the release pin shape; it is execute-authorized (owner-approved pin change of 2026-11-11) with the
 *     recorded production pre-state (read-only inspect; the derived one, the same one staging had) and the staging apply
 *     as its acceptance; it is in step with the staging pin, the one-shot, the bypass inventory and the test lists;
 *   - no predecessor; the index and the two columns, no function; the file's event_type CHECK step not modelled and
 *     required absent (no_event_type_check, also a production precondition); no table, policy, trigger or grant; no
 *     overlay plan entry; the runbook, one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; the committed pin allows only the manifest bound
 *     to its recorded pre-state; an approved, accepted copy evaluates for the manifest built from it,
 *     and refuses with execute false, another live hash, another staging reference or a wrong phrase; the CLI spends no
 *     receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql153-second-mortgagee-fee-pg.test.mjs; the executor path is
 * aws/tests/release-sql153-executor.test.mjs.
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
  releaseProductionPreconditionFailures,
  readPinnedReleaseSql,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { main } from '../../scripts/deployment-guard/sql153-second-mortgagee-fee-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql153';
const SQL153_FILE = 'aws/workflows/sql/153_second_mortgagee_fee.sql';
const INDEX = 'check_billing_events_one_second_mortgagee_per_check';
const COLUMNS = Object.freeze(['mortgage_ops_second_mortgagee_count', 'mortgage_ops_second_mortgagee_amount_cents']);
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
// SQL 153's recorded production pre-state (read-only inspect of 2026-11-11, SSM decbb3ce, main 103060468): the index and
// both columns absent, the derived pre-state; staging recorded the same (read-live run 43115484335).
const PRODUCTION_PRE = 'b2bf6d325a5a50683acc8ecdaef39ec763b591f8db9f10e7d6fe02f9525cb0c3';
// The guarded staging apply (wave 49).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43119289402';
// The owner's words for SQL 153, quoted in the authorization (no separate staging acceptance statement was given).
const OWNER_WORDS = Object.freeze(['"Yes pick up both 2 and 3"', '"Option B"', '"merge 1790 when green"', '"redeploy the staging SQL executor, then run the SQL 153 staging read-live"', '"record the SQL 153 staging pin"', '"merge it when green"', '"apply SQL 153 in staging"', '"the read-only SQL 153 production inspect"', '"record the SQL 153 production pin"']);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql153-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-11-11T00:00:00.000Z',
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
  // Owner-approved pin change of 2026-11-11: the read-only production inspect (SSM decbb3ce, main 103060468) recorded as
  // the pre-state; the staging apply (run 43119289402) as the acceptance.
  assert.equal(pin.execute, true);
  assert.match(pin.authorization, /^Owner approved 2026-11-11 /);
  for (const words of OWNER_WORDS) assert.ok(pin.authorization.includes(words), words);
  assert.match(pin.authorization, /no separate staging acceptance statement was given/);
  assert.ok(pin.authorization.includes(`${PRODUCTION_PRE} -> ${pin.intended_replacement_sha256}`));
  assert.match(pin.authorization, /execute true takes effect only when the owner reviews and merges this change\. It does not itself run or approve a run/);
  assert.match(pin.authorization, /each apply still needs the owner's run-time approval/);
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, releaseStateHash(KEY, {}));
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied, undefined);
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-11-11');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, 'decbb3ce-3b38-49ec-ae6f-ea07d39de7ba');
  assert.equal(pin.production_inspect.source_commit, '103060468654d5a413df67d847e46c3880cc4b74');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('501cd3dc3c1d5fb9c3cfff6d5dc11deae2690a4808227f41f94935372aef8268'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.match(pin.production_inspect.note, /already_applied false\), live_matches_expected false, precondition_failures \[\], apply_preconditions_met false, errors \[\]/);
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no release-engine production inspect has been run for SQL 153 yet.'));
  for (const text of ['prerequisites_missing', 'counts.event_type_checks 0', 'no_event_type_check', 'already_applied false', 'precondition_failures', releaseStateHash(KEY, {})]) {
    assert.ok(pin.production_inspect.note.includes(text), text);
  }
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql153-second-mortgagee-fee, run 43119289402/);
  assert.match(pin.staging_acceptance.basis, /deploy run 43118921219/);
  assert.match(pin.staging_acceptance.basis, /Read-live run 43119679139 \(job 130856648244\) then reported already_applied true/);
  assert.match(pin.staging_acceptance.basis, /under the owner's words "apply SQL 153 in staging"/);
  assert.match(pin.staging_acceptance.basis, /no separate staging acceptance statement was given/);
  assert.ok(pin.staging_acceptance.basis.includes(`before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // The staging pin recorded the same pre-state (wave 49).
  assert.equal(staging.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.filename, SQL153_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL153_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, []);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'CHARGE_SECOND_MORTGAGEE_FEE');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql153-second-mortgagee-fee-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-153-apply.md');
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
  assert.equal(tool.allowed_key, 'sql153_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql153-second-mortgagee-fee-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql153-production-apply"\]/);
  assert.match(rows, /sql150, sql152, sql153, sql154, sql155, sql156\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql153-executor.test.mjs', 'aws/tests/release-sql153-production-apply.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
  // As for SQL 154's: sql153-second-mortgagee-fee-pg.test.mjs imports the billing engine and the fee invoice email, which
  // need the API's dependencies (@aws-sdk/client-ses), and the deployment-guard job installs only pg; it runs in the full
  // suite (aws-migration-guards), which installs them.
  for (const text of [scripts['test:deployment-guard'], workflow]) assert.ok(!text.includes('sql153-second-mortgagee-fee-pg.test.mjs'));
});

test('order: no predecessor; the index and two columns, no function; the event_type CHECK step not modelled and required absent; no overlay plan entry; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.production_only, undefined);
  assert.equal(spec.production_noop, undefined);
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.indexes.map((i) => [i.table, i.name]), [['public.check_billing_events', INDEX]]);
  assert.deepEqual(spec.added_columns.map((c) => [c.table, c.column]), COLUMNS.map((c) => ['public.tenant_maintenance_payments', c]));
  assert.deepEqual(spec.extra_preconditions, ['no_event_type_check']);
  assert.deepEqual(Object.keys(spec.counts), ['event_type_checks']);
  for (const absent of ['tables', 'views', 'policies', 'table_privileges', 'column_acl', 'dropped_functions', 'acl_functions', 'constraints', 'triggers', 'definer_writes']) assert.equal(spec[absent], undefined, absent);
  // SQL 84's per-check index is not a prerequisite (production's is check_billing_events_mortgage_ops_check_uidx).
  assert.ok(!spec.prerequisites.some((name) => /mortgage_ops_per_check|mortgage_ops_check_uidx/.test(name)));
  assert.match(COMMITTED.order_note, /^No predecessor\. SQL 153 records the flat \$5 for a check's 2nd mortgage company/);
  for (const text of ['"Flat $5"', '"Option B"', 'is NOT modelled by the release engine', 'no_event_type_check', 'event_type_checks',
    'Step 1 is therefore a no-op on every database this tooling applies to', 'check_billing_events_mortgage_ops_check_uidx',
    'altered_relations_owned_by_login', 'no API, Lambda or SPA change is part of this pin', releaseStateHash(KEY, {})]) {
    assert.ok(COMMITTED.order_note.includes(text), text);
  }
  assert.match(COMMITTED.intended_post_state.note, /No CHECK on check_billing_events\.event_type before or after \(step 1 not modelled; required absent\)/);
  // No API member waits on SQL 153 yet.
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.equal(plan.sql_prerequisites?.[SQL153_FILE], undefined);
  // The file: three DO blocks (prerequisites, the event_type CHECK, the index), the index comment, one ALTER TABLE of
  // tenant_maintenance_payments and its two column comments; no function, policy, grant, trigger or row write.
  const text = fs.readFileSync(path.join(ROOT, SQL153_FILE), 'utf8').replace(/--[^\n]*/g, '');
  const outside = text.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$');
  assert.deepEqual([...outside.matchAll(/\bDO\s+\$/g)].length, 3);
  assert.deepEqual([...outside.matchAll(/^\s*ALTER TABLE\s+(\S+)/gim)].map((m) => m[1]), ['public.tenant_maintenance_payments']);
  assert.deepEqual([...outside.matchAll(/^\s*COMMENT ON (\w+) (\S+)/gim)].map((m) => `${m[1]} ${m[2]}`), [
    `INDEX public.${INDEX}`, `COLUMN public.tenant_maintenance_payments.${COLUMNS[0]}`, `COLUMN public.tenant_maintenance_payments.${COLUMNS[1]}`,
  ]);
  assert.doesNotMatch(outside, /\bCREATE\s+(OR\s+REPLACE\s+)?(TABLE|POLICY|VIEW|TRIGGER|FUNCTION)\b|\bGRANT\b|\bREVOKE\b|\bDROP\b/i);
  assert.doesNotMatch(outside, /\b(TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+public\.)/i);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  for (const value of [COMMITTED.intended_replacement_sha256, COMMITTED.source_sha256, releaseStateHash(KEY, {}), 'CHARGE_SECOND_MORTGAGEE_FEE', '#1761',
    'no_event_type_check', 'Step 1, **not modelled by the release engine.**', 'step 1 is therefore a no-op']) {
    assert.ok(runbook.includes(value), value);
  }
  assert.match(runbook, /\*\*Status:\*\* applied in staging \(wave 49, 2026-11-11\); staging acceptance: the staging apply under the owner's run approval \("apply SQL 153 in staging"; no separate acceptance statement\); production pin execute-authorized; not applied to production/);
  assert.match(runbook, /SSM\s+`decbb3ce-3b38-49ec-ae6f-ea07d39de7ba`/);
  assert.match(runbook, /\*\*Staging apply \(2026-11-11\)\.\*\* Apply run 43119289402/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql153` \|/);
  assert.match(oneShot, /`sql152`, `sql153`, `sql154`, `sql155`, `sql156`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql153-second-mortgagee-fee-production-apply\.mjs --inspect/);
});

test('production preconditions: the pinned login and no_event_type_check; a CHECK on event_type refuses before any apply', () => {
  const text = fs.readFileSync(path.join(ROOT, SQL153_FILE), 'utf8');
  const state = (counts) => ({
    current_user: 'checksops_admin', session_user: 'checksops_admin',
    prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], dependents: {}, functions: {},
    altered: { 'public.check_billing_events': { exists: true, owner_is_login: true }, 'public.tenant_maintenance_payments': { exists: true, owner_is_login: true } },
    counts,
  });
  assert.deepEqual(releaseProductionPreconditionFailures(KEY, state({ event_type_checks: 0 }), COMMITTED, text), []);
  assert.deepEqual(releaseProductionPreconditionFailures(KEY, state({ event_type_checks: 1 }), COMMITTED, text), ['no_event_type_check']);
  assert.deepEqual(releaseProductionPreconditionFailures(KEY, state({ event_type_checks: null }), COMMITTED, text), ['no_event_type_check']);
  assert.deepEqual(releaseProductionPreconditionFailures(KEY, { ...state({ event_type_checks: 0 }), session_user: 'checksops' }, COMMITTED, text), ['login_is_pinned_admin']);
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
  assert.equal(committedOk.details.sql153_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(COMMITTED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(COMMITTED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql153_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // SQL 156's phrase does not authorize SQL 153.
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'SHARE_CHECK_LIBRARY_WITH_MORTGAGE_DESK' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql153-cli-${process.pid}.json`);
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
