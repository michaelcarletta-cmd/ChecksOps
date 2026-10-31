/**
 * Production tool for SQL 130 (scripts/deployment-guard/sql130-financial-totp-rate-limit-code-check-no-public-
 * production-apply.mjs on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 130 included) through the
 * shared refusals; this file covers SQL 130's own:
 *
 *   - the pin has the release pin shape plus the applied record; it was execute-authorized (owner-
 *     approved pin change of 2026-10-30, #1452) with the recorded production pre-state (derived from
 *     bytes in release-sql130-executor.test.mjs) and the staging apply as its acceptance, then applied
 *     on 2026-10-30 and retired (execute false); it is in step with the staging pin, the one-shot, the
 *     bypass inventory and the test lists;
 *   - no predecessor and no order; it supersedes the retired SQL 129; the function (EXECUTE for
 *     checksops and the owner, PUBLIC revoked), the prerequisites (the function,
 *     financial_totp_rate_limits and its columns, role checksops); no table, view, policy, trigger or
 *     drop, and no grant but the REVOKE from PUBLIC and the GRANT to checksops on this one function
 *     (the other financial_totp_* functions untouched); no plan entry; the API's existing calls keep
 *     the same signature and send the action the file adds; the runbook, one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; the committed pin allows only
 *     the manifest bound to its recorded pre-state; an approved, accepted copy evaluates for the
 *     manifest built from it, and refuses with execute false, another live hash, another staging
 *     reference or a wrong phrase; the CLI spends no receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql130-financial-totp-rate-limit-pg.test.mjs; the
 * executor path is aws/tests/release-sql130-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql130-financial-totp-rate-limit-code-check-no-public-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql130';
const SQL130_FILE = 'aws/workflows/sql/130_financial_totp_rate_limit_code_check_no_public.sql';
const IDENTITY = 'public.consume_financial_totp_rate_limit(uuid, text, integer, integer)';
const SQL130_IDENTITIES = Object.freeze([IDENTITY]);
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// SQL 130's recorded production pre-state (read-only inspect of 2026-10-30, SSM 88570df0, main 66a0baaf2):
// the proposed function with EXECUTE for PUBLIC, checksops and the owner; staging's pre-state lacked PUBLIC.
const PRODUCTION_PRE = 'e49dc44662d1ac04762cf06d139f527d9a09158cbccd64fc8370d62e1f43c838';
const STAGING_PRE = 'cb2fd65bb580f9338cab728c2507a32b7589aee5e702d117c31e1862f98a5a19';
// The guarded staging apply (wave 28).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/41090274902';
const OWNER_WORDS = '"apply SQL 130 in production"';
// SQL 130's production apply of 2026-10-30 (main e84fb3684), recorded in applied; the owner's words were
// passed to the run verbatim.
const SQL130_APPLIED = Object.freeze({ ssm: 'e37e683c-98ed-417e-9caf-9e74dc121d51', run: 'a682df1c-5853-43d4-8d92-dd6641674431', one_use_id: 'sql130-prod-4da47b86-1f88-4ecc-920e-d5ccb1d71744', commit: 'e84fb368402c12e5d27710f5c4fa808f8c8675de', workstream: 'prod-sql130-financial-totp-rate-limit-code-check-no-public-20261030', approval: 'apply SQL 130 in production' });
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql130-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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

test('pin: the release pin shape, applied and retired (owner approved 2026-10-30, on the staging apply), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)(\.|$)/.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Applied 2026-10-30 and retired. The pin change (#1452) recorded the read-only production inspect (SSM
  // 88570df0, main 66a0baaf2) as the pre-state and the staging apply (run 41090274902) as the acceptance.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-10-30; execute is false again/);
  assert.doesNotMatch(pin.authorization, /^Owner approved/);
  assert.ok(pin.authorization.includes(OWNER_WORDS));
  assert.ok(pin.authorization.includes('"continue with SQL 130 staging"'));
  assert.ok(pin.authorization.includes('"apply SQL 130 in staging"'));
  assert.ok(pin.authorization.includes('#1452'));
  assert.ok(pin.authorization.includes(SQL130_APPLIED.workstream));
  assert.ok(pin.authorization.includes(`"${SQL130_APPLIED.approval}"`));
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied.date, '2026-10-30');
  assert.equal(pin.applied.result, 'applied');
  assert.equal(pin.applied.apply_ssm_command_id, SQL130_APPLIED.ssm);
  assert.equal(pin.applied.one_shot_run_id, SQL130_APPLIED.run);
  assert.equal(pin.applied.one_use_id, SQL130_APPLIED.one_use_id);
  assert.equal(pin.applied.one_use_id_consumed, true);
  assert.equal(pin.applied.workstream_id, SQL130_APPLIED.workstream);
  assert.equal(pin.applied.source_commit, SQL130_APPLIED.commit);
  assert.equal(pin.applied.source_tarball.sha256, 'f15087d3579d1430b39cec32b4054fab5fc7212e6b6fbdc03c91487fe07663f6');
  assert.equal(pin.applied.migration_source_sha256, pin.source_sha256);
  assert.equal(pin.applied.owner_approval, SQL130_APPLIED.approval);
  assert.deepEqual(pin.applied.steps, ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
  assert.match(pin.applied.one_shot_note, /051ba51e-3621-4765-babe-776ac9e96380/);
  assert.match(pin.applied.one_shot_note, /8cbeeebb-c58f-4ab4-a654-d7ea171d899b/);
  assert.equal(pin.applied.manifest_sha256, '955c01b52372d57743600e789ae4c62f6961c421bd5ae6e040a27212bbfdece4');
  assert.deepEqual(Object.values(pin.applied.contract_results).map((c) => c.evidence.split(' ')[0]), ['4/4', '6/6', '43/43']);
  assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.deepEqual(pin.applied.pre_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.pre_apply_inspect.release_sql_inspect.functions.map((f) => f.state), ['different']);
  assert.deepEqual(pin.applied.pre_apply_inspect.release_sql_inspect.function_acl.map((f) => f.acl), [['PUBLIC EXECUTE', 'checksops EXECUTE', 'owner EXECUTE']]);
  assert.equal(pin.applied.receipt.before_hash, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(pin.applied.receipt.workstream, SQL130_APPLIED.workstream);
  assert.equal(pin.applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(pin.applied.receipt.unrelated_catalog_sha256, '02f15e36160f224cd8fbf08f05601a3c184a22818bd744e6cc4a2436d61990bd');
  assert.equal(pin.applied.receipt.unrelated_catalog_counts.triggers, 184);
  assert.equal(pin.applied.receipt.result, 'applied');
  assert.equal(pin.applied.post_apply_inspect.already_applied, true);
  assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.post_apply_inspect.release_sql_inspect.functions.map((f) => f.state), ['intended']);
  assert.deepEqual(pin.applied.post_apply_inspect.release_sql_inspect.triggers, []);
  assert.deepEqual(pin.applied.post_apply_inspect.release_sql_inspect.function_acl.map((f) => f.acl), [['checksops EXECUTE', 'owner EXECUTE']]);
  assert.equal(pin.applied.post_apply_inspect.release_sql_inspect.dropped_function_dependents, 0);
  assert.ok(pin.production_evidence['2026-10-30 apply'].includes(SQL130_APPLIED.ssm));
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-10-30');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, '88570df0-02e3-408f-8f1d-1fdddd0dadda');
  assert.equal(pin.production_inspect.source_commit, '66a0baaf26418341d88a870562a6ff38c51ca49d');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('8cb7d3398830c6b5c69b185b6d1bf6da2a6dde05633abdea21678753450a2089'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.match(pin.production_inspect.note, /consume_financial_totp_rate_limit\(uuid, text, integer, integer\) different, function_acl PUBLIC EXECUTE, checksops EXECUTE and owner EXECUTE/);
  assert.match(pin.production_inspect.note, /dropped_function_dependents 0, dropped_function_callers \[\]/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: '));
  assert.match(pin.production_inspect.note, /SSM cfee4512-4988-4fd1-be77-b03d1b4cd50b/);
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql130-financial-totp-rate-limit-code-check-no-public, run 41090274902/);
  assert.match(pin.staging_acceptance.basis, /deploy run 41089857134/);
  assert.match(pin.staging_acceptance.basis, /Read-live run 41090642842 then reported already_applied true/);
  assert.ok(pin.staging_acceptance.basis.includes(`receipt before ${STAGING_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // The staging pin recorded staging's pre-state (wave 28); production's differs by the PUBLIC grant.
  assert.equal(staging.expected_live_definition_sha256, STAGING_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.equal(pin.filename, SQL130_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL130_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, SQL130_IDENTITIES);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_FINANCIAL_TOTP_RATE_LIMIT_CODE_CHECK_NO_PUBLIC');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql130-financial-totp-rate-limit-code-check-no-public-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-130-apply.md');
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
  assert.equal(tool.allowed_key, 'sql130_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(RELEASE_SQL_SPECS[KEY].runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql130-financial-totp-rate-limit-code-check-no-public-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql130-production-apply"\]/);
  assert.match(rows, /sql123, sql124, sql125, sql126, sql127, sql128, sql129, sql130, sql131, sql132, sql133, sql134, sql135, sql137\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql130-executor.test.mjs', 'aws/tests/release-sql130-production-apply.test.mjs', 'aws/tests/sql130-financial-totp-rate-limit-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor and no order; supersedes SQL 129; the function and its prerequisites; PUBLIC revoked, checksops granted, nothing else; no plan entry; the API keeps its calls and sends code_check; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.deepEqual(spec.supersedes, ['sql129']);
  assert.deepEqual(spec.functions.map((fn) => fn.identity), SQL130_IDENTITIES);
  for (const fn of spec.functions) {
    // The file revokes EXECUTE from PUBLIC and grants it to checksops: the reviewed ACL is checksops and the owner.
    assert.deepEqual(fn.acl, ['checksops EXECUTE', 'owner EXECUTE'], fn.identity);
    assert.deepEqual(fn.revokes, ['PUBLIC EXECUTE'], fn.identity);
    assert.equal(fn.result, 'TABLE(allowed boolean, count integer, retry_after_seconds integer)');
  }
  assert.equal(spec.dropped_functions, undefined);
  assert.equal(spec.acl_functions, undefined);
  assert.deepEqual(spec.prerequisites.slice(0, 3), [IDENTITY, 'public.financial_totp_rate_limits', 'role checksops']);
  for (const column of ['user_id', 'action', 'window_started_at', 'request_count']) {
    assert.ok(spec.prerequisites.includes(`column public.financial_totp_rate_limits.${column}`), column);
  }
  for (const absent of ['tables', 'views', 'policies', 'triggers', 'altered_relations', 'definer_writes']) assert.equal(spec[absent], undefined, absent);
  assert.match(COMMITTED.order_note, /^No release-engine predecessor and no ordering constraint\./);
  assert.match(COMMITTED.order_note, /supersedes SQL 129, which is retired and was never applied/);
  assert.match(COMMITTED.order_note, /No API, Lambda or SPA change is part of this pin\./);
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.equal((plan.sql_prerequisites || {})[SQL130_FILE], undefined);
  assert.ok(!JSON.stringify(plan.members).includes(SQL130_FILE));
  // The API calls the function with the same signature, as checksops, and sends the action this file adds.
  const call = 'SELECT allowed, count, retry_after_seconds FROM public.consume_financial_totp_rate_limit($1::uuid, $2, $3::int, $4::int)';
  const totp = fs.readFileSync(path.join(ROOT, 'aws/functions/api/auth-financial-totp.mjs'), 'utf8');
  const checkalt = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/production/checkalt-register.mjs'), 'utf8');
  assert.ok(totp.includes(call));
  assert.ok(checkalt.includes(call));
  assert.match(totp, /export const TOTP_CODE_CHECK_RATE_ACTION = 'code_check';/);
  assert.match(checkalt, /TOTP_CODE_CHECK_RATE_ACTION, 5, 300\]/);
  // One CREATE OR REPLACE FUNCTION, the REVOKE from PUBLIC and the GRANT to checksops on it; nothing else.
  const text = fs.readFileSync(path.join(ROOT, SQL130_FILE), 'utf8').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(text, /\bCREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|VIEW|TABLE|POLICY)\b/i);
  assert.doesNotMatch(text, /\b(DROP|ALTER)\b/i);
  assert.equal([...text.matchAll(/\bCREATE\s+OR\s+REPLACE\s+FUNCTION\b/gi)].length, 1);
  assert.deepEqual([...text.matchAll(/^\s*(GRANT|REVOKE)\b.*$/gim)].map((m) => m[0].trim()), [
    `REVOKE EXECUTE ON FUNCTION ${IDENTITY} FROM PUBLIC;`,
    `GRANT EXECUTE ON FUNCTION ${IDENTITY} TO checksops;`,
  ]);
  assert.doesNotMatch(text, /financial_totp_(upsert_enrollment|get_enrollment|mark_verified|status)\b/);
  assert.match(text, /p_action NOT IN \('enroll_start', 'enroll_confirm', 'step_up', 'code_check'\)/);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* applied to staging \(wave 28\) and to production \(2026-10-30\); the production pin is retired/);
  assert.match(runbook, /\*\*Production apply \(2026-10-30\)\.\*\*/);
  assert.match(runbook, /SSM\s+`88570df0-02e3-408f-8f1d-1fdddd0dadda`/);
  assert.match(runbook, /Staging apply \(2026-10-30\)\.\*\* Run 41090274902/);
  assert.match(runbook, /read-live \(2026-10-30\)\.\*\* Run 41087643551/);
  assert.match(runbook, /run 41081764481/);
  assert.match(runbook, /"New combined\s+fix"/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql130` \|/);
  assert.match(oneShot, /`sql127`, `sql128`, `sql129`, `sql130`, `sql131`, `sql132`, `sql133`, `sql134`, `sql135`, `sql137`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql130-financial-totp-rate-limit-code-check-no-public-production-apply\.mjs --inspect/);
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

  // The committed pin is retired (execute false): an execute-authorized copy of it, before the
  // record-and-retire change, allows only the manifest bound to its recorded pre-state: not
  // staging's pre-state, not another hash, not the intended state.
  const AUTHORIZED = Object.freeze({ ...COMMITTED, execute: true, authorization: 'Owner approved 2026-10-30 (test copy of the execute-authorized pin before its record-and-retire change)' });
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(AUTHORIZED), { root: ROOT, pin: AUTHORIZED });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql130_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: STAGING_PRE, expected_live_definition_sha256: STAGING_PRE }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: AUTHORIZED })).ok, false);
  // The retired committed pin refuses before connecting.
  assert.equal((await executeReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql130_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY_FINANCIAL_TOTP_RATE_LIMIT_CODE_CHECK' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // The retired SQL 129 production pin stays pending and refuses as before.
  const retired = loadReleaseProductionPin('sql129', ROOT);
  assert.equal(retired.execute, false);
  assert.equal(retired.authorization, 'pending');
  assert.equal(retired.expected_live_definition_sha256, null);
  assert.equal((await evaluateReleaseProductionApply('sql129', manifest({ ...retired, expected_live_definition_sha256: PRE }), { root: ROOT })).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql130-cli-${process.pid}.json`);
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
