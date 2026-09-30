/**
 * The Signature overlay hole: accepted source tests can pass while the
 * candidate ZIP drops SQL44 routing. Deployment must inspect candidate
 * contents, not merely unrelated contract results.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { evaluateLambdaOverlay } from '../../scripts/deployment-guard/lib/lambda-overlay.mjs';
import { evaluateAcceptedContracts, loadContractRegistry, passingContractResults } from '../../scripts/deployment-guard/lib/contracts.mjs';
import { evaluateDeployment } from '../../scripts/deployment-guard/lib/guard.mjs';
import {
  evaluateAcceptedComposition,
  fixtureCandidateContents,
  loadAcceptedCompositionMarkers,
} from '../../scripts/deployment-guard/lib/accepted-composition.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = '2026-09-29T16:00:00.000Z';
const MARKERS = loadAcceptedCompositionMarkers(ROOT);

const REQUIRED_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

function overlayInput(overrides = {}) {
  return {
    workstream_id: 'workstream-a',
    branch: 'cursor/guard-a',
    commit: SHA,
    operator: 'test-agent',
    target_environment: 'staging',
    deployment_type: 'lambda-overlay',
    owned_members: ['workflow-rpc.mjs'],
    owned_components: ['workflow-rpc.mjs'],
    preflight: { codeSha256: 'live-code', revisionId: 'rev-1', lastModified: NOW },
    preflight_live_fingerprint: { codeSha256: 'live-code', revisionId: 'rev-1', lastModified: NOW },
    immediately_before: { codeSha256: 'live-code', revisionId: 'rev-1' },
    build_timestamp: NOW,
    package: { origin: 'fresh-live-download', downloaded_at: NOW, preflight_at: NOW },
    live_members: { 'workflow-rpc.mjs': 'old', 'write.mjs': 'keep' },
    candidate_members: { 'workflow-rpc.mjs': 'new', 'write.mjs': 'keep' },
    candidate_contents: fixtureCandidateContents(MARKERS),
    contract_results: passingContractResults(loadContractRegistry(ROOT)),
    ...overrides,
  };
}

test('accepted composition markers cover A-I and fail closed', () => {
  assert.deepEqual(MARKERS.markers.map((row) => row.id), REQUIRED_IDS);
  assert.equal(MARKERS.fail_closed, true);
});

test('missing candidate_contents fails even when source contracts pass', () => {
  const contracts = evaluateAcceptedContracts({
    registry: loadContractRegistry(ROOT),
    environment: 'staging',
    deployment_type: 'lambda-overlay',
    results: passingContractResults(loadContractRegistry(ROOT)),
  });
  assert.equal(contracts.ok, true);

  const overlay = evaluateLambdaOverlay(overlayInput({ candidate_contents: undefined }));
  assert.equal(overlay.ok, false);
  assert.equal(overlay.code, CODES.REGRESSION_DETECTED);
  assert.match(overlay.message, /candidate_contents/);
});

test('a Signature-era workflow-rpc without SQL44 routing is rejected', () => {
  const contents = fixtureCandidateContents(MARKERS);
  contents['workflow-rpc.mjs'] = [
    'export const SAFE_WRITE_RPCS = new Set([',
    "  'admin_set_check_claim',",
    ']);',
    'export const executeAdminSetCheckClaim = async () => {};',
    'accrueMortgageOpsAcceptedRequest',
  ].join('\n');

  const result = evaluateAcceptedComposition({
    candidate_contents: contents,
    markers: MARKERS,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.REGRESSION_DETECTED);
  const ids = result.errors.map((row) => row.details.marker_id);
  assert.ok(ids.includes('C'));
  assert.ok(ids.includes('D'));
});

test('evaluateDeployment cannot skip candidate composition via skip_contracts', () => {
  const contents = fixtureCandidateContents(MARKERS);
  delete contents['write-signature.mjs'];
  const result = evaluateDeployment(overlayInput({ candidate_contents: contents }), {
    root: ROOT,
    skip_contracts: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.REGRESSION_DETECTED);
  assert.match(result.message, /Signature|write-signature/);
});

test('current source composition satisfies every accepted marker', () => {
  const contents = {
    'write.mjs': fs.readFileSync(path.join(ROOT, 'aws/functions/api/write.mjs'), 'utf8'),
    'write-allowlist.mjs': fs.readFileSync(path.join(ROOT, 'aws/functions/api/write-allowlist.mjs'), 'utf8'),
    'write-app-metadata.mjs': fs.readFileSync(path.join(ROOT, 'aws/functions/api/write-app-metadata.mjs'), 'utf8'),
    'write-check-workflow.mjs': fs.readFileSync(path.join(ROOT, 'aws/functions/api/write-check-workflow.mjs'), 'utf8'),
    'write-signature.mjs': fs.readFileSync(path.join(ROOT, 'aws/functions/api/write-signature.mjs'), 'utf8'),
    'workflow-rpc.mjs': fs.readFileSync(path.join(ROOT, 'aws/functions/api/workflow-rpc.mjs'), 'utf8'),
    'write-claim-settlement.mjs': fs.readFileSync(path.join(ROOT, 'aws/functions/api/write-claim-settlement.mjs'), 'utf8'),
    'endorsement-material-invalidation.mjs': fs.readFileSync(
      path.join(ROOT, 'aws/functions/api/endorsement-material-invalidation.mjs'),
      'utf8',
    ),
  };
  const result = evaluateAcceptedComposition({ candidate_contents: contents, markers: MARKERS });
  assert.equal(result.ok, true);
  assert.deepEqual(result.details.checked, REQUIRED_IDS);
});
