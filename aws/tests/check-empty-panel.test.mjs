/**
 * Owner decision 2026-10-30: with no check selected, the right-hand panel shows only the plain
 * "Select a check" prompt (clipboard icon), never a check count.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../../src/pages/CheckCommandCenter.tsx', import.meta.url), 'utf8');

test('both empty check panels show the plain "Select a check" prompt and no check count', () => {
  assert.equal(page.match(/<p className="text-xs">Select a check<\/p>/g)?.length, 2);
  assert.doesNotMatch(page, /Select a check to begin/);
  assert.doesNotMatch(page, /\{allChecks\.length\} checks<\/Badge>/);
});
