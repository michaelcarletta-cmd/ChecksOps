import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patchLiveWorkflow } from '../../scripts/deployment-guard/build-new-stage-overlay.mjs';

const liveTransition = `    return okResult({
      mapping,
      claims,
      spoof,
      data: rows[0],
      extra: {
        action,
        fromStatus: looked.check.status,
        toStatus: decided.nextStatus,
      },
    });`;

test('patches only the handleCheckTransition confirmation field', () => {
  const result = patchLiveWorkflow(liveTransition);
  assert.equal(result.ok, true);
  assert.match(result.text, /new_stage: rows\[0\]\.check_stage/);
  assert.equal(result.text.includes('data: rows[0],'), false);
});

test('refuses to overlay when the live return site is not unique', () => {
  const result = patchLiveWorkflow(`${liveTransition}\n${liveTransition}`);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SOURCE_RECONCILIATION_REQUIRED');
});

test('refuses a second overlay once new_stage is already present', () => {
  const first = patchLiveWorkflow(liveTransition);
  const second = patchLiveWorkflow(first.text);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'ALREADY_PATCHED');
});
