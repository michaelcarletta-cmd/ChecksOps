import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Owner, 2026-10-29: the Direction to Pay request on a check's Files tab and the
// reviewer's "Override status" control are not used, so they are not shown.
const commandCenter = readFileSync(new URL('../../src/pages/CheckCommandCenter.tsx', import.meta.url), 'utf8');
const reviewConsole = readFileSync(new URL('../../src/components/check-review/CheckReviewConsole.tsx', import.meta.url), 'utf8');

test('the check Files tab no longer offers a Direction to Pay request', () => {
  assert.doesNotMatch(commandCenter, /SharedCheckPaymentDirection/);
  assert.match(commandCenter, /<CheckFilesSection checkIntakeItemId=\{checkId\}/);
});

test('the review console no longer shows the Override status select', () => {
  assert.doesNotMatch(reviewConsole, /Override status/);
  assert.doesNotMatch(reviewConsole, /Select override\.\.\./);
  assert.match(reviewConsole, /Reviewer Notes/);
});
