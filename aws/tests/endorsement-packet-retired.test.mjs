/**
 * Endorsement packets are hidden (owner decision 2026-10-16): no SPA file calls
 * generate-endorsement-packet or reads the endorsement-packets bucket. The API
 * route itself is unchanged (live bytes); no UI reaches it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
  const rel = `${dir}/${entry.name}`;
  if (entry.isDirectory()) return walk(rel);
  return /\.(tsx?|jsx?|mjs)$/.test(entry.name) ? [rel] : [];
});

test('no SPA file calls generate-endorsement-packet or reads the endorsement-packets bucket', () => {
  const offenders = walk('src').filter((rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return src.includes('generate-endorsement-packet')
      || /\.from\(\s*["'`]endorsement-packets["'`]\s*\)/.test(src);
  });
  assert.deepEqual(offenders, []);
});
