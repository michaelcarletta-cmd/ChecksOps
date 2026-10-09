import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIN_PATH = path.join(ROOT, 'ops/deployment-guard/staging-settlement-rpc-verified.json');
const LOCKS_PATH = path.join(ROOT, 'ops/release-locks/locked-components.json');

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const PIN = JSON.parse(fs.readFileSync(PIN_PATH, 'utf8'));

test('post-add pin is evaluate-only and records DEPLOYMENT VERIFIED', () => {
  assert.equal(PIN.id, 'staging-settlement-rpc-verified');
  assert.equal(PIN.authorization, 'source-only');
  assert.equal(PIN.apply_authorized, false);
  assert.equal(PIN.execute, false);
  assert.equal(PIN.deploy, false);
  assert.equal(PIN.write_authorized, false);
  assert.equal(PIN.production_changes, false);
  assert.equal(PIN.verdicts.deployment, 'DEPLOYMENT VERIFIED');
  assert.equal(PIN.verdicts.uat, 'UAT READY');
  assert.equal(PIN.verdicts.uat_live_writes, 'BLOCKED');
  assert.equal(PIN.verdicts.production, 'NOT READY');
});

test('live ADD member and preserved hashes match current main source bytes', () => {
  assert.equal(
    sha256File(path.join(ROOT, 'aws/functions/api/claim-settlement-rpc.mjs')),
    PIN.members['claim-settlement-rpc.mjs'].sha256,
  );
  assert.equal(PIN.members['claim-settlement-rpc.mjs'].present, true);
  assert.equal(
    PIN.members['claim-settlement-rpc.mjs'].sha256,
    '4d0b312cadaeffb7bff2d96eea9c4815a1f23815c9c9dcbdbceea4e4d3203d64',
  );
  assert.equal(
    sha256File(path.join(ROOT, 'aws/functions/api/data.mjs')),
    PIN.members['data.mjs'].sha256,
  );
  assert.equal(
    sha256File(path.join(ROOT, 'aws/functions/api/workflow.mjs')),
    PIN.members['workflow.mjs'].sha256,
  );
  assert.equal(
    sha256File(path.join(ROOT, 'aws/functions/api/workflow-rpc.mjs')),
    PIN.members['workflow-rpc.mjs'].sha256,
  );
  assert.equal(
    sha256File(path.join(ROOT, 'aws/functions/api/workflow-flags.mjs')),
    PIN.members['workflow-flags.mjs'].sha256,
  );
  assert.notEqual(
    sha256File(path.join(ROOT, 'aws/functions/api/workflow-transitions.mjs')),
    PIN.members['workflow-transitions.mjs'].sha256,
  );
  assert.equal(PIN.members['workflow-transitions.mjs'].preserved, true);
});

test('post-add CAS is distinct from the pre-apply inspect fingerprint', () => {
  assert.equal(PIN.overlay.approved_commit, '3b186ef27f9a3e27a10b8368ef2eb737998898f2');
  assert.equal(PIN.overlay.apply_run, 37978873773);
  assert.equal(PIN.overlay.pre_apply_codeSha256, '+U2BumLiTZSNZe4N9rAkMinxS4k/UyOvfcyYdMrOuu4=');
  assert.equal(PIN.overlay.pre_apply_revisionId, '455f7685-97d1-4dc0-a7bc-b58ce7ba4e93');
  assert.equal(PIN.live_staging_api.CodeSha256, 'qo8at+HVvSWazJPUF/A9owFtOey8MNhzISLOMC+bMdw=');
  assert.equal(PIN.live_staging_api.RevisionId, '3e8c95ca-9e28-46c8-b2bf-b43b633145d6');
  assert.notEqual(PIN.live_staging_api.CodeSha256, PIN.overlay.pre_apply_codeSha256);
  assert.notEqual(PIN.live_staging_api.RevisionId, PIN.overlay.pre_apply_revisionId);
  assert.equal(PIN.public_smoke['/health'].httpStatus, 200);
  assert.equal(PIN.public_smoke['/db-health'].httpStatus, 200);
  assert.equal(PIN.public_smoke['/db-readonly-validate'].httpStatus, 200);
  assert.equal(PIN.public_smoke['/db-readonly-validate'].readOnly, true);
});

test('SQL 53 pin stays exact and does not write the homeowner ledger', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/53_claim_settlement_breakdown.sql'), 'utf8');
  assert.equal(sha256File(path.join(ROOT, 'aws/workflows/sql/53_claim_settlement_breakdown.sql')), PIN.sql53.source_sha256);
  assert.equal(PIN.sql53.definitionSha256, '6542c3f6fb3f7d50b758b3d7352fe6fb49cbe8cd2bd5c6061dbc35a6e9fccf52');
  assert.equal(PIN.sql53.writes_homeowner_ledger, false);
  assert.doesNotMatch(sql, /homeowner_ledger_events|sync_homeowner_ledger_from_check|hle_on_check_intake_insert/);
  assert.match(sql, /INSERT INTO public\.claim_settlements/);
  assert.match(sql, /UPDATE public\.claim_settlements/);
  assert.doesNotMatch(sql, /pwi_deductible/);
});

test('UAT plan forbids customer claims and does not authorize live writes', () => {
  assert.equal(PIN.uat.approved_identity.tenant_id, '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a');
  assert.equal(PIN.uat.cross_tenant_deny.tenant_id, '4f172140-f57a-4744-8050-95f4f07b13b4');
  assert.ok(PIN.uat.forbidden_claims.some((row) => row.includes('695064-GQ')));
  assert.ok(PIN.uat.required_before_live_writes.includes('Separate owner authorization for staging settlement writes'));
  assert.equal(PIN.uat.no_financial_providers, true);
  assert.deepEqual(PIN.uat.cases.map((row) => row.id), [
    'dwelling-os-pp',
    'deductible-depreciation',
    'ordinance-law-pwi',
    'ledger-isolation',
    'update-no-duplicate',
    'auth-tenant',
    'invalid-input',
  ]);
});

test('production plan keeps the locked SPA and live-only members', () => {
  const locks = JSON.parse(fs.readFileSync(LOCKS_PATH, 'utf8'));
  assert.equal(locks.components['production-spa'].classification, 'PRODUCTION_LOCKED');
  assert.equal(locks.components['production-spa'].artifact.name, PIN.production.production_spa.artifact);
  assert.equal(PIN.production.ready, false);
  assert.equal(PIN.production.live_lambda.CodeSha256, 'DMcCoF3dpIiULPe530F8DJ8vC1wL1BP7ayqr+e8SCyI=');
  assert.equal(PIN.production.live_lambda.RevisionId, 'fb17cb70-7b50-468d-a0a6-59a020c43f8c');
  assert.ok(PIN.production.do_not.some((row) => row.includes('index-CBOwj-7W.js')));
  assert.ok(PIN.production.do_not.some((row) => row.includes('write-claim-settlement.mjs')));
  assert.equal(PIN.production.sequence_when_separately_authorized[0].intended_definition_sha256, PIN.sql53.definitionSha256);
  assert.equal(PIN.production.sequence_when_separately_authorized[1].member_sha256, PIN.members['claim-settlement-rpc.mjs'].sha256);
});
