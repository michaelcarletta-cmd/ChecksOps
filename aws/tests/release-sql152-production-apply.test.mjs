/**
 * Production tool for SQL 152 (scripts/deployment-guard/sql152-invoice-and-failed-deposit-fees-production-apply.mjs on
 * lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 152 included) through the shared refusals;
 * this file covers SQL 152's own:
 *
 *   - the pin has the release pin shape; it is execute-authorized (owner-approved pin change of 2026-11-11) with the
 *     recorded production pre-state (read-only inspect; the derived one, the same one staging had) and the staging apply
 *     as its acceptance; it is in step with the staging pin, the one-shot, the bypass inventory and the test lists;
 *   - no predecessor; the new table with no grant to anyone (every non-owner grant revoked, as SQL 118), five owner-only
 *     functions, two triggers, the partial unique index, four columns; the overlay plan holds
 *     tenant-fee-invoice-email.mjs on SQL 152 (not live); SQL 149 has no pin; the runbook, one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; the committed pin allows only the manifest bound
 *     to its recorded pre-state; an approved, accepted copy evaluates for the manifest built from it,
 *     and refuses with execute false, another live hash, another staging reference or a wrong phrase; the CLI spends no
 *     receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql152-usage-fees-pg.test.mjs; the executor path is
 * aws/tests/release-sql152-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql152-invoice-and-failed-deposit-fees-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql152';
const SQL152_FILE = 'aws/workflows/sql/152_invoice_and_failed_deposit_fees.sql';
const SQL149_FILE = 'aws/workflows/sql/149_invoice_and_failed_deposit_fees.sql';
const IDENTITIES = Object.freeze([
  'public.aws_usage_fee_launched_at()',
  'public.aws_invoice_fee_cents()',
  'public.aws_failed_deposit_fee_cents()',
  'public.aws_record_invoice_fee()',
  'public.aws_record_failed_deposit_fee()',
]);
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
// SQL 152's recorded production pre-state (read-only inspect of 2026-11-11, SSM 15087959, main 9bbe1d2a1): everything
// absent, the derived pre-state (release-sql152-executor.test.mjs); staging recorded the same (read-live run 42945948226).
const PRODUCTION_PRE = '99c391367eaf941dae2a89cf78d72ae87fff5559d2fc3c26ad7acc691f1a4a5e';
// The guarded staging apply (wave 45).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43005316840';
// The owner's words for SQL 152, quoted in the authorization (no separate staging acceptance statement was given).
const OWNER_WORDS = Object.freeze(['"work on these fixes"', '"Yes"', '"Merge it when green"', '"record the SQL 152 staging pin and merge it when green"', '"apply SQL 152 in staging"', '"Yes if that is next"', '"record the SQL 152 production pin"']);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql152-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
  // Owner-approved pin change of 2026-11-11: the read-only production inspect (SSM 15087959, main 9bbe1d2a1) recorded as
  // the pre-state; the staging apply (run 43005316840) as the acceptance.
  assert.equal(pin.execute, true);
  assert.match(pin.authorization, /^Owner approved 2026-11-11 /);
  for (const words of OWNER_WORDS) assert.ok(pin.authorization.includes(words), words);
  assert.match(pin.authorization, /no separate staging acceptance statement was given/);
  assert.ok(pin.authorization.includes(`${PRODUCTION_PRE} -> ${pin.intended_replacement_sha256}`));
  assert.match(pin.authorization, /execute true takes effect only when the owner reviews and merges this change\. It does not itself run or approve a run/);
  assert.match(pin.authorization, /each apply still needs the owner's run-time approval/);
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied, undefined);
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-11-11');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, '15087959-5dfe-463d-950a-267eb2039905');
  assert.equal(pin.production_inspect.source_commit, '9bbe1d2a1366b2684c9abf1eb050daa6a6211352');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('cf7f2f6761277b065bdeb4e8fd94bc16e38cf8d85d756867bbea116e5cb442ec'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.match(pin.production_inspect.note, /already_applied false\), live_matches_expected false, precondition_failures \[\], apply_preconditions_met false, errors \[\]/);
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no release-engine production inspect has been run for SQL 152 yet.'));
  for (const name of ['prerequisites_missing', 'definer_writes', 'already_applied false', 'precondition_failures']) {
    assert.ok(pin.production_inspect.note.includes(name), name);
  }
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql152-invoice-and-failed-deposit-fees, run 43005316840/);
  assert.match(pin.staging_acceptance.basis, /deploy run 43004839952/);
  assert.match(pin.staging_acceptance.basis, /Read-live run 43005694458 \(job 130472501828\) then reported already_applied true/);
  assert.match(pin.staging_acceptance.basis, /under the owner's words "apply SQL 152 in staging"/);
  assert.match(pin.staging_acceptance.basis, /no separate staging acceptance statement was given/);
  assert.ok(pin.staging_acceptance.basis.includes(`before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // The staging pin recorded the same pre-state (wave 45).
  assert.equal(staging.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.filename, SQL152_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL152_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, [...IDENTITIES]);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_INVOICE_AND_FAILED_DEPOSIT_FEES');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql152-invoice-and-failed-deposit-fees-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-152-apply.md');
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
  assert.equal(tool.allowed_key, 'sql152_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(RELEASE_SQL_SPECS[KEY].runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  // SQL 149, never applied, has no tool, pin or spec.
  assert.equal(ONE_SHOT_TOOLS.sql149, undefined);
  assert.equal(RELEASE_PRODUCTION.sql149, undefined);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql152-invoice-and-failed-deposit-fees-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql152-production-apply"\]/);
  assert.match(rows, /sql147, sql148, sql150, sql152\)/);
  assert.doesNotMatch(rows, /sql149/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql152-executor.test.mjs', 'aws/tests/release-sql152-production-apply.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; the new table with no grant to anyone, five owner-only functions, two triggers, the partial unique index, four columns; the overlay plan holds the invoice email on SQL 152 (not live); the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.supersedes, undefined);
  assert.deepEqual(spec.functions.map((fn) => fn.identity), [...IDENTITIES]);
  for (const fn of spec.functions) {
    assert.deepEqual(fn.acl, ['owner EXECUTE'], fn.identity);
    assert.equal(fn.revokes, undefined, fn.identity);
  }
  assert.ok(spec.prerequisites.includes('public.aws_record_checkalt_billing_event()'));
  for (const relation of ['public.check_billing_events', 'public.checkalt_deposits', 'public.moov_invoices', 'public.tenant_maintenance_payments']) {
    assert.ok(spec.prerequisites.includes(relation), relation);
    assert.ok(spec.altered_relations.includes(relation), relation);
  }
  assert.deepEqual(spec.definer_writes, ['public.check_billing_events']);
  assert.deepEqual(spec.tables.map((t) => [t.name, t.acl]), [['public.tenant_usage_fee_launch', []]]);
  for (const absent of ['views', 'policies', 'table_privileges', 'column_acl', 'dropped_functions', 'acl_functions']) assert.equal(spec[absent], undefined, absent);
  assert.match(COMMITTED.order_note, /^No predecessor \(as SQL 120 for SQL 98\)/);
  assert.match(COMMITTED.order_note, /SQL 152 replaces SQL 149, never applied and given no spec or pin/);
  assert.match(COMMITTED.order_note, /definer_can_write_relations/);
  assert.match(COMMITTED.order_note, /No API, Lambda or SPA change is part of this pin\./);
  assert.match(COMMITTED.order_note, /SQL 151 \(the Starter Package\) must not be applied before SQL 152\./);
  // The overlay plan holds tenant-fee-invoice-email.mjs on SQL 152, recorded not live (this change does not touch it).
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.deepEqual(plan.sql_prerequisites[SQL152_FILE], { verified_live: false, evidence: null });
  assert.equal(plan.members['tenant-fee-invoice-email.mjs'].sql_before, SQL152_FILE);
  assert.equal(plan.sql_prerequisites[SQL149_FILE], undefined);
  // SQL 152's statements outside function bodies: two DO blocks, one table, the launch row, no GRANT or policy.
  const text = fs.readFileSync(path.join(ROOT, SQL152_FILE), 'utf8').replace(/--[^\n]*/g, '');
  const outside = text.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$');
  assert.doesNotMatch(outside, /\bGRANT\b/);
  assert.doesNotMatch(outside, /\bCREATE\s+(POLICY|VIEW)\b/i);
  assert.doesNotMatch(outside, /\b(TRUNCATE|DELETE)\b/);
  assert.equal([...outside.matchAll(/\bDO\s+\$/g)].length, 2);
  assert.deepEqual([...outside.matchAll(/\bCREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\S+)/gi)].map((m) => m[1]), ['public.tenant_usage_fee_launch']);
  assert.deepEqual([...outside.matchAll(/\bINSERT\s+INTO\s+(\S+)/gi)].map((m) => m[1]), ['public.tenant_usage_fee_launch']);
  assert.deepEqual([...outside.matchAll(/^\s*REVOKE\b.*$/gim)].map((m) => m[0].trim()),
    IDENTITIES.map((identity) => `REVOKE ALL ON FUNCTION ${identity} FROM PUBLIC;`));
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* applied in staging \(wave 45, 2026-11-11\); staging acceptance: the staging apply under the owner's run approval \("apply SQL 152 in staging"; no separate acceptance statement\); production pin execute-authorized; not applied to production/);
  assert.match(runbook, /SSM\s+`15087959-5dfe-463d-950a-267eb2039905`/);
  assert.match(runbook, /\*\*Staging apply \(2026-11-11\)\.\*\* Apply run 43005316840/);
  assert.match(runbook, /\*\*Predecessor\.\*\* None/);
  for (const words of ['"work on these fixes"', '"Yes"', '#1747', '#1758', 'run 40434533070']) {
    assert.ok(runbook.replace(/\s+/g, ' ').includes(words), words);
  }
  assert.match(runbook, /APPLY_INVOICE_AND_FAILED_DEPOSIT_FEES/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql152` \|/);
  assert.match(oneShot, /`sql148`, `sql150`, `sql152`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql152-invoice-and-failed-deposit-fees-production-apply\.mjs --inspect/);
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
  assert.equal(committedOk.details.sql152_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(COMMITTED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(COMMITTED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql152_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // SQL 150's phrase does not authorize SQL 152.
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY_EXTERNAL_DISBURSEMENT_UP_TO_CHECK_AMOUNT' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql152-cli-${process.pid}.json`);
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
