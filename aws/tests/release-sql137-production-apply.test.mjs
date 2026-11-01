/**
 * Production tool for SQL 137 (scripts/deployment-guard/sql137-platform-owner-identity-production-
 * apply.mjs on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 137 included) through the
 * shared refusals; this file covers SQL 137's own:
 *
 *   - the pin has the release pin shape plus the applied record; it was execute-authorized (owner-
 *     approved pin change of 2026-11-01, #1502, option A) with the recorded production pre-state (read by
 *     the production inspect, not the predicted one and not staging's) and the staging apply as its
 *     acceptance, then applied on 2026-11-01 and retired (execute false); it is in step with the staging
 *     pin, the one-shot, the bypass inventory and the test lists;
 *   - no predecessor; one function (is_platform_owner(), the only definition in the repository's AWS
 *     SQL besides aws/rls/sql/10); the API reads platform-owner status only through the function; no
 *     API path updates an email column or updates, deletes or truncates identity_accounts (read from
 *     the source); the runbook, one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; an execute-authorized copy of the
 *     committed (retired) pin allows only the manifest bound to its recorded pre-state, and the retired
 *     pin itself refuses before connecting; an approved, accepted copy evaluates for the manifest
 *     built from it, and refuses with execute false, another live hash, another staging reference or
 *     a wrong phrase; the CLI spends no receipt.
 * The function and grants on PostgreSQL 16 are aws/tests/sql137-platform-owner-identity-pg.test.mjs;
 * the executor path is aws/tests/release-sql137-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql137-platform-owner-identity-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql137';
const SQL137_FILE = 'aws/workflows/sql/137_platform_owner_identity.sql';
const TABLE = 'public.identity_accounts';
const FUNCTION = 'public.is_platform_owner()';
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// SQL 137's recorded production pre-state (read-only inspect of 2026-11-01, SSM 9d865a2c, main 6120c6480): not the
// predicted 9862a392... and not staging's a2c2d856... (owner chose to record it, option A).
const PRODUCTION_PRE = '15fecb5b913a30860ae5fc03d58b4108c27f1692c07b5edf2f90e0a9f9b1c095';
const PREDICTED_PRE = '9862a392054d3adb7069949dac490f6423be86632abf0ac9d9d6c99d81ffdada';
const STAGING_PRE = 'a2c2d856a21c52d47544fad05e0f0275a24a093421c8a7a7fbeea0e4bb329dfc';
// The guarded staging apply (wave 32).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/41236898030';
// SQL 137's production apply of 2026-11-01 (main e8ef1f52d), recorded in applied, on the owner's "apply SQL 137 in production".
const SQL137_APPLIED = Object.freeze({ ssm: '217d0d6a-c505-40ff-9808-12f9bf21ccba', run: 'a7cd33a1-855c-43f4-aa52-58f196dea7cc', one_use_id: 'sql137-prod-bff421b2-1636-4a3e-9a71-bc51f7157b49', commit: 'e8ef1f52dfaafd812b86aead3e6063f8f95d72c7', workstream: 'prod-sql137-platform-owner-identity-20261101', approval: 'apply SQL 137 in production' });
// The separate one-shot --phase inspect before the apply.
const PRE_INSPECT_SSM = 'b5f541cd-6eaf-4c26-88ef-d49270f9b458';
const PRE_INSPECT_RUN = 'a9ce8db7-5df5-47d8-8d22-7961c8032341';
const OWNER_WORDS = Object.freeze(['"Merge 1492, 1493, then continue with SQL137 staging"', '"record the SQL 137 staging pin"', '"apply SQL 137 in staging"', '"SQL 137 works in staging"', '"start the SQL runner for the SQL 137 production inspect"', '"Merge 1591 and I choose option A"']);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql137-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
/** Every .mjs file under a directory (node_modules excluded). */
const mjsFiles = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
  if (d.name === 'node_modules') return [];
  const rel = `${dir}/${d.name}`;
  if (d.isDirectory()) return mjsFiles(rel);
  return d.name.endsWith('.mjs') ? [rel] : [];
});

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
    build_timestamp: '2026-10-31T00:00:00.000Z',
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

test('pin: the release pin shape, applied and retired (owner approved 2026-11-01, on the staging apply; applied 2026-11-01), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)(\.|$)/.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Applied 2026-11-01 and retired. The pin change (#1502) recorded the read-only production inspect (SSM 9d865a2c,
  // main 6120c6480) as the pre-state (option A) and the staging apply (run 41236898030) as the acceptance; its words
  // named the staging steps, the inspect and the pin change, and the apply run had the owner's own words for it.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-11-01; execute is false again/);
  assert.doesNotMatch(pin.authorization, /^Owner approved/);
  for (const words of OWNER_WORDS) assert.ok(pin.authorization.includes(words), words);
  assert.match(pin.authorization, /none of them words for the production apply/);
  assert.ok(pin.authorization.includes('#1502'));
  assert.ok(pin.authorization.includes('"Merge 1502 and A"'));
  assert.ok(pin.authorization.includes(`${PRODUCTION_PRE.slice(0, 8)} -> ${pin.intended_replacement_sha256.slice(0, 8)}`));
  assert.ok(pin.authorization.includes(SQL137_APPLIED.workstream));
  assert.ok(pin.authorization.includes(`"${SQL137_APPLIED.approval}"`));
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  // Not the predicted pre-state, and not staging's.
  assert.notEqual(pin.expected_live_definition_sha256, PREDICTED_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, STAGING_PRE);
  assert.equal(staging.expected_live_definition_sha256, STAGING_PRE);
  assert.equal(pin.applied.date, '2026-11-01');
  assert.equal(pin.applied.result, 'applied');
  assert.equal(pin.applied.apply_ssm_command_id, SQL137_APPLIED.ssm);
  assert.equal(pin.applied.one_shot_run_id, SQL137_APPLIED.run);
  assert.equal(pin.applied.one_use_id, SQL137_APPLIED.one_use_id);
  assert.equal(pin.applied.one_use_id_consumed, true);
  assert.equal(pin.applied.workstream_id, SQL137_APPLIED.workstream);
  assert.equal(pin.applied.source_commit, SQL137_APPLIED.commit);
  assert.equal(pin.applied.source_tarball.sha256, 'af52eb51781970da1b36757c9dc4e120d989cf2c96626ac8d93159486dba0552');
  assert.equal(pin.applied.migration_source_sha256, pin.source_sha256);
  assert.equal(pin.applied.owner_approval, SQL137_APPLIED.approval);
  assert.ok(pin.applied.owner_approval_basis.includes('"Merge 1502 and A"'));
  assert.equal(pin.applied.operator, 'michaelcarletta-cmd');
  assert.equal(pin.applied.runner, 'i-0c35557c4e5385406');
  assert.deepEqual(pin.applied.steps, ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
  // The transfer run, the separate --phase inspect before the apply, the runner times, and that the JSON arrived whole.
  assert.match(pin.applied.one_shot_note, /transfer run 41263811958/);
  assert.ok(pin.applied.one_shot_note.includes(PRE_INSPECT_SSM));
  assert.ok(pin.applied.one_shot_note.includes(PRE_INSPECT_RUN));
  assert.match(pin.applied.one_shot_note, /started from stopped for this run at 2026-11-01T11:17:58Z/);
  assert.match(pin.applied.one_shot_note, /stopped again at 11:20:00Z/);
  assert.match(pin.applied.one_shot_note, /The run's JSON arrived whole/);
  assert.match(pin.applied.one_shot_note, /"Admin tenants works in production, record SQL 137"/);
  assert.equal(pin.applied.manifest_sha256, 'ae5728388cf443b5e8520bd4dd0059f4cb26d2da4d88f7feade2e63698848fe9');
  assert.deepEqual(Object.values(pin.applied.contract_results).map((c) => c.evidence.split(' ')[0]), ['4/4', '6/6', '43/43']);
  for (const c of Object.values(pin.applied.contract_results)) assert.ok(c.evidence.includes(SQL137_APPLIED.run), c.test);
  assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.applied.pre_apply_inspect.live_matches_expected, true);
  assert.equal(pin.applied.pre_apply_inspect.already_applied, false);
  assert.deepEqual(pin.applied.pre_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.pre_apply_inspect.predecessors, {});
  assert.deepEqual(pin.applied.pre_apply_inspect.release_sql_inspect.function_acl, [{ name: 'is_platform_owner()', acl: ['PUBLIC EXECUTE', 'checksops EXECUTE', 'owner EXECUTE'] }]);
  assert.deepEqual(pin.applied.pre_apply_inspect.release_sql_inspect.table_privileges, [{ name: 'identity_accounts', lines: ['checksops DELETE', 'checksops UPDATE'], other_write_grants: [] }]);
  assert.equal(pin.applied.receipt.before_hash, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(pin.applied.receipt.workstream, SQL137_APPLIED.workstream);
  assert.equal(pin.applied.receipt.commit, SQL137_APPLIED.commit);
  assert.equal(pin.applied.receipt.sql_file, SQL137_FILE);
  assert.equal(pin.applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(pin.applied.receipt.unrelated_catalog_sha256, '762c27549421f43f427f0cab6f51ca1154cd252d610bc6c876528d3651a321b2');
  assert.equal(pin.applied.receipt.unrelated_catalog_counts.functions, 1355);
  assert.equal(pin.applied.receipt.unrelated_catalog_counts.triggers, 184);
  assert.equal(pin.applied.receipt.result, 'applied');
  assert.equal(pin.applied.post_apply_inspect.already_applied, true);
  assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.post_apply_inspect.predecessors, {});
  // is_platform_owner() intended with EXECUTE for authenticated, checksops and the owner; no write grant on identity_accounts.
  const post = pin.applied.post_apply_inspect.release_sql_inspect;
  assert.deepEqual(post.functions, [{ name: 'is_platform_owner()', state: 'intended' }]);
  assert.deepEqual(post.function_acl, [{ name: 'is_platform_owner()', acl: ['authenticated EXECUTE', 'checksops EXECUTE', 'owner EXECUTE'] }]);
  assert.deepEqual(post.table_privileges, [{ name: 'identity_accounts', lines: [], other_write_grants: [] }]);
  assert.deepEqual(pin.applied.receipt.release_sql_inspect, post);
  for (const evidence of [SQL137_APPLIED.ssm, SQL137_APPLIED.run, SQL137_APPLIED.one_use_id, PRE_INSPECT_SSM, `"${SQL137_APPLIED.approval}"`, '"Admin tenants works in production, record SQL 137"']) {
    assert.ok(pin.production_evidence['2026-11-01 apply'].includes(evidence), evidence);
  }
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-11-01');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, '9d865a2c-c032-4f8c-8d81-d7420e6edb90');
  assert.equal(pin.production_inspect.source_commit, '6120c6480c49839c1450cdd74b49ae16fb624fb7');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('4c70eed24bb1448fe652cc6b10e0a486a18cc2313d8492c5e4721122606b4572'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.match(pin.production_inspect.note, /function_acl PUBLIC EXECUTE, checksops EXECUTE, owner EXECUTE/);
  assert.match(pin.production_inspect.note, /identity_accounts lines checksops DELETE, checksops UPDATE, other_write_grants \[\]/);
  assert.ok(pin.production_inspect.note.includes(PREDICTED_PRE));
  assert.ok(pin.production_inspect.note.includes(STAGING_PRE));
  assert.match(pin.production_inspect.note, /option A/);
  assert.match(pin.production_inspect.note, /sql137_owner_identity_count, sql137_owner_profile_without_identity/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no read-only production inspect has been run for SQL 137 yet.'));
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql137-platform-owner-identity, run 41236898030/);
  assert.match(pin.staging_acceptance.basis, /deploy run 41236640767/);
  assert.match(pin.staging_acceptance.basis, /Read-live run 41237134081 then reported already_applied true/);
  assert.ok(pin.staging_acceptance.basis.includes(`receipt before ${STAGING_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.match(pin.staging_acceptance.basis, /"SQL 137 works in staging"/);
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  assert.equal(pin.filename, SQL137_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.ok(pin.intended_post_state.note.endsWith(`${pin.intended_replacement_sha256}.`));
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, read(SQL137_FILE)));
  assert.deepEqual(pin.function_identities, [FUNCTION]);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_PLATFORM_OWNER_IDENTITY');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql137-platform-owner-identity-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-137-apply.md');
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
  assert.equal(tool.allowed_key, 'sql137_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(RELEASE_SQL_SPECS[KEY].runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql137-platform-owner-identity-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql137-production-apply"\]/);
  assert.match(rows, /sql133, sql134, sql135, sql136, sql137, sql138\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = read('.github/workflows/deployment-guard.yml');
  for (const name of ['aws/tests/release-sql137-executor.test.mjs', 'aws/tests/release-sql137-production-apply.test.mjs', 'aws/tests/sql137-platform-owner-identity-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; one function, defined only in aws/rls/sql/10 before; the API decides owner status through it and writes no email column of profiles or identity_accounts; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['supersedes', 'refuse_after', 'runs_before', 'acl_functions', 'dropped_functions', 'tables', 'views', 'policies', 'triggers', 'column_acl', 'definer_writes', 'whole_tables', 'render']) {
    assert.equal(spec[absent], undefined, absent);
  }
  assert.deepEqual(spec.functions.map((fn) => fn.identity), [FUNCTION]);
  assert.deepEqual(spec.table_privileges.map((p) => [p.table, p.intended.length]), [[TABLE, 0]]);
  assert.deepEqual(spec.altered_relations, [TABLE]);
  assert.match(COMMITTED.order_note, /^No predecessor and no order on this engine/);
  assert.match(COMMITTED.order_note, /finding 15/);
  assert.match(COMMITTED.order_note, /sql137_owner_profile_without_identity/);
  assert.match(COMMITTED.order_note, /already_applied true/);

  // The repository's AWS SQL defines is_platform_owner() only in aws/rls/sql/10 (and now SQL 137).
  const defines = [];
  for (const dir of ['aws/rls/sql', 'aws/workflows/sql', 'aws/identity/sql', 'aws/write-path/sql']) {
    if (!fs.existsSync(path.join(ROOT, dir))) continue;
    for (const file of fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.sql'))) {
      if (/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.is_platform_owner\s*\(/i.test(stripComments(read(`${dir}/${file}`)))) defines.push(`${dir}/${file}`);
    }
  }
  assert.deepEqual(defines.sort(), ['aws/rls/sql/10_owner_helpers_from_identity.sql', SQL137_FILE]);

  // The API: no UPDATE of an email column of profiles or identity_accounts, no UPDATE, DELETE or
  // TRUNCATE of identity_accounts; its profiles UPDATEs set only full_name / phone and totp_enrolled_at.
  const api = mjsFiles('aws/functions');
  assert.ok(api.length > 20, 'API sources found');
  for (const rel of api) {
    const src = read(rel);
    assert.doesNotMatch(src, /UPDATE\s+(public\.)?identity_accounts\b/i, rel);
    assert.doesNotMatch(src, /DELETE\s+FROM\s+(public\.)?(identity_accounts|profiles)\b/i, rel);
    assert.doesNotMatch(src, /TRUNCATE[^;`]*\bidentity_accounts\b/i, rel);
    for (const m of src.matchAll(/UPDATE\s+public\.profiles\s+SET\s+([^`]*?)\s+WHERE/gi)) {
      assert.doesNotMatch(m[1], /\bemail\b/, `${rel}: ${m[0]}`);
    }
    for (const m of src.matchAll(/INSERT INTO public\.(identity_accounts|profiles)[\s\S]*?ON CONFLICT[^`]*?DO\s+(\w+)/g)) {
      assert.equal(m[2], 'NOTHING', `${rel}: ${m[0].slice(0, 80)}`);
    }
  }
  const metadata = read('aws/functions/api/write-app-metadata.mjs');
  const profiles = metadata.slice(metadata.indexOf('export const executeProfiles'), metadata.indexOf('export const executeCompanyBranding'));
  assert.deepEqual([...profiles.matchAll(/out\.([a-z_]+) = /g)].map((m) => m[1]), ['full_name', 'phone']);
  // Platform-owner status in the API comes from the function (data.mjs, workflow-rpc.mjs and the others).
  assert.match(read('aws/functions/api/data.mjs'), /export const IS_PLATFORM_OWNER_SQL = 'SELECT public\.is_platform_owner\(\) AS is_owner';/);

  const runbook = read(COMMITTED.tooling.runbook);
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* applied to staging \(wave 32\) and to production \(2026-11-01\); the production pin is retired/);
  assert.match(runbook, /\*\*Production apply \(2026-11-01\)\.\*\*/);
  for (const evidence of [SQL137_APPLIED.ssm, SQL137_APPLIED.run, SQL137_APPLIED.workstream, PRE_INSPECT_SSM, '41263811958', `"${SQL137_APPLIED.approval}"`, '"Admin tenants works in production, record SQL 137"']) {
    assert.ok(runbook.includes(evidence), evidence);
  }
  assert.match(runbook, /SSM\s+`9d865a2c-c032-4f8c-8d81-d7420e6edb90`/);
  assert.ok(runbook.includes(PRODUCTION_PRE));
  assert.match(runbook, /\*\*Staging apply \(2026-10-31\)\.\*\* Apply run 41236898030/);
  assert.match(runbook, /read-live \(2026-10-31\)\.\*\* Run 41234275408/);
  assert.ok(runbook.includes('a2c2d856a21c52d47544fad05e0f0275a24a093421c8a7a7fbeea0e4bb329dfc'));
  assert.match(runbook, /APPLY_PLATFORM_OWNER_IDENTITY/);
  assert.match(runbook, /finding 15/);
  const oneShot = read('ops/production-sql-one-shot.md');
  assert.match(oneShot, /\| `sql137` \|/);
  assert.match(oneShot, /`sql134`, `sql135`, `sql136`, `sql137`, `sql138`\) \|/);
  assert.match(read('ops/deployment-guard/README.md'), /sql137-platform-owner-identity-production-apply\.mjs --inspect/);
});

test('the pending (pre-authorization) pin refuses before connecting; an execute-authorized copy of the retired pin allows only its own manifest; execute false, other hashes and phrases refuse', async () => {
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

  // The committed pin is retired (execute false): an execute-authorized copy of it, before the
  // record-and-retire change, allows only the manifest bound to its recorded pre-state: not another
  // hash, not staging's or the predicted pre-state, not the intended state (which is production's current state).
  const AUTHORIZED = Object.freeze({ ...COMMITTED, execute: true, authorization: 'Owner approved 2026-11-01 (test copy of the execute-authorized pin before its record-and-retire change)' });
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(AUTHORIZED), { root: ROOT, pin: AUTHORIZED });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql137_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  for (const other of [PRE, STAGING_PRE, PREDICTED_PRE]) {
    assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: other, expected_live_definition_sha256: other }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION, other);
  }
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: AUTHORIZED })).ok, false);
  // The retired committed pin refuses before connecting.
  assert.equal((await executeReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql137_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY_CHECK_CREATE_INSERT_GRANT' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql137-cli-${process.pid}.json`);
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
