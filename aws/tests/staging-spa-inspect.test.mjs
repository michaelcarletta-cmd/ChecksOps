import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { main, readStagingFingerprint } from '../../scripts/deployment-guard/staging-spa-inspect.mjs';

const STAGING_BUCKET = 'checksops-staging-frontend-c48b';
const PRODUCTION_BUCKET = 'checksops-production-frontend-806168576068';
const HTML = '<script type="module" src="/assets/index-abc123.js"></script>';

function mockAws(calls = []) {
  return (args) => {
    calls.push(args);
    assert.equal(args[0], 's3api');
    if (args[1] === 'head-object') {
      assert.equal(args[args.indexOf('--bucket') + 1], STAGING_BUCKET);
      return JSON.stringify({ ETag: '"etag-123"', LastModified: '2026-10-07T12:00:00Z' });
    }
    if (args[1] === 'get-object') {
      assert.equal(args[args.indexOf('--bucket') + 1], STAGING_BUCKET);
      fs.writeFileSync(args.at(-1), HTML);
      return '{}';
    }
    throw new Error(`Unexpected AWS command: ${args[1]}`);
  };
}

test('reads the staging index and returns the expected fingerprint', () => {
  const calls = [];
  const fingerprint = readStagingFingerprint({ runAws: mockAws(calls) });

  assert.deepEqual(fingerprint, {
    index_html_sha256: createHash('sha256').update(HTML).digest('hex'),
    entry_bundle: '/assets/index-abc123.js',
    ETag: 'etag-123',
    LastModified: '2026-10-07T12:00:00Z',
  });
  assert.deepEqual(calls.map((args) => args[1]), ['head-object', 'get-object']);
});

test('refuses production and unexpected bucket targets before making AWS calls', () => {
  const runAws = () => assert.fail('AWS must not be called for a rejected target');

  assert.throws(
    () => readStagingFingerprint({ bucket: PRODUCTION_BUCKET, runAws }),
    /never target production/,
  );
  assert.throws(
    () => readStagingFingerprint({ bucket: 'unexpected-bucket', runAws }),
    /unexpected target/,
  );
});

test('inspection invokes only the two S3 read operations', () => {
  const calls = [];
  const runAws = mockAws(calls);

  readStagingFingerprint({ runAws });

  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
    ['s3api', 'head-object'],
    ['s3api', 'get-object'],
  ]);
});

test('CLI output contains all four fingerprint fields', () => {
  let output = '';
  const status = main({
    runAws: mockAws(),
    writeOutput: (text) => { output = text; },
  });

  assert.equal(status, 0);
  assert.deepEqual(Object.keys(JSON.parse(output)), [
    'index_html_sha256',
    'entry_bundle',
    'ETag',
    'LastModified',
  ]);
});

test('inspection workflow is manually dispatched and limits AWS access to the staging index', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/inspect-staging-spa.yml', import.meta.url), 'utf8');

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /s3:GetObject/);
  assert.match(workflow, /checksops-staging-frontend-c48b\/index\.html/);
  assert.doesNotMatch(workflow, /\b(?:put-object|sync|delete-object|create-invalidation|s3\s+rm)\b/);
});
