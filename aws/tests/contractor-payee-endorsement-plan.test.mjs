// Contractor payee endorsement (owner 2026-11-18), planning only: the two API members, their
// planning manifest and their place in the production overlay plan. Nothing here deploys.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { localImports, resolvePlannedMember } from '../../scripts/deployment-guard/github-production-lambda-overlay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const API = 'aws/functions/api';
const RULE = 'endorsement-completion.mjs';
const HANDLER = 'check-endorsement.mjs';
const REL = 'aws/tests/fixtures/production-contractor-payee-endorsement-api-manifest-2026-11-18.json';
const APPLIED_REL = 'aws/tests/fixtures/production-contractor-payee-endorsement-api-applied-manifest-2026-11-18.json';
const LINK_EXPIRY = 'aws/tests/fixtures/production-endorsement-link-expiry-manifest-2026-10-31.json';
const PLAN = JSON.parse(read('ops/deployment-guard/production-api-overlay-plan.json'));
const MANIFEST = JSON.parse(read(REL));
const RECORD = JSON.parse(read(APPLIED_REL));
// Applied 2026-11-18 (production runs 44318086359 and 44320098887, VERIFIED): each row expects main's bytes and names the
// applied record. recordPre restates the plan as it stood before those applies: the planning manifest's live values.
const recordPre = (plan) => {
  for (const [name, entry] of Object.entries(MANIFEST.members)) {
    plan.members[name] = { ...plan.members[name], expected_live_sha256: entry.live_sha256, manifest: REL };
  }
  return plan;
};
// The endorsement copy notice plan (2026-11-18, planning only) moved check-endorsement.mjs on from the applied bytes.
// copyNoticePre reads its row as it stood before that plan; HANDLER_APPLIED is the bytes this work put live.
const COPY_NOTICE_REL = 'aws/tests/fixtures/production-endorsement-copy-notice-api-manifest-2026-11-18.json';
const COPY_NOTICE_APPLIED_REL = 'aws/tests/fixtures/production-endorsement-copy-notice-api-applied-manifest-2026-11-18.json';
// copyNoticeRecordPre reads the row as it stood before the copy notice apply (production run 44386297099).
const copyNoticeRecordPre = (plan) => {
  const row = plan.members[HANDLER];
  if (row?.manifest !== COPY_NOTICE_APPLIED_REL) return plan;
  const applied = JSON.parse(read(COPY_NOTICE_APPLIED_REL)).members[HANDLER];
  assert.equal(applied.previous_manifest, COPY_NOTICE_REL);
  const planned = JSON.parse(read(COPY_NOTICE_REL)).members[HANDLER];
  plan.members[HANDLER] = { ...row, expected_live_sha256: planned.live_sha256, manifest: COPY_NOTICE_REL };
  return plan;
};
const copyNoticePre = (plan0) => {
  const plan = copyNoticeRecordPre(plan0);
  const row = plan.members[HANDLER];
  if (row?.manifest !== COPY_NOTICE_REL) return plan;
  const entry = JSON.parse(read(COPY_NOTICE_REL)).members[HANDLER];
  assert.equal(entry.previous_manifest, APPLIED_REL);
  plan.members[HANDLER] = { ...row, accepted_sha256: entry.live_sha256, expected_live_sha256: entry.live_sha256, manifest: entry.previous_manifest };
  return plan;
};
// The endorsement email status plan (2026-11-19, planning only) moved check-endorsement.mjs on from the copy notice
// applied bytes; emailStatusPre reads the row as it stood before that plan, and PLAN_BEFORE_EMAIL_STATUS is that plan.
const EMAIL_STATUS_REL = 'aws/tests/fixtures/production-endorsement-email-status-api-manifest-2026-11-19.json';
const emailStatusPre = (plan) => {
  const row = plan.members[HANDLER];
  if (row?.manifest !== EMAIL_STATUS_REL) return plan;
  const entry = JSON.parse(read(EMAIL_STATUS_REL)).members[HANDLER];
  assert.equal(entry.previous_manifest, COPY_NOTICE_APPLIED_REL);
  assert.equal(row.expected_live_sha256, entry.live_sha256);
  plan.members[HANDLER] = { ...row, accepted_sha256: entry.live_sha256, expected_live_sha256: entry.live_sha256, manifest: entry.previous_manifest };
  return plan;
};
const PLAN_BEFORE_EMAIL_STATUS = emailStatusPre(structuredClone(PLAN));
const PLAN_AT_RECORD = copyNoticePre(structuredClone(PLAN_BEFORE_EMAIL_STATUS));
const HANDLER_APPLIED = PLAN_AT_RECORD.members[HANDLER].accepted_sha256;
const PRE = recordPre(structuredClone(PLAN_AT_RECORD));
const REBUILD = JSON.parse(read('ops/deployment-guard/lambda-rebuild-plan.json')).environments;

test('the manifest is planning only and quotes the owner', () => {
  assert.equal(MANIFEST.deploy_authorized, false);
  assert.match(MANIFEST.authorization, /^Pending owner review \(2026-11-18\)\. Planning only/);
  assert.match(MANIFEST.notes, /Sometimes contractors are in checks so we need to allow them to endorse checks/);
  assert.match(MANIFEST.notes, /Required like the insured/);
  assert.deepEqual(Object.keys(MANIFEST.members), [RULE, HANDLER]);
});

test('both rows accept main\'s bytes and expect the bytes the rebuild records say are live', () => {
  // endorsement-completion.mjs: the first staging rebuild's accepted bytes; no production section lists the file.
  const ruleLive = REBUILD.staging.history[0].members[RULE].accepted_sha256;
  for (const section of REBUILD.production.history) assert.equal(section.members[RULE], undefined);
  // check-endorsement.mjs: the fourth production rebuild's accepted bytes; no later production section lists it.
  const handlerLive = REBUILD.production.history[3].members[HANDLER].accepted_sha256;
  for (const section of REBUILD.production.history.slice(4)) assert.equal(section.members[HANDLER], undefined);
  const expected = {
    [RULE]: { live_sha256: ruleLive, accepted_sha256: sha256(read(`${API}/${RULE}`)), operation: 'replace' },
    [HANDLER]: { live_sha256: handlerLive, accepted_sha256: HANDLER_APPLIED, operation: 'replace', previous_manifest: LINK_EXPIRY },
  };
  assert.deepEqual(MANIFEST.members, expected);
  for (const name of [RULE, HANDLER]) {
    assert.notEqual(expected[name].live_sha256, expected[name].accepted_sha256, name);
    assert.deepEqual(PRE.members[name], {
      operation: 'replace',
      accepted_sha256: expected[name].accepted_sha256,
      expected_live_sha256: expected[name].live_sha256,
      sql_before: null,
      manifest: REL,
    }, name);
    assert.equal(resolvePlannedMember(name, { root: ROOT, plan: PLAN }).ok, true, name);
  }
  assert.equal(JSON.parse(read(LINK_EXPIRY)).members[HANDLER].accepted_sha256, handlerLive);
});

test('the rule file is applied first: it sits directly before its only importer, in the plan and in the workflow list', () => {
  const at = PLAN.order.indexOf(RULE);
  assert.ok(at >= 0);
  assert.equal(PLAN.order[at + 1], HANDLER);
  assert.ok(!PLAN.do_not_overlay.includes(RULE));
  const importers = fs.readdirSync(path.join(ROOT, API), { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.mjs') && name !== RULE)
    .filter((name) => /endorsement-completion\.mjs/.test(fs.readFileSync(path.join(ROOT, API, name), 'utf8')));
  assert.deepEqual(importers, [HANDLER]);
  assert.ok(localImports(read(`${API}/${HANDLER}`).toString('utf8'), HANDLER).includes(RULE));
  assert.deepEqual(localImports(read(`${API}/${RULE}`).toString('utf8'), RULE), []);
  const workflow = read('.github/workflows/guarded-production-lambda-overlay.yml').toString('utf8');
  assert.match(workflow, /\n {10}- endorsement-completion\.mjs\n {10}- check-endorsement\.mjs\n/);
});

test('the plan notes say what changes and that nothing is deployed', () => {
  const start = PLAN.notes.indexOf('Contractor payee endorsement API (2026-11-18');
  const note = PLAN.notes.slice(start, PLAN.notes.indexOf('Nothing deployed.', start) + 'Nothing deployed.'.length);
  assert.match(note, /endorsement-completion\.mjs REPLACE e0a162ce -> /);
  assert.match(note, /check-endorsement\.mjs REPLACE edd20078 -> /);
  assert.match(note, /read-only production overlay inspect before any apply/);
  assert.match(note, /Nothing deployed\.$/);
});

test('production record (2026-11-18): both members applied in plan order, VERIFIED; each row expects the applied bytes and names the record', () => {
  assert.equal(RECORD.workstream_id, 'contractor-payee-endorsement-api-applied');
  assert.equal(RECORD.deploy_authorized, false);
  assert.match(RECORD.authorization, /^Record only \(2026-11-18\)/);
  assert.equal(RECORD.live_lambda, 'checksops-production-prep-api');
  for (const name of [RULE, HANDLER]) {
    const onMain = name === HANDLER ? HANDLER_APPLIED : sha256(read(`${API}/${name}`));
    assert.deepEqual(RECORD.members[name], { live_sha256: onMain, accepted_sha256: onMain, operation: 'replace', previous_manifest: REL }, name);
    assert.deepEqual(PLAN_AT_RECORD.members[name], { operation: 'replace', accepted_sha256: onMain, expected_live_sha256: onMain, sql_before: null, manifest: APPLIED_REL }, name);
    assert.equal(resolvePlannedMember(name, { root: ROOT, plan: PLAN }).ok, true, name);
  }
  // Staging inspect, apply and re-inspect, then production preflight inspect, apply and re-inspect, rule file first.
  for (const runId of ['44315858736', '44315865681', '44316345194', '44316731775', '44316925585', '44316932630',
    '44317931221', '44318086359', '44318286948', '44319891664', '44320098887', '44320302787']) {
    assert.match(RECORD.notes, new RegExp(`\\b${runId}\\b`), runId);
    assert.match(PLAN.notes, new RegExp(runId), runId);
  }
  assert.ok(RECORD.notes.indexOf('44318086359') < RECORD.notes.indexOf('44320098887'));
  for (const text of ['dee497f4ec5d76d76a4513de01a08b1d0616f64c', '"run the API staging overlay"', '"DEPLOY endorsement-completion.mjs TO PRODUCTION"',
    '"DEPLOY check-endorsement.mjs TO PRODUCTION"', 'zi9Rq9nnbMupVkDzOJWrjvh9RbvJqJykZtinpoWUGgY=', '0bffc437-338c-4bb9-b16d-1724ef966632',
    'VERIFIED', 'ALREADY_ACCEPTED', 'errors []', 'index.mjs is untouched', 'Not verified by this record']) {
    assert.ok(RECORD.notes.includes(text), text);
  }
  assert.ok(PLAN.notes.includes(`Recorded in ${APPLIED_REL}. The rows expect the applied bytes and name the contractor payee endorsement applied record.`));
});

test('endorsement copy notice plan (2026-11-18, planning only): check-endorsement.mjs moves on from the applied bytes', () => {
  const plan = JSON.parse(read(COPY_NOTICE_REL));
  assert.equal(plan.deploy_authorized, false);
  assert.match(plan.authorization, /^Pending owner review \(2026-11-18\)\. Planning only/);
  assert.match(plan.notes, /contractor copies should not include the link/);
  assert.match(plan.notes, /add the \$ sign to emails for the endorsement request for checks/);
  // The bytes this plan put live: main's until the email status plan moved the row on (they stand for main's here).
  const onMain = PLAN_BEFORE_EMAIL_STATUS.members[HANDLER].accepted_sha256;
  assert.deepEqual(plan.members, { [HANDLER]: { live_sha256: RECORD.members[HANDLER].accepted_sha256, accepted_sha256: onMain, operation: 'replace', previous_manifest: APPLIED_REL } });
  assert.notEqual(onMain, RECORD.members[HANDLER].accepted_sha256);
  const beforeApply = copyNoticeRecordPre(structuredClone(PLAN_BEFORE_EMAIL_STATUS));
  assert.deepEqual(beforeApply.members[HANDLER], { operation: 'replace', accepted_sha256: onMain, expected_live_sha256: RECORD.members[HANDLER].accepted_sha256, sql_before: null, manifest: COPY_NOTICE_REL });
  assert.equal(resolvePlannedMember(HANDLER, { root: ROOT, plan: PLAN }).ok, true);
  // The rule file is unchanged: still the applied bytes.
  assert.equal(PLAN.members[RULE].manifest, APPLIED_REL);
  assert.ok(PLAN.notes.includes(`Manifest ${COPY_NOTICE_REL}. Nothing deployed.`));
  // Applied 2026-11-18 (owner "DEPLOY check-endorsement.mjs TO PRODUCTION"): the row expects main's bytes and names the
  // applied record, which chains to the planning manifest.
  const record = JSON.parse(read(COPY_NOTICE_APPLIED_REL));
  assert.equal(record.workstream_id, 'endorsement-copy-notice-api-applied');
  assert.equal(record.deploy_authorized, false);
  assert.match(record.authorization, /^Record only \(2026-11-18\)/);
  assert.deepEqual(record.members, { [HANDLER]: { live_sha256: onMain, accepted_sha256: onMain, operation: 'replace', previous_manifest: COPY_NOTICE_REL } });
  assert.deepEqual(PLAN_BEFORE_EMAIL_STATUS.members[HANDLER], { operation: 'replace', accepted_sha256: onMain, expected_live_sha256: onMain, sql_before: null, manifest: COPY_NOTICE_APPLIED_REL });
  for (const runId of ['44385524455', '44385683342', '44385877535', '44386145749', '44386297099', '44386464914']) {
    assert.match(record.notes, new RegExp(`\\b${runId}\\b`), runId);
    assert.match(PLAN.notes, new RegExp(runId), runId);
  }
  for (const text of ['8c207d4075d17d0d65427e4341a50b3864193eae', '"run the API staging overlay"', '"DEPLOY check-endorsement.mjs TO PRODUCTION"',
    'RXdhPzXIvGDCBa4LWirOhn/m7Nrz23ZZpVUFR57wkcc=', '7879cc8a-b71d-4c57-9841-fe4c184a9246', 'VERIFIED', 'ALREADY_ACCEPTED', 'errors []',
    'index.mjs is untouched', 'Not verified by this record']) {
    assert.ok(record.notes.includes(text), text);
  }
  assert.ok(PLAN.notes.includes(`Recorded in ${COPY_NOTICE_APPLIED_REL}. The row expects the applied bytes and names the endorsement copy notice applied record.`));
  // The new import is a module the live package already carries.
  assert.match(read(`${API}/${HANDLER}`).toString('utf8'), /import \{ renderChecksOpsEmail \} from '\.\/email-layout\.mjs';/);
  assert.ok(fs.existsSync(path.join(ROOT, API, 'email-layout.mjs')));
});
