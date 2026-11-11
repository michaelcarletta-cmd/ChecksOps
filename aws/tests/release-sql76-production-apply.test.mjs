/**
 * Production tool for SQL 76 (scripts/deployment-guard/sql76-tenant-partnership-consent-production-apply.mjs on
 * lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs). Owner 2026-11-11: "apply SQL 76 to
 * production through the guarded path", then "Option 1" (SQL 76 itself through the release engine).
 *
 *   - the pin has the release pin shape, is execute-authorized from the recorded production inspect (owner 2026-11-11:
 *     "record the SQL 76 production pin") with the staging acceptance, and is in step with the
 *     release entry, the original SQL 76 staging pin (same bytes and commit), the one-shot, the bypass inventory, the
 *     docs and the test lists;
 *   - the staging executor still routes SQL 76 to its own pin; the release entry never authorizes a staging apply;
 *   - the spec: one trigger function (EXECUTE for the owner only), one trigger, the five dropped policies, the connect,
 *     owner and trigger preconditions, no predecessor; no table, grant or drop of anything else;
 *   - a pending copy refuses before connecting; the committed pin evaluates for its own manifest only; the
 *     CLI spends no receipt.
 * The behavior on PostgreSQL 16 is aws/tests/release-sql76-production-pg.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { ONE_SHOT_TOOLS } from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import {
  AUTHORIZED_SQL76_PARTNERSHIP_CONSENT as SQL76_STAGING_PIN,
  AUTHORIZED_STAGING_SQL,
  PARTNERSHIP_CONNECT_BODY_SHA256,
  PARTNERSHIP_RETIRED_POLICIES,
  RELEASE_2026_10_17_PENDING_SQL_PINS as STAGING,
  SQL76_PROPOSED_AUTHORIZATION_PHRASE,
  releaseSqlMigrationKey,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { RELEASE_SQL_KEYS, RELEASE_SQL_SPECS, RELEASE_STAGING_SQL_KEYS, releaseIntendedHash, releaseStateHash } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import {
  RELEASE_PRODUCTION,
  evaluateReleaseProductionApply,
  executeReleaseProductionApply,
  loadReleaseProductionPin,
  precheckReleaseProductionApply,
  readPinnedReleaseSql,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { main } from '../../scripts/deployment-guard/sql76-tenant-partnership-consent-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql76';
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const FILE = COMMITTED.filename;
const TEXT = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
const GUARD = 'public.aws_tenant_partnership_consent_guard()';
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql76-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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

test('pin: the release pin shape, execute-authorized from the recorded inspect, in step with the release entry, the SQL 76 staging pin, the one-shot, the inventory, the docs and the test lists', () => {
  const pin = COMMITTED;
  const release = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Owner-approved pin change of 2026-11-11 ("record the SQL 76 production pin"): execute true, the recorded production
  // pre-state (the read-only inspect SSM 3ba99c60, equal to the derived one), the staging apply as acceptance.
  assert.equal(pin.execute, true);
  assert.match(pin.authorization, /^Owner approved 2026-11-11 /);
  for (const words of ['"apply SQL 76 to production through the guarded path"', '"Option 1"', '"run the read-only SQL 76 production inspect"', '"record the SQL 76 production pin"']) {
    assert.ok(pin.authorization.includes(words), words);
  }
  assert.match(pin.authorization, /each apply still needs the owner's run-time approval/);
  assert.equal(pin.expected_live_definition_sha256, releaseStateHash(KEY, {}));
  assert.equal(pin.expected_live_definition_sha256, 'e1f21bd49f76bf0f619cbfb37f77c01711075e3c030ce1e271ee26052fff92d6');
  assert.equal(pin.applied, undefined);
  const inspect = pin.production_inspect;
  assert.deepEqual([inspect.status, inspect.date, inspect.ssm_command_id, inspect.source_commit, inspect.read_only, inspect.connected_as],
    ['recorded', '2026-11-11', '3ba99c60-cea5-4e71-807f-87122ec557ea', '94d487268df2402b6976b1dfce46c2153f6e8ce6', true, 'checksops_admin']);
  assert.equal(inspect.live_definition_sha256, pin.expected_live_definition_sha256);
  assert.deepEqual(inspect.precondition_failures, []);
  assert.equal(inspect.apply_preconditions_met, false);
  for (const text of ['ebe20edfe5ebfcd578726223971c857506c277124f801b256fae618ba11375f0', 'transfer run 43063595712', `== source_sha256`,
    'partnership_connect_pinned 1', 'partnership_connect_not_api_owned 1', 'tenant_partnerships_no_other_trigger 1', 'already_applied false',
    'precondition_failures []', 'If already_applied is true, or precondition_failures is not [], stop.',
    // The earlier pending note (the pre-check SSM d04fa1e2) is kept.
    ' Earlier: Pending: no release-engine production inspect has been run for SQL 76 yet.', 'd04fa1e2-74d4-4795-854e-db5acf14b59b']) {
    assert.ok(inspect.note.includes(text), text);
  }
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38553052449']);
  for (const text of ['38553052449', '43024276076', 'd04fa1e2-74d4-4795-854e-db5acf14b59b', SQL76_STAGING_PIN.expected_live_definition_sha256,
    SQL76_STAGING_PIN.intended_replacement_sha256, pin.expected_live_definition_sha256]) {
    assert.ok(pin.staging_acceptance.basis.includes(text), text);
  }
  // The same bytes and authoring commit as the release entry and the original SQL 76 staging pin.
  for (const p of [release, SQL76_STAGING_PIN]) {
    assert.equal(pin.filename, p.filename);
    assert.equal(pin.migration_id, p.migration_id);
    assert.equal(pin.source_sha256, p.source_sha256);
    assert.equal(pin.staging_pin_commit, p.commit);
  }
  assert.equal(pin.intended_replacement_sha256, release.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, TEXT));
  assert.deepEqual(pin.function_identities, [GUARD]);
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, [...release.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.equal(pin.authorization_phrase, SQL76_PROPOSED_AUTHORIZATION_PHRASE);
  assert.equal(pin.authorization_phrase, 'GUARD_PARTNERSHIP_ACTIVATION');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql76-tenant-partnership-consent-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-76-apply.md');
  for (const file of [pin.tooling.production_tool, pin.tooling.runbook, pin.tooling.fingerprint_engine, pin.tooling.production_lib, ...pin.tooling.tests]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  }
  assert.equal(readPinnedReleaseSql(KEY, ROOT, pin).ok, true);
  const tool = ONE_SHOT_TOOLS[KEY];
  assert.equal(tool.key, KEY);
  assert.equal(tool.script, RELEASE_PRODUCTION[KEY].cli);
  assert.deepEqual([...tool.args], []);
  assert.equal(tool.pin_rel, RELEASE_PRODUCTION[KEY].pin_rel);
  assert.equal(tool.allowed_key, 'sql76_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql76-tenant-partnership-consent-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql76-production-apply"\]/);
  assert.match(rows, /registered production SQL tool \(sql71, sql76, sql77,/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  assert.ok(scripts['test:deployment-guard'].includes('aws/tests/release-sql76-production-apply.test.mjs'));
  assert.ok(workflow.includes('aws/tests/release-sql76-production-apply.test.mjs'));
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /^\| `sql76` \| `scripts\/deployment-guard\/sql76-tenant-partnership-consent-production-apply\.mjs` \(`ops\/production-sql-76-apply\.md`;/m);
  assert.match(oneShot, /a registered key \(`sql29`, `sql30`, `sql71`, `sql76`, `sql77`/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql76-tenant-partnership-consent-production-apply\.mjs --inspect/);
  const runbook = fs.readFileSync(path.join(ROOT, pin.tooling.runbook), 'utf8');
  for (const text of [pin.source_sha256, pin.intended_replacement_sha256, releaseStateHash(KEY, {}), '38553052449', '43024276076', 'd04fa1e2-74d4-4795-854e-db5acf14b59b']) {
    assert.ok(runbook.includes(text), text);
  }
});

test('staging: the executor still routes SQL 76 to its own pin; the release entry never authorizes a staging apply', () => {
  const input = { filename: SQL76_STAGING_PIN.filename, migration_id: SQL76_STAGING_PIN.migration_id, commit: SQL76_STAGING_PIN.commit, source_sha256: SQL76_STAGING_PIN.source_sha256 };
  assert.equal(resolveAuthorizedMigration(input), SQL76_STAGING_PIN);
  assert.equal(releaseSqlMigrationKey(input), KEY);
  assert.equal(STAGING[KEY].execute, false);
  assert.equal(STAGING[KEY].expected_live_definition_sha256, null);
  assert.match(STAGING[KEY].authorization, /no staging apply through this entry/);
  // Not in the staging allow-list, not a staging release key; the original pin is.
  assert.ok(!AUTHORIZED_STAGING_SQL.includes(STAGING[KEY]));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(SQL76_STAGING_PIN));
  assert.equal(RELEASE_SQL_SPECS[KEY].production_only, true);
  assert.ok(RELEASE_SQL_KEYS.includes(KEY));
  assert.ok(!RELEASE_STAGING_SQL_KEYS.includes(KEY));
  // The executor checks SQL 76 before the release engine.
  const executor = fs.readFileSync(path.join(ROOT, 'aws/write-path/guarded-sql-executor/index.mjs'), 'utf8');
  assert.ok(executor.indexOf('if (isSql76PartnershipConsent(event))') < executor.indexOf('const releaseKey = releaseSqlMigrationKey(event);'));
});

test('spec: one owner-only trigger function, one trigger, the five dropped policies, the connect, owner and trigger preconditions; nothing else', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.supersedes, undefined);
  assert.deepEqual(spec.functions, [{ identity: GUARD, acl: ['owner EXECUTE'] }]);
  assert.deepEqual(spec.triggers.map((t) => [t.table, t.name]), [['public.tenant_partnerships', 'aws_tenant_partnership_consent_guard']]);
  assert.match(spec.triggers[0].def, /^CREATE TRIGGER aws_tenant_partnership_consent_guard BEFORE INSERT OR UPDATE ON public\.tenant_partnerships FOR EACH ROW EXECUTE FUNCTION public\.aws_tenant_partnership_consent_guard\(\)$/);
  assert.deepEqual(spec.dropped_policies.map((p) => p.name), [...PARTNERSHIP_RETIRED_POLICIES]);
  assert.ok(spec.dropped_policies.every((p) => p.table === 'public.tenant_partnerships'));
  assert.deepEqual(spec.altered_relations, ['public.tenant_partnerships']);
  assert.deepEqual(spec.extra_preconditions, ['partnership_connect_pinned', 'partnership_connect_not_api_owned', 'tenant_partnerships_no_other_trigger']);
  assert.deepEqual(Object.keys(spec.counts), spec.extra_preconditions);
  assert.ok(spec.counts.partnership_connect_pinned.sql.includes(PARTNERSHIP_CONNECT_BODY_SHA256));
  for (const absent of ['tables', 'views', 'policies', 'table_privileges', 'column_acl', 'added_columns', 'dropped_functions', 'definer_writes', 'indexes']) {
    assert.equal(spec[absent], undefined, absent);
  }
  for (const name of ['public.tenant_partnerships', 'public.aws_user_tenant_ids()', 'public.aws_can_write_tenant(uuid)', 'public.aws_connect_partner_by_code(text, uuid)', 'auth.uid()', 'role checksops']) {
    assert.ok(spec.prerequisites.includes(name), name);
  }
  // No other release migration names SQL 76, and no overlay plan entry waits on it.
  assert.deepEqual(Object.keys(RELEASE_SQL_SPECS).filter((k) => k !== KEY && JSON.stringify(RELEASE_SQL_SPECS[k]).includes('aws_tenant_partnership_consent_guard')), []);
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.equal(plan.sql_prerequisites?.[FILE], undefined);
});

test('a pending copy refuses before connecting; the committed pin allows only its own manifest; execute false, other hashes and phrases refuse', async () => {
  // The committed pin (execute true, the recorded pre-state, accepted in staging) evaluates for its own manifest.
  const own = await evaluateReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT });
  assert.equal(own.ok, true, JSON.stringify(own));
  assert.equal(own.details.sql76_production_apply_allowed, true);
  // A pending copy (as before this change) refuses.
  const pending = { ...COMMITTED, authorization: 'pending', execute: false, expected_live_definition_sha256: null, staging_acceptance: { ok: false, reference: null, basis: 'test' } };
  const withPre = { ...pending, expected_live_definition_sha256: PRE };
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(withPre), { root: ROOT })).code, CODES.SQL_COLLISION);
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(withPre), { root: ROOT, pin: withPre })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(withPre), { root: ROOT, pin: withPre, connect: neverConnect, consumedPath: consumedPath() })).ok, false);
  const flipped = { ...withPre, execute: true };
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(flipped), { root: ROOT, pin: flipped })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql76_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // Another migration's phrase does not authorize SQL 76.
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY_EXTERNAL_DISBURSEMENT_UP_TO_CHECK_AMOUNT' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with a manifest for another pre-state refuses against the committed pin without connecting or spending a
  // receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql76-cli-${process.pid}.json`);
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
