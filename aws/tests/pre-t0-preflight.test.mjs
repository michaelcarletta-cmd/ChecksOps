import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(ROOT, 'aws/cutover/scripts/pre-t0-preflight.mjs');

test('pre-T0 preflight refuses freeze and cutover flags', () => {
  const src = fs.readFileSync(script, 'utf8');
  assert.match(src, /refusing_pre_t0_mutation/);
  assert.match(src, /2026-09-06T20:00:00\.000Z/);
  assert.doesNotMatch(src, /64_financial_activation_grants\.sql applied/);
  for (const flag of ['--freeze', '--apply', '--cutover']) {
    const result = spawnSync(process.execPath, [script, flag], { encoding: 'utf8' });
    assert.equal(result.status, 2, flag);
    assert.match(result.stderr, /refusing_pre_t0_mutation/);
  }
});
