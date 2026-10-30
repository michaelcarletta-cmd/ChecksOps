/**
 * Production tool for SQL 131 (scripts/deployment-guard/sql131-financial-totp-functions-no-public-
 * production-apply.mjs on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 131 included) through the
 * shared refusals; this file covers SQL 131's own:
 *
 *   - the pin has the release pin shape; it is execute-authorized (owner-approved pin change of
 *     2026-10-30) with the recorded production pre-state (derived from the spec here and in
 *     release-sql131-executor.test.mjs) and the staging read-live (already in the intended state
 *     there) as its acceptance; it is in step with the staging pin (still pending: no staging apply),
 *     the one-shot, the bypass inventory and the test lists;
 *   - predecessor SQL 130 (applied in both databases) and no order; the four acl_functions entries
 *     (EXECUTE for checksops and the owner, PUBLIC revoked, grantors rendered, no attributes), the
 *     prerequisites (the four functions, role checksops); no function created or replaced, no table,
 *     view, policy, trigger or drop; the file holds one guard block and exactly the four REVOKEs and
 *     four GRANTs; no plan entry; the API calls the four as checksops; the runbook, one-shot doc and
 *     README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; the committed pin allows only
 *     the manifest bound to its recorded pre-state; an approved, accepted copy evaluates for the
 *     manifest built from it, and refuses with execute false, another live hash, another staging
 *     reference or a wrong phrase (SQL 130's included); the CLI spends no receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql131-financial-totp-functions-pg.test.mjs; the
 * executor path is aws/tests/release-sql131-executor.test.mjs.
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
import { RELEASE_SQL_SPECS, releaseIntendedHash, releaseIntendedState, releaseStateHash } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import {
  RELEASE_PRODUCTION,
  evaluateReleaseProductionApply,
  executeReleaseProductionApply,
  loadReleaseProductionPin,
  precheckReleaseProductionApply,
  readPinnedReleaseSql,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { main } from '../../scripts/deployment-guard/sql131-financial-totp-functions-no-public-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql131';
const SQL131_FILE = 'aws/workflows/sql/131_financial_totp_functions_no_public.sql';
const IDENTITIES = Object.freeze([
  'public.financial_totp_upsert_enrollment(uuid, bytea, bytea, text)',
  'public.financial_totp_get_enrollment(uuid)',
  'public.financial_totp_mark_verified(uuid, bigint)',
  'public.financial_totp_status(uuid)',
]);
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
const TEXT = fs.readFileSync(path.join(ROOT, SQL131_FILE), 'utf8');
// Production's pre-state (read-only inspect of 2026-10-30, SSM be25e88a, main 1dcd0f33e: EXECUTE for PUBLIC,
// checksops and the owner on each of the four, each granted by the owner), derived from the spec; the pin
// records the value the inspect read, which must equal this one.
const PRODUCTION_PRE = (() => {
  const state = releaseIntendedState(KEY, TEXT);
  for (const identity of IDENTITIES) state.acl_functions[identity].acl = ['PUBLIC EXECUTE grantor=owner', ...state.acl_functions[identity].acl];
  return releaseStateHash(KEY, state);
})();
// The guarded staging read-live (already in the intended state there; no staging apply).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/41107844336';
const OWNER_WORDS = Object.freeze(['"restart SQL 131 and the lockout fix"', '"Merge SQL 131 and the lockout fix when green"', '"continue with SQL 131 staging"', '"run the SQL 131 production inspect"']);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql131-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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

test('pin: the release pin shape, execute-authorized on the staging read-live, in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Owner-approved pin change of 2026-10-30: the read-only production inspect (SSM be25e88a, main 1dcd0f33e)
  // recorded as the pre-state; the staging read-live (run 41107844336, already in the intended state) as the
  // acceptance. The owner's words so far name the restart, the merge, the staging step and the inspect: the
  // production apply still needs the owner's words for that run.
  assert.equal(pin.execute, true);
  assert.match(pin.authorization, /^Owner approved 2026-10-30 /);
  for (const words of OWNER_WORDS) assert.ok(pin.authorization.includes(words), words);
  assert.match(pin.authorization, /none of them words for the production apply/);
  assert.ok(pin.authorization.includes(`${PRODUCTION_PRE} -> ${pin.intended_replacement_sha256}`));
  assert.match(pin.authorization, /execute true takes effect only when the owner reviews and merges this change\. It does not itself run or approve a run/);
  assert.match(pin.authorization, /each apply still needs the owner's run-time approval/);
  // The recorded pre-state is the value derived from the spec (the four with PUBLIC EXECUTE granted by the owner).
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, '99d9e8e925ca8c5b56e11409f145e2d75de2759c27d8fd1b476494ffc62e2eaa');
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied, undefined);
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-10-30');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, 'be25e88a-1088-49af-81fa-10eecd8902b4');
  assert.equal(pin.production_inspect.source_commit, '1dcd0f33e5da9246f276f5ee77dad6c1476635d1');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('1d9efa200afe912ace7feb0455204b661d076b0012682fe17a46c65f6f4c8968'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.ok(pin.production_inspect.note.includes(`live_definition_sha256 ${PRODUCTION_PRE} (not the intended ${pin.intended_replacement_sha256}: already_applied false)`));
  assert.match(pin.production_inspect.note, /financial_totp_upsert_enrollment\(uuid, bytea, bytea, text\), financial_totp_get_enrollment\(uuid\), financial_totp_mark_verified\(uuid, bigint\) and financial_totp_status\(uuid\) each different, ACL \[PUBLIC EXECUTE grantor=owner, checksops EXECUTE grantor=owner, owner EXECUTE grantor=owner\]/);
  assert.match(pin.production_inspect.note, /prerequisites_missing \[\], missing_dependencies \[\], predecessors \{sql130: true\}, predecessors_applied true, successors_applied \[\], precondition_failures \[\]/);
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  // The earlier pending note is kept after "Earlier:", with the derived pre-state it named.
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: '));
  assert.match(pin.production_inspect.note, /SSM cfee4512-4988-4fd1-be77-b03d1b4cd50b/);
  assert.match(pin.production_inspect.note, /acl_functions_acl_replaceable/);
  assert.match(pin.production_inspect.note, /If already_applied is true, stop too/);
  // Staging acceptance: the guarded staging read-live (already in the intended state there; no staging apply), as SQL 119's.
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor read-live of sql131-financial-totp-functions-no-public, run 41107844336/);
  assert.match(pin.staging_acceptance.basis, /deploy run 41107423198/);
  assert.match(pin.staging_acceptance.basis, /already_applied true, precondition_failures \[\]/);
  assert.match(pin.staging_acceptance.basis, /no staging apply was needed or run/);
  assert.match(pin.staging_acceptance.basis, /the staging pin stays pending/);
  assert.ok(pin.staging_acceptance.basis.includes(`${pin.intended_replacement_sha256} == intended`));
  assert.ok(pin.staging_acceptance.basis.includes(`production (production_inspect) is ${PRODUCTION_PRE}`));
  assert.match(pin.staging_acceptance.basis, /each intended, ACL \[checksops EXECUTE grantor=owner, owner EXECUTE grantor=owner\]/);
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // The staging pin stays pending: no staging apply (an intended == expected pin cannot be bound).
  assert.equal(staging.execute, false);
  assert.equal(staging.authorization, 'pending');
  assert.equal(staging.expected_live_definition_sha256, null);
  assert.equal(pin.filename, SQL131_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, TEXT));
  assert.ok(pin.intended_post_state.note.includes(pin.intended_replacement_sha256));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].acl_functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, [...IDENTITIES]);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, ['sql130']);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'REVOKE_FINANCIAL_TOTP_PUBLIC_EXECUTE');
  assert.notEqual(pin.authorization_phrase, loadReleaseProductionPin('sql130', ROOT).authorization_phrase);
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql131-financial-totp-functions-no-public-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-131-apply.md');
  for (const file of [pin.tooling.production_tool, pin.tooling.runbook, pin.tooling.fingerprint_engine, pin.tooling.production_lib, ...pin.tooling.tests]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  }
  assert.equal(readPinnedReleaseSql(KEY, ROOT, pin).ok, true);
  // One-shot: the release tool, registered through RELEASE_PRODUCTION (no hash in the registry, no order).
  const tool = ONE_SHOT_TOOLS[KEY];
  assert.equal(tool.key, KEY);
  assert.equal(tool.script, RELEASE_PRODUCTION[KEY].cli);
  assert.deepEqual([...tool.args], []);
  assert.equal(tool.pin_rel, RELEASE_PRODUCTION[KEY].pin_rel);
  assert.equal(tool.allowed_key, 'sql131_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(RELEASE_SQL_SPECS[KEY].runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql131-financial-totp-functions-no-public-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql131-production-apply"\]/);
  assert.match(rows, /sql124, sql125, sql126, sql127, sql128, sql129, sql130, sql131, sql132, sql133\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql131-executor.test.mjs', 'aws/tests/release-sql131-production-apply.test.mjs', 'aws/tests/sql131-financial-totp-functions-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: predecessor SQL 130 and no order; the four ACL entries and the prerequisites; no function created or replaced, no table, view, policy, trigger, drop or plan entry; the file holds the guard and the eight grant statements; the API calls the four as checksops; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, ['sql130']);
  // SQL 130 is applied to staging (wave 28) and production (2026-10-30), so the predecessor is in place in both.
  const sql130 = loadReleaseProductionPin('sql130', ROOT);
  assert.equal(sql130.applied.result, 'applied');
  assert.equal(sql130.applied.post_apply_inspect.already_applied, true);
  assert.equal(STAGING.sql130.execute, true);
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.acl_functions.map((fn) => fn.identity), [...IDENTITIES]);
  for (const fn of spec.acl_functions) {
    assert.deepEqual(fn.acl, ['checksops EXECUTE grantor=owner', 'owner EXECUTE grantor=owner'], fn.identity);
    assert.deepEqual(fn.revokes, ['PUBLIC EXECUTE grantor=owner'], fn.identity);
    assert.equal(fn.attributes, undefined, fn.identity);
  }
  assert.deepEqual(spec.render, { grantors: true });
  assert.equal(spec.dropped_functions, undefined);
  assert.deepEqual(spec.prerequisites, [...IDENTITIES, 'role checksops']);
  for (const absent of ['tables', 'views', 'policies', 'triggers', 'altered_relations', 'definer_writes', 'supersedes', 'runs_before', 'refuse_after']) assert.equal(spec[absent], undefined, absent);
  assert.match(COMMITTED.order_note, /^Predecessor SQL 130 \(aws\/workflows\/sql\/130_financial_totp_rate_limit_code_check_no_public\.sql, applied to staging and production on 2026-10-30\)/);
  assert.match(COMMITTED.order_note, /SSM cfee4512-4988-4fd1-be77-b03d1b4cd50b/);
  assert.match(COMMITTED.order_note, /acl_functions_acl_replaceable/);
  assert.match(COMMITTED.order_note, /No API, Lambda or SPA change is part of this pin\./);
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.equal((plan.sql_prerequisites || {})[SQL131_FILE], undefined);
  assert.ok(!JSON.stringify(plan.members).includes(SQL131_FILE));
  // The API calls the four with these signatures, as checksops.
  const totp = fs.readFileSync(path.join(ROOT, 'aws/functions/api/auth-financial-totp.mjs'), 'utf8');
  const checkalt = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/production/checkalt-register.mjs'), 'utf8');
  assert.ok(totp.includes('SELECT enrolled_at, verified_at FROM public.financial_totp_status($1::uuid)'));
  assert.ok(totp.includes('FROM public.financial_totp_get_enrollment($1::uuid)'));
  assert.ok(totp.includes('SELECT public.financial_totp_upsert_enrollment($1::uuid, $2::bytea, $3::bytea, $4)'));
  assert.ok(totp.includes('SELECT public.financial_totp_mark_verified($1::uuid, $2::bigint) AS claimed'));
  assert.ok(checkalt.includes('FROM public.financial_totp_get_enrollment($1::uuid)'));
  assert.ok(checkalt.includes('SELECT public.financial_totp_mark_verified($1::uuid, $2::bigint) AS claimed'));
  assert.match(fs.readFileSync(path.join(ROOT, 'aws/functions/api/db-health.mjs'), 'utf8'), /export const EXPECTED_APPLICATION_ROLE = 'checksops';/);
  assert.match(fs.readFileSync(path.join(ROOT, 'aws/functions/api/data.mjs'), 'utf8'), /export const withIdentity = async \(event, fn, deps = \{\}\) =>/);
  // The file: one guard block, then exactly the four REVOKEs from PUBLIC and four GRANTs to checksops, in order; nothing else.
  const text = TEXT.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(text, /\bCREATE\b/i);
  assert.doesNotMatch(text, /\b(DROP|ALTER|COMMENT)\b/i);
  assert.doesNotMatch(text, /consume_financial_totp_rate_limit/);
  assert.equal([...text.matchAll(/\bDO\s+\$sql131_guard\$/g)].length, 1);
  assert.deepEqual([...text.matchAll(/^\s*(GRANT|REVOKE)\b.*$/gim)].map((m) => m[0].trim()), IDENTITIES.flatMap((identity) => [
    `REVOKE EXECUTE ON FUNCTION ${identity} FROM PUBLIC;`,
    `GRANT EXECUTE ON FUNCTION ${identity} TO checksops;`,
  ]));
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.ok(runbook.includes(PRODUCTION_PRE));
  assert.match(runbook, /\*\*Status:\*\* staging already in the intended state \(no apply\); production pin execute-authorized;\nproduction apply pending\./);
  assert.match(runbook, /SSM\s+`cfee4512-4988-4fd1-be77-b03d1b4cd50b`/);
  assert.match(runbook, /SSM\s+`be25e88a-1088-49af-81fa-10eecd8902b4`/);
  assert.match(runbook, /Staging read-live \(2026-10-30\)\.\*\* Run 41107844336/);
  assert.match(runbook, /Production inspect \(2026-10-30\)\.\*\*/);
  assert.match(runbook, /## How the executor treats a database already in the intended state/);
  assert.match(runbook, /UNRELATED_MUTATION/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql131` \|/);
  assert.match(oneShot, /`sql128`, `sql129`, `sql130`, `sql131`, `sql132`, `sql133`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql131-financial-totp-functions-no-public-production-apply\.mjs --inspect/);
});

test('the pending (pre-authorization) pin refuses before connecting; the committed pin allows only its own manifest; execute false, other hashes and phrases (SQL 130\'s included) refuse', async () => {
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

  // The committed (authorized) pin allows only the manifest bound to its recorded pre-state: not another
  // hash, not the intended state (which is staging's current state).
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql131_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(COMMITTED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(COMMITTED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql131_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  for (const phrase of ['APPLY', 'APPLY_FINANCIAL_TOTP_RATE_LIMIT_CODE_CHECK_NO_PUBLIC', 'APPLY_PROVIDER_STAKEHOLDER_SYNC_ACL']) {
    assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: phrase }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED, phrase);
  }
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash or predecessor list is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, predecessors: [] }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql131-cli-${process.pid}.json`);
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
