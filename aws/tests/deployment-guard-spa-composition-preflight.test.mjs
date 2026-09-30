/**
 * Official SPA preflight CLI must forward accepted_source_composition
 * to the production gate. Composition evidence never grants approval.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { evaluateAcceptedSourceComposition } from '../../scripts/deployment-guard/lib/production.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CANDIDATE = '17fa334d69fb9ca673bcde462b5bb0632e42f3dc';
const NOW = '2026-09-30T19:00:00.000Z';
const WORKSTREAMS = [
  'settings-billing-branding-deposits-51c8',
  'walletops-funding-prod-2d41',
];
const MANIFEST = {
  id: 'settings-prod-spa-source-composition',
  accepted_composition: true,
};

function spaInput(overrides = {}) {
  return {
    workstream_id: 'settings-billing-branding-deposits-51c8',
    branch: 'cursor/compose-prod-spa-settings-51c8',
    commit: CANDIDATE,
    operator: 'test-agent',
    target_environment: 'production',
    target_component: 'production-spa',
    deployment_type: 'spa-promote',
    owned_components: ['index.html'],
    build_timestamp: NOW,
    preflight: { index_html_sha256: 'idx', entry_bundle: '/assets/index-C_fh5VBD.js' },
    preflight_live_fingerprint: { index_html_sha256: 'idx', entry_bundle: '/assets/index-C_fh5VBD.js' },
    immediately_before: { index_html_sha256: 'idx', entry_bundle: '/assets/index-C_fh5VBD.js' },
    frontend_workstreams: WORKSTREAMS,
    accepted_composition: true,
    accepted_source_composition: true,
    source_composition_manifest: MANIFEST,
    dist: { clean_build: true },
    production_fingerprint: { revisionId: '1' },
    immediately_before_fingerprint: { revisionId: '1' },
    staging_acceptance: { ok: true, reference: 'staging#compose' },
    approval: { approved: false, workstream_id: 'settings-billing-branding-deposits-51c8' },
    ...overrides,
  };
}

function runOfficialPreflight(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-composition-preflight-'));
  const file = path.join(dir, 'input.json');
  fs.writeFileSync(file, `${JSON.stringify(input)}\n`);
  const spawned = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/deployment-guard/preflight.mjs'),
    '--input',
    file,
    '--skip-contracts',
  ], { encoding: 'utf8' });
  const text = `${spawned.stdout || ''}${spawned.stderr || ''}`;
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: spawned.status, parsed, text };
}

function codes(result) {
  return (result.parsed?.errors || []).map((row) => row.code);
}

test('official CLI forwards valid composition evidence to the production gate', () => {
  const result = runOfficialPreflight(spaInput());
  assert.notEqual(result.status, 0);
  assert.ok(!codes(result).includes(CODES.SOURCE_COMPOSITION_REQUIRED), result.text);
  assert.ok(codes(result).includes(CODES.PRODUCTION_APPROVAL_REQUIRED), result.text);
});

test('official CLI does not infer accepted_source_composition from accepted_composition', () => {
  const result = runOfficialPreflight(spaInput({
    accepted_composition: true,
    accepted_source_composition: undefined,
  }));
  assert.notEqual(result.status, 0);
  assert.ok(codes(result).includes(CODES.SOURCE_COMPOSITION_REQUIRED), result.text);
});

test('missing composition evidence fails closed', () => {
  const missing = evaluateAcceptedSourceComposition(spaInput({
    accepted_source_composition: undefined,
  }));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, CODES.SOURCE_COMPOSITION_REQUIRED);
});

test('invalid composition evidence fails closed', () => {
  for (const evidence of ['true', 1, ['accepted'], { accepted: false }, { accepted: 'yes' }]) {
    const result = evaluateAcceptedSourceComposition(spaInput({
      accepted_source_composition: evidence,
    }));
    assert.equal(result.ok, false, JSON.stringify(evidence));
    assert.equal(result.code, CODES.SOURCE_COMPOSITION_REQUIRED, JSON.stringify(evidence));
  }
});

test('mismatched composition evidence fails closed', () => {
  const flagMismatch = runOfficialPreflight(spaInput({
    accepted_composition: false,
    accepted_source_composition: true,
  }));
  assert.notEqual(flagMismatch.status, 0);
  assert.ok(codes(flagMismatch).includes(CODES.SOURCE_COMPOSITION_REQUIRED), flagMismatch.text);

  const workstreamMismatch = evaluateAcceptedSourceComposition(spaInput({
    accepted_source_composition: {
      accepted: true,
      workstreams: ['settings-billing-branding-deposits-51c8'],
      manifest: MANIFEST,
    },
  }));
  assert.equal(workstreamMismatch.ok, false);
  assert.equal(workstreamMismatch.code, CODES.SOURCE_COMPOSITION_REQUIRED);

  const missingManifest = evaluateAcceptedSourceComposition(spaInput({
    source_composition_manifest: null,
    accepted_source_composition: true,
  }));
  assert.equal(missingManifest.ok, false);
  assert.equal(missingManifest.code, CODES.SOURCE_COMPOSITION_REQUIRED);
});

test('composition evidence does not grant production approval', () => {
  const result = runOfficialPreflight(spaInput({
    approval: { approved: true, workstream_id: 'some-other-workstream' },
  }));
  assert.notEqual(result.status, 0);
  assert.ok(!codes(result).includes(CODES.SOURCE_COMPOSITION_REQUIRED), result.text);
  assert.ok(codes(result).includes(CODES.PRODUCTION_APPROVAL_REQUIRED), result.text);
  assert.match(result.text, /never infer production approval from a previous workstream/);
});
