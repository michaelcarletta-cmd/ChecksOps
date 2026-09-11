import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAwsAuthProvider, isAwsStagingEnv } from '../../src/lib/awsEnvironment.ts';
import { validateExplicitLink } from '../functions/api/identity-link.mjs';
import { evaluateAdminOverride } from '../functions/api/workflow-override.mjs';
import { inconsistentPairReason, stageForStatus } from '../functions/api/check-status-stage.mjs';
import { shouldCloseLossDraftTracking, describeReverseCleanup } from '../functions/api/workflow-cleanup.mjs';
import { evaluateTransition } from '../functions/api/workflow-transitions.mjs';

test('production host is never staging even when Cognito is on', () => {
  assert.equal(isAwsAuthProvider('cognito'), true);
  assert.equal(isAwsStagingEnv({
    checksopsEnv: 'production',
    hostname: 'checksops.com',
    appUrl: 'https://checksops.com',
  }), false);
  assert.equal(isAwsStagingEnv({
    hostname: 'checksops.com',
    appUrl: 'https://staging.checksops.com',
  }), false);
  assert.equal(isAwsStagingEnv({
    hostname: 'www.checksops.com',
    checksopsEnv: '',
  }), false);
  assert.equal(isAwsStagingEnv({
    checksopsEnv: 'staging',
    hostname: 'checksops.com',
    appUrl: 'https://staging.checksops.com',
  }), false);
});

test('staging host and env identify as staging', () => {
  assert.equal(isAwsStagingEnv({
    checksopsEnv: 'staging',
    hostname: 'localhost',
  }), true);
  assert.equal(isAwsStagingEnv({
    hostname: 'staging.checksops.com',
    appUrl: 'https://staging.checksops.com',
  }), true);
});

test('unknown hosts fail closed as not staging', () => {
  assert.equal(isAwsStagingEnv({ hostname: 'evil.example', appUrl: '' }), false);
});

test('identity link refuses sub === application UUID and email-only matching', () => {
  const same = '11111111-1111-4111-8111-111111111111';
  assert.equal(validateExplicitLink({
    applicationUserId: same,
    cognitoSub: same,
    email: 'someone@example.com',
  }).error, 'cognito_sub_must_not_equal_application_user_id');
  assert.equal(validateExplicitLink({
    email: 'someone@example.com',
    cognitoSub: 'not-an-application-id',
  }).error, 'invalid_application_user_id');
  const ok = validateExplicitLink({
    applicationUserId: 'abd3c2a0-6dc0-4680-92dd-a013e1141c91',
    cognitoSub: '04d85458-1041-7017-a8e8-b2f3f0a5b75b',
    email: 'checksops-tester@freedomadj.com',
  });
  assert.equal(ok.ok, true);
});

test('canonical status/stage pairs reject deposited + ready_for_deposit', () => {
  assert.equal(stageForStatus('deposited'), 'deposited');
  assert.match(inconsistentPairReason('deposited', 'ready_for_deposit'), /requires check_stage "deposited"/);
  assert.equal(inconsistentPairReason('endorsements_in_progress', 'endorsing'), null);
  assert.equal(inconsistentPairReason('deposited', 'funds_released'), null);
});

test('admin override requires reason and refuses deposited destinations', () => {
  const missing = evaluateAdminOverride({
    current: { status: 'needs_review', check_stage: 'review' },
    destinationStatus: 'endorsements_in_progress',
    reason: '',
  });
  assert.equal(missing.error, 'reason_required');
  const deposited = evaluateAdminOverride({
    current: { status: 'needs_review', check_stage: 'review' },
    destinationStatus: 'deposited',
    reason: 'move to deposited',
  });
  assert.equal(deposited.error, 'invalid_destination');
  const ok = evaluateAdminOverride({
    current: { status: 'needs_review', check_stage: 'review' },
    destinationStatus: 'endorsements_in_progress',
    reason: 'recover stuck check',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.nextStage, 'endorsing');
  assert.equal(ok.providerExecution, false);
});

test('leaving loss draft closes operational tracking without deleting history', () => {
  assert.equal(shouldCloseLossDraftTracking({
    fromStatus: 'loss_draft_required',
    fromStage: 'loss_draft',
    toStatus: 'endorsements_in_progress',
    toStage: 'endorsing',
  }), true);
  assert.equal(shouldCloseLossDraftTracking({
    fromStatus: 'loss_draft_required',
    fromStage: 'loss_draft',
    toStatus: 'loss_draft_required',
    toStage: 'loss_draft',
  }), false);
  const plan = describeReverseCleanup({
    action: 'admin_override',
    fromStatus: 'loss_draft_required',
    fromStage: 'loss_draft',
    toStatus: 'endorsements_in_progress',
    toStage: 'endorsing',
  });
  assert.equal(plan.deletedAudit, false);
  assert.equal(plan.operations.some((op) => op.artifact === 'loss_draft_tracking'), true);
});

test('normal transitions still refuse financial destinations', () => {
  const denied = evaluateTransition('mark_deposited', {
    id: '891dc6b3-10bc-4fdf-81cf-16697467804a',
    status: 'approved_for_deposit',
    check_stage: 'ready_for_deposit',
  });
  assert.equal(denied.error, 'financial_or_provider');
});
