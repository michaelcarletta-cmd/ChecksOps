import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateTransition, INTERNAL_CREATE_STATUS, LEGACY_HOMEOWNER_UPLOAD_STATUS } from '../../aws/functions/api/workflow-transitions.mjs';

// Owner report 2026-10-29: a check filed from Homeowner Uploads reached Review, but
// "send to endorsing" failed with "Invalid status transition: pending → endorsements_in_progress".
// Homeowner uploads must follow the same rules as tenant uploads.
const homeowner = readFileSync(new URL('../functions/api/homeowner.mjs', import.meta.url), 'utf8');
const check = (status) => ({ id: 'c1', status, check_stage: 'review', external_origin: {} });

test('homeowner uploads file the check with the same status as a tenant upload', () => {
  assert.equal(INTERNAL_CREATE_STATUS, 'uploaded');
  const inserts = homeowner.match(/\$6, '[a-z_]+', 'review', 'insurance'\)/g) || [];
  assert.equal(inserts.length, 2);
  for (const insert of inserts) assert.match(insert, /'uploaded'/);
  assert.doesNotMatch(homeowner, /\$6, 'pending', 'review', 'insurance'\)/);
});

test('a check already filed as pending can be sent to endorsing, loss draft or back to review', () => {
  assert.equal(LEGACY_HOMEOWNER_UPLOAD_STATUS, 'pending');
  for (const action of ['start_endorsing', 'route_loss_draft', 'return_to_review', 'start_review']) {
    const result = evaluateTransition(action, check('pending'));
    assert.equal(result.ok, true, `${action} from pending`);
  }
  assert.equal(evaluateTransition('start_endorsing', check('pending')).nextStatus, 'endorsements_in_progress');
});

test('pending follows the uploaded rules exactly (no shortcut to ready for deposit)', () => {
  assert.equal(evaluateTransition('mark_ready_for_deposit', check('uploaded')).ok, false);
  assert.equal(evaluateTransition('mark_ready_for_deposit', check('pending')).ok, false);
});
