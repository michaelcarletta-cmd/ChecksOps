/**
 * scheduled.mjs hands the Moov status catch-up's direct Lambda invocation (ops/moov-status-catch-up.md) to
 * providers/moov-status-catch-up.mjs, and nothing else: an API Gateway request to the same path still needs
 * the scheduled-job secret, and the Check Alt scheduler invocation still reaches its own job. No database,
 * no Moov: the catch-up refuses the test events before it loads credentials.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleScheduledRequest, isSchedulerDirectInvocation } from '../functions/api/scheduled.mjs';
import { CATCH_UP_PATH, isMoovStatusCatchUpInvocation } from '../functions/api/providers/moov-status-catch-up.mjs';

const ACTOR = '0f0e0d0c-0b0a-4908-8706-050403020100';
const direct = (extra = {}) => ({
  checksops_operator: 'moov-status-catch-up',
  rawPath: CATCH_UP_PATH,
  requestContext: { http: { method: 'POST' } },
  phase: 'plan',
  actor_application_user_id: ACTOR,
  ...extra,
});

async function withoutSecret(fn) {
  const saved = process.env.AWS_SCHEDULED_JOB_SECRET;
  delete process.env.AWS_SCHEDULED_JOB_SECRET;
  try { return await fn(); } finally { if (saved !== undefined) process.env.AWS_SCHEDULED_JOB_SECRET = saved; }
}

test('a direct catch-up invocation reaches the catch-up handler, which validates it before any database or Moov call', async () => {
  const touched = [];
  const deps = {
    runtime: { environment: 'production', production: true, applyEnabled: false },
    loadDatabaseCredentials: async () => { touched.push('database'); throw new Error('no database in this test'); },
    loadProviderSecrets: async () => { touched.push('moov'); throw new Error('no Moov in this test'); },
  };
  assert.equal(isMoovStatusCatchUpInvocation(direct()), true);
  assert.equal(isSchedulerDirectInvocation(direct()), false);
  const badPhase = await withoutSecret(() => handleScheduledRequest(direct({ phase: 'delete' }), CATCH_UP_PATH, deps));
  assert.equal(badPhase.operation, 'moov-status-catch-up');
  assert.equal(badPhase.statusCode, 400);
  assert.equal(badPhase.error, 'catch_up_phase_invalid');
  // apply with the runtime's apply switches off: refused before anything is read.
  const off = await withoutSecret(() => handleScheduledRequest(direct({
    phase: 'apply', approval_statement: 'apply the Moov catch-up plan x in production', manifest_sha256: 'a'.repeat(64), transfer_ids: ['t1'],
  }), CATCH_UP_PATH, deps));
  assert.equal(off.error, 'catch_up_apply_disabled');
  assert.equal(off.statusCode, 403);
  // A plan reaches the database step (here a thrown loader): the handler answers 503 and moves nothing.
  const plan = await withoutSecret(() => handleScheduledRequest(direct(), CATCH_UP_PATH, deps));
  assert.equal(plan.error, 'catch_up_failed');
  assert.equal(plan.moneyMoved, false);
  assert.deepEqual(touched, ['database']);
});

test('an API Gateway request to the catch-up path is not the catch-up: it needs the scheduled-job secret', async () => {
  const http = {
    version: '2.0',
    routeKey: 'POST /scheduled/{proxy+}',
    rawPath: CATCH_UP_PATH,
    headers: { 'content-type': 'application/json' },
    requestContext: { apiId: 'api', requestId: 'r1', domainName: 'example', stage: '$default', http: { method: 'POST' } },
    body: JSON.stringify(direct()),
  };
  assert.equal(isMoovStatusCatchUpInvocation(http), false);
  // Top-level operator fields an attacker cannot add, and an extra key, are both refused too.
  assert.equal(isMoovStatusCatchUpInvocation({ ...direct(), headers: {} }), false);
  assert.equal(isMoovStatusCatchUpInvocation({ ...direct(), job: 'checkalt-poll-deposits' }), false);
  const result = await withoutSecret(() => handleScheduledRequest(http, CATCH_UP_PATH, {}));
  assert.equal(result.statusCode, 401);
  assert.equal(result.error, 'unauthorized_scheduled_job');
});

test('the Check Alt scheduler invocation is unchanged: it is not a catch-up event', () => {
  const scheduler = { checksops_scheduler: 'eventbridge-scheduler', job: 'checkalt-poll-deposits', rawPath: '/scheduled/checkalt-poll-deposits' };
  assert.equal(isSchedulerDirectInvocation(scheduler), true);
  assert.equal(isMoovStatusCatchUpInvocation(scheduler), false);
});
