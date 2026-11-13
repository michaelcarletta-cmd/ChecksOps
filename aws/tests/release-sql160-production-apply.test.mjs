/**
 * Production tool for SQL 160 (scripts/deployment-guard/sql160-no-additional-check-or-manual-deposit-fee-production-apply.mjs
 * on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs). Owner 2026-11-12: no Mortgage Ops charge,
 * agent pay or $5 mortgage_handling event for an additional check on a claim, and no $4 for a check deposited outside
 * ChecksOps ("start SQL 160 yes"). release-sql90-97-production-apply.test.mjs runs every release key (SQL 160 included)
 * through the shared refusals; this file covers SQL 160's own:
 *
 *   - the pin has the release pin shape; it is execute-authorized (owner-approved pin change of 2026-11-13) with the
 *     recorded production pre-state (read-only inspect SSM 4a5e9028; the derived inspected-bodies state) and the staging
 *     apply from the same pre-state (run 43353383753) as its acceptance; it is in step with the staging pin, the one-shot,
 *     the bypass inventory and the test lists;
 *   - no predecessor; four existing live functions replaced in place with their observed grants (revokes []), nothing
 *     created; no table, policy, trigger or grant change; no overlay plan entry; the runbook, one-shot doc and README
 *     name it;
 *   - the pending (pre-authorization) pin refuses before connecting; the committed pin allows only the manifest bound
 *     to its recorded pre-state; an approved, accepted copy evaluates for the manifest built from it,
 *     and refuses with execute false, another live hash, another staging reference or a wrong phrase; the CLI spends no
 *     receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql160-billing-additional-check-pg.test.mjs; the executor path is
 * aws/tests/release-sql160-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql160-no-additional-check-or-manual-deposit-fee-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql160';
const SQL160_FILE = 'aws/workflows/sql/160_no_additional_check_mortgage_charge_or_manual_deposit_fee.sql';
const FIXTURE = 'aws/tests/fixtures/sql160-live-billing-functions-2026-11-12.sql';
const IDENTITIES = Object.freeze([
  'public.record_check_billing_event()',
  'public.accrue_mortgage_ops_billing(uuid)',
  'public.earn_mortgage_agent_compensation(uuid)',
  'public.tg_record_mortgage_handling_billing()',
]);
const ACLS = Object.freeze([
  ['checksops EXECUTE', 'owner EXECUTE'],
  ['PUBLIC EXECUTE', 'authenticated EXECUTE', 'checksops EXECUTE', 'owner EXECUTE'],
  ['owner EXECUTE'],
  ['PUBLIC EXECUTE', 'checksops EXECUTE', 'owner EXECUTE'],
]);
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
/** The derived production pre-state: the fixture's inspected bodies with the observed attributes. */
const LIVE_PRE = releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, FIXTURE), 'utf8'));
// SQL 160's recorded production pre-state (read-only inspect of 2026-11-13, SSM 4a5e9028, main 2e2076d49): the four functions
// with the inspected bodies, the derived pre-state.
const PRODUCTION_PRE = '3a8bb0b11d59688642c98ace91bb15c562c362eea00b2ae9c73a166fee365229';
// The guarded staging apply from the same pre-state.
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43353383753';
// The owner's words for SQL 160, quoted in the authorization.
const OWNER_WORDS = Object.freeze(['"start SQL 160 yes"', '"apply SQL 160 in staging"', '"run the SQL 160 and SQL 161 production inspect"', '"Yes" to "Shall I open the pin PR?"']);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql160-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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

test('pin: the release pin shape, execute-authorized on the staging apply, in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Owner-approved pin change of 2026-11-13: the read-only production inspect (SSM 4a5e9028, main 2e2076d49) recorded as
  // the pre-state; the staging apply (run 43353383753, from the same pre-state) as the acceptance.
  assert.equal(pin.execute, true);
  assert.match(pin.authorization, /^Owner approved 2026-11-13 /);
  for (const words of OWNER_WORDS) assert.ok(pin.authorization.includes(words), words);
  assert.match(pin.authorization, /none of them words for the production apply/);
  assert.ok(pin.authorization.includes(`${PRODUCTION_PRE} -> ${pin.intended_replacement_sha256}`));
  assert.match(pin.authorization, /execute true takes effect only when the owner reviews and merges this change\. It does not itself run or approve a run/);
  assert.match(pin.authorization, /each apply still needs the owner's run-time approval/);
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, LIVE_PRE);
  assert.equal(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied, undefined);
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-11-13');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, '4a5e9028-0372-43b9-a1bb-d6751e6bedd3');
  assert.equal(pin.production_inspect.source_commit, '2e2076d494ec3ff7454c1ae1dcc75a3f4d0b0589');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  for (const text of ['ff648cf9f1155c5550786cb676256205c9d90495e86401d0e082c8386a7be907', '5d9a78e42984b1a3b93b2deb7138a8e8fc2aa701bc68812e1ae418161c437138',
    'run 43354785479', 'prerequisites_missing [], predecessors {} (none), successors_applied [], precondition_failures []', 'already_applied false',
    '569d0171-2051-44d1-ab96-e33947996913', 'GUARD_APPLY_FORBIDDEN', 'not a database read',
    'read_only, current_user and missing_dependencies were not captured in this run\'s printed output']) {
    assert.ok(pin.production_inspect.note.includes(text), text);
  }
  assert.match(pin.production_inspect.note, /If already_applied is true, prerequisites_missing is not \[\] or precondition_failures is not \[\], stop/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no release-engine production inspect has been run for SQL 160 yet'));
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql160-no-additional-check-or-manual-deposit-fee, run 43353383753/);
  assert.match(pin.staging_acceptance.basis, /wave 51/);
  assert.match(pin.staging_acceptance.basis, /deploy run 43352734483/);
  assert.ok(pin.staging_acceptance.basis.includes(`receipt before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended, result applied`));
  assert.match(pin.staging_acceptance.basis, /Read-live run 43353724235 then reported already_applied true/);
  assert.match(pin.staging_acceptance.basis, /Production's pre-state \(production_inspect\) equals staging's/);
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  assert.equal(pin.filename, SQL160_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL160_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, [...IDENTITIES]);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'STOP_ADDITIONAL_CHECK_AND_OUTSIDE_DEPOSIT_CHARGES');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql160-no-additional-check-or-manual-deposit-fee-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-160-apply.md');
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
  assert.equal(tool.allowed_key, 'sql160_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql160-no-additional-check-or-manual-deposit-fee-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql160-production-apply"\]/);
  assert.match(rows, /sql158, sql159, sql160, sql161, sql162, sql163\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql160-executor.test.mjs', 'aws/tests/release-sql160-production-apply.test.mjs', 'aws/tests/sql160-billing-additional-check-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; four live functions replaced with their observed grants, nothing created; no table, policy, trigger or grant; no overlay plan entry; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.production_only, undefined);
  assert.equal(spec.production_noop, undefined);
  assert.deepEqual(spec.functions.map((fn) => [fn.identity, fn.acl, fn.revokes]), IDENTITIES.map((fn, i) => [fn, ACLS[i], []]));
  for (const name of [...IDENTITIES, 'column public.deposit_items.provider', 'column public.mortgage_agent_compensation_rates.additional_cents', 'role checksops', 'role authenticated']) {
    assert.ok(spec.prerequisites.includes(name), name);
  }
  for (const absent of ['tables', 'views', 'policies', 'table_privileges', 'column_acl', 'dropped_functions', 'acl_functions', 'indexes', 'added_columns', 'constraints', 'triggers', 'altered_relations', 'definer_writes']) {
    assert.equal(spec[absent], undefined, absent);
  }
  assert.match(COMMITTED.order_note, /^No predecessor\. SQL 160 replaces four existing live functions with CREATE OR REPLACE and creates nothing/);
  for (const text of ['"we are removing the mortgage handling for an additional check if an additional check is on the same request. There will be no more $5 charge"',
    '"Stop paying it"', '"if a user deposits a check outside of checksops they should NOT be charged $4"', '"yes make that free too"', '"start SQL 160 yes"',
    '"merge 1832 when green and yes make that free too"', 'sql160_live_body_drift', 'observed_functions', 'revokes []',
    'trg_record_check_billing_event', 'tr_record_mortgage_handling_billing', 'tr_accrue_mortgage_ops_billing', 'tr_earn_mortgage_agent_compensation',
    'db-readonly-validate trigger count is not affected', 'No API, Lambda or SPA change is part of this pin', LIVE_PRE]) {
    assert.ok(COMMITTED.order_note.includes(text), text);
  }
  // No API member waits on SQL 160.
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.equal(plan.sql_prerequisites?.[SQL160_FILE], undefined);
  // The file: the two DO blocks and four CREATE OR REPLACE FUNCTION; no GRANT, REVOKE or other DDL or data change.
  const text = fs.readFileSync(path.join(ROOT, SQL160_FILE), 'utf8').replace(/--[^\n]*/g, '');
  const outside = text.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$');
  assert.deepEqual([...outside.matchAll(/^\s*CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(\S+?)\(/gim)].map((m) => m[1]), IDENTITIES.map((identity) => identity.replace(/\(.*$/, '')));
  assert.doesNotMatch(outside, /\b(GRANT|REVOKE|ALTER|DROP|TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+public\.)\b|\bCREATE\s+(TABLE|POLICY|VIEW|TRIGGER|INDEX)\b/i);
  assert.equal([...outside.matchAll(/\bDO\s+\$/g)].length, 2);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  for (const value of [COMMITTED.intended_replacement_sha256, COMMITTED.source_sha256, LIVE_PRE, 'STOP_ADDITIONAL_CHECK_AND_OUTSIDE_DEPOSIT_CHARGES', '#1832', 'wave 51']) {
    assert.ok(runbook.includes(value), value);
  }
  assert.match(runbook, /\*\*Status:\*\* applied in staging \(wave 51, 2026-11-13, apply run 43353383753\); staging acceptance: the staging apply under the owner's run approval \("apply SQL 160 in staging"; no separate acceptance statement\); production pin execute-authorized on production's own pre-state \(read-only inspect SSM `4a5e9028-0372-43b9-a1bb-d6751e6bedd3`\)\. Not applied in production\./);
  assert.match(runbook, /\*\*Production inspect \(2026-11-13\)\.\*\* Read-only `--inspect` through SSM `4a5e9028-0372-43b9-a1bb-d6751e6bedd3`/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql160` \|/);
  assert.match(oneShot, /`sql158`, `sql159`, `sql160`, `sql161`, `sql162`, `sql163`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql160-no-additional-check-or-manual-deposit-fee-production-apply\.mjs --inspect/);
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
  assert.equal(committedOk.details.sql160_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(COMMITTED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(COMMITTED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql160_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // SQL 158's phrase does not authorize SQL 160.
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'START_MORTGAGE_DESK_OVERSIGHT_AND_AGENT_NOTES' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql160-cli-${process.pid}.json`);
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
