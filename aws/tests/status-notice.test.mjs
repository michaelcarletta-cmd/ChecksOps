import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { buildStatusDocument, main, PRODUCTION_CONFIRMATION } from '../../scripts/status-notice.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/spa-status-notice.yml'), 'utf8');
const NOW = new Date('2026-10-16T12:00:00Z');
const POST = { environment: 'staging', action: 'post', title: 'Maintenance', message: 'Back soon', severity: 'maintenance' };

const build = (over = {}) => buildStatusDocument({ ...POST, ...over }, { now: NOW, runId: '42' });

test('post builds a single validated notice', () => {
  const result = build({ starts_at: '2026-10-16T13:00:00+01:00', ends_at: '2026-10-16T14:00:00Z' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.document, {
    announcements: [{
      id: 'status-42',
      title: 'Maintenance',
      message: 'Back soon',
      severity: 'maintenance',
      starts_at: '2026-10-16T12:00:00.000Z',
      ends_at: '2026-10-16T14:00:00.000Z',
      updated_at: '2026-10-16T12:00:00.000Z',
    }],
  });
});

test('clear writes an empty notice list', () => {
  assert.deepEqual(buildStatusDocument({ environment: 'staging', action: 'clear' }).document, { announcements: [] });
});

test('input validation uses the same limits as the API', () => {
  const field = (over) => build(over).field;
  assert.equal(build({ title: 'x'.repeat(120) }).ok, true);
  assert.equal(field({ title: 'x'.repeat(121) }), 'title');
  assert.equal(field({ title: '   ' }), 'title');
  assert.equal(field({ message: 'x'.repeat(2001) }), 'message');
  assert.equal(field({ message: '' }), 'message');
  assert.equal(field({ refresh_instructions: 'x'.repeat(501) }), 'refresh_instructions');
  assert.equal(field({ severity: 'urgent' }), 'severity');
  assert.equal(field({ starts_at: '2026-10-16' }), 'starts_at');
  assert.equal(field({ ends_at: 'soon' }), 'ends_at');
  assert.equal(field({ ends_at: '2026-10-16T11:00:00Z' }), 'ends_at', 'ends_at must be after now when starts_at is empty');
  assert.equal(field({ starts_at: '2026-10-17T00:00:00Z', ends_at: '2026-10-17T00:00:00Z' }), 'ends_at');
  assert.equal(field({ title: 'bell\u0007' }), 'title');
  assert.equal(field({ environment: 'prod' }), 'environment');
  assert.equal(field({ action: 'sync' }), 'action');
});

test('production requires the exact confirmation phrase, for post and clear', () => {
  assert.equal(PRODUCTION_CONFIRMATION, 'POST STATUS NOTICE TO PRODUCTION');
  for (const action of ['post', 'clear']) {
    for (const confirmation of ['', 'post status notice to production', 'POST STATUS NOTICE TO PRODUCTION ', 'yes']) {
      const result = build({ environment: 'production', action, confirmation });
      assert.equal(result.ok, false);
      assert.equal(result.error, 'production_confirmation_required');
    }
    assert.equal(build({ environment: 'production', action, confirmation: PRODUCTION_CONFIRMATION }).ok, true);
  }
  assert.equal(build({ environment: 'staging' }).ok, true, 'staging needs no phrase');
});

test('cli writes only a file named status.json and refuses bad input', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-notice-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { STATUS_ENVIRONMENT: 'staging', STATUS_ACTION: 'post', STATUS_TITLE: 'T', STATUS_MESSAGE: 'M', STATUS_SEVERITY: 'info', GITHUB_RUN_ID: '7' };
  const out = path.join(dir, 'status.json');
  const log = console.log; const err = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    assert.equal(main(['--out', path.join(dir, 'index.html')], env), 2);
    assert.equal(main(['--out', out], { ...env, STATUS_TITLE: '' }), 2);
    assert.equal(fs.existsSync(out), false);
    assert.equal(main(['--out', out], env), 0);
  } finally {
    console.log = log; console.error = err;
  }
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).announcements[0].id, 'status-7');
});

test('workflow runs from main only and requires the production phrase', () => {
  assert.match(workflow, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+(push|pull_request|schedule|workflow_run):/m);
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/);
  assert.match(workflow, /environment: \$\{\{ inputs\.environment \}\}/);
  assert.match(workflow, /test "\$INPUT_CONFIRMATION" = "POST STATUS NOTICE TO PRODUCTION"/);
  assert.match(workflow, /node scripts\/status-notice\.mjs --out \.status-notice\/status\.json/);
});

test('workflow uploads only status.json and invalidates only /status.json', () => {
  assert.doesNotMatch(workflow, /\bsync\b/);
  assert.doesNotMatch(workflow, /--delete|\bs3 rm\b|delete-object|--recursive|s3api/);
  assert.doesNotMatch(workflow, /index\.html|\bdist\b|build:aws|bun run build/);
  const copies = workflow.match(/aws s3 cp[^\n]*/g) || [];
  assert.equal(copies.length, 1);
  assert.equal(copies[0], 'aws s3 cp .status-notice/status.json "s3://$STATUS_BUCKET/status.json" \\');
  assert.match(workflow, /--cache-control "max-age=30"/);
  assert.match(workflow, /--content-type application\/json/);
  const invalidations = workflow.match(/create-invalidation/g) || [];
  assert.equal(invalidations.length, 1);
  assert.match(workflow, /--paths \/status\.json( \\)?\n/);
  assert.doesNotMatch(workflow, /--paths ["']?\/\*/);
});

test('session policies allow only PutObject on the one key and one invalidation', () => {
  const policies = [...workflow.matchAll(/inline-session-policy: >-\n\s+(\{.*\})/g)].map((m) => JSON.parse(m[1]));
  assert.equal(policies.length, 2);
  const expected = [
    ['checksops-staging-frontend-c48b', 'E1CG52WRQZI7X1'],
    ['checksops-production-frontend-806168576068', 'E1B0ZWWO5559U5'],
  ];
  policies.forEach((policy, i) => {
    assert.deepEqual(policy.Statement, [
      { Effect: 'Allow', Action: ['s3:PutObject'], Resource: `arn:aws:s3:::${expected[i][0]}/status.json` },
      { Effect: 'Allow', Action: ['cloudfront:CreateInvalidation'], Resource: `arn:aws:cloudfront::806168576068:distribution/${expected[i][1]}` },
    ]);
  });
  assert.match(workflow, /role\/ChecksOpsGitHubStagingSpaUpload/);
  assert.match(workflow, /role-to-assume: arn:aws:iam::806168576068:role\/ChecksOpsProductionSpaDeploy/);
});

test('workflow never interpolates expressions into run scripts', () => {
  const lines = workflow.split('\n');
  let inRun = false;
  let runIndent = 0;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    if (/^\s+run: \|/.test(line)) { inRun = true; runIndent = indent; continue; }
    if (inRun && line.trim() && indent <= runIndent) inRun = false;
    if (/^\s+run: [^|]/.test(line)) assert.doesNotMatch(line, /\$\{\{/);
    if (inRun) assert.doesNotMatch(line, /\$\{\{/, line);
  }
  assert.doesNotMatch(workflow, /CHECKSOPS_DEPLOYMENT_GUARD_BYPASS|CHECKSOPS_SKIP_DEPLOYMENT_GUARD/);
});
