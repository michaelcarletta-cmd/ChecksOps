import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertIndexLast,
  assertNoSyncDelete,
  evaluateLiveGraph,
  localManifest,
  simulatePromotion,
  verifyRemoteObject,
  walkRemoteGraph,
} from '../../scripts/lib/spa-promote-guard.mjs';
import { walkLocalDirectory } from '../../scripts/lib/spa-dependency-graph.mjs';
import { main as spaCli } from '../../scripts/production-spa-promote-guard.mjs';
import { assertProductionSpaBuild, parseEnvText } from '../../scripts/lib/spa-production-build-guard.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spa-guard-'));

const writeTree = (root, files) => {
  for (const [name, body] of Object.entries(files)) {
    const dest = path.join(root, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
  }
};

const completeTree = () => ({
  'index.html': '<html><script type="module" src="/assets/index-AAA.js"></script><link rel="stylesheet" href="/assets/index-BBB.css"></html>',
  'assets/index-AAA.js': `
    import("./CheckCommandCenter-CCC.js");
    import("./EndorsementChecklist-DDD.js");
    import("./AdminMortgageOps-EEE.js");
    import("./AdminTenants-FFF.js");
  `,
  'assets/index-BBB.css': 'body{background:url(/favicon.png)}',
  'assets/CheckCommandCenter-CCC.js': 'import("./nested-claim-HHH.js"); export default 1;',
  'assets/EndorsementChecklist-DDD.js': 'export default 2;',
  'assets/AdminMortgageOps-EEE.js': 'export default 3;',
  'assets/AdminTenants-FFF.js': 'export default 4;',
  'assets/nested-claim-HHH.js': 'export const helper = true;',
  'favicon.png': 'png',
});

test('nested dynamic SPA import missing fails preflight', () => {
  const dir = tmp();
  const files = completeTree();
  delete files['assets/nested-claim-HHH.js'];
  writeTree(dir, files);
  const result = localManifest(dir);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /nested-claim-HHH/);
});

test('lazy route dependency missing fails preflight', () => {
  const dir = tmp();
  const files = completeTree();
  delete files['assets/AdminMortgageOps-EEE.js'];
  writeTree(dir, files);
  const result = localManifest(dir);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /AdminMortgageOps|mortgage_desk|missing/);
});

test('asset that resolves to HTML instead of JS/CSS fails', () => {
  const result = verifyRemoteObject({
    key: 'assets/CheckCommandCenter-CCC.js',
    bytes: Buffer.from('<!doctype html><html><body>index fallback</body></html>'),
    contentType: 'text/html',
    expectedSha: 'nope',
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /HTML fallback/);
});

test('index attempted before all assets pass verification fails', () => {
  const early = assertIndexLast(['index.html', 'assets/index-AAA.js']);
  assert.equal(early.ok, false);
  const dir = tmp();
  writeTree(dir, completeTree());
  const result = simulatePromotion({
    distDir: dir,
    uploadSequence: ['index.html', ...Object.keys(completeTree()).filter((k) => k !== 'index.html')],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /must not switch|uploaded before/);
});

test('staging .env.aws production promotion is refused', () => {
  const env = parseEnvText(fs.readFileSync(new URL('../../.env.aws', import.meta.url), 'utf8'));
  const result = assertProductionSpaBuild({ mode: 'aws', env });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /mode aws|staging/);
});

test('s3 sync --delete is prohibited', () => {
  const result = assertNoSyncDelete(['aws', 's3', 'sync', 'dist', 's3://bucket', '--delete']);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /sync --delete is prohibited/);
  assert.equal(spaCli(['--forbid-sync-delete', '--', 's3', 'sync', '--delete', 's3://x']), 1);
  assert.equal(spaCli(['--forbid-sync-delete', '--', 's3', 'cp', 'file', 's3://x']), 0);
});

test('complete candidate graph PASSES simulate with index last', () => {
  const dir = tmp();
  writeTree(dir, completeTree());
  const result = simulatePromotion({ distDir: dir });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.stats.missing_count, 0);
  assert.equal(result.surfaces.claim_check.present, true);
  assert.equal(result.surfaces.payee_endorsements.present, true);
  assert.equal(result.surfaces.mortgage_desk.present, true);
  assert.equal(result.surfaces.admin_tenant_moov_billing.present, true);
  assert.equal(result.uploadSequence.at(-1), 'index.html');
});

test('remote live graph fails when a lazy chunk returns HTML', () => {
  const files = completeTree();
  const graph = walkRemoteGraph({
    fetchObject: (key) => {
      if (key === 'assets/CheckCommandCenter-CCC.js') {
        return { bytes: Buffer.from('<!doctype html><html></html>'), contentType: 'text/html' };
      }
      if (!(key in files)) return { missing: true };
      return { bytes: Buffer.from(files[key]), contentType: key.endsWith('.js') ? 'application/javascript' : 'text/css' };
    },
  });
  const result = evaluateLiveGraph(graph);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /HTML fallback/);
});

test('accepted R1 production SPA artifact PASSES complete-graph walk when present', (t) => {
  const spa = '/opt/cursor/artifacts/r1-2d-prod-candidate/spa';
  if (!fs.existsSync(path.join(spa, 'index.html'))) {
    t.skip('accepted R1 SPA artifact not present in this environment');
    return;
  }
  const graph = walkLocalDirectory(spa);
  const result = evaluateLiveGraph(graph);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.stats.missing_count, 0);
  assert.ok(result.stats.present_count >= 90, `expected a complete graph, got ${result.stats.present_count}`);
  assert.equal(result.surfaces.claim_check.present, true);
  assert.equal(result.surfaces.payee_endorsements.present, true);
  assert.equal(result.surfaces.mortgage_desk.present, true);
  assert.equal(result.surfaces.admin_tenant_moov_billing.present, true);
});
