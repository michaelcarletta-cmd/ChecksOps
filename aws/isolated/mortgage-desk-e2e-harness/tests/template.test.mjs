import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { describeWorkflowPlan } from '../src/workflow-plan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = readFileSync(path.join(here, '../template.yaml'), 'utf8');

test('template creates only the named isolated resources', () => {
  assert.match(template, /FunctionName: checksops-staging-mortgage-desk-e2e-harness/);
  assert.match(template, /RoleName: checksops-staging-mortgage-desk-e2e-harness-role/);
  assert.match(template, /LogGroupName: \/aws\/lambda\/checksops-staging-mortgage-desk-e2e-harness/);
  assert.match(template, /RetentionInDays: 1/);
  assert.match(template, /CHECKSOPS_ENV: staging/);
  assert.match(template, /ALLOW_SYNTHETIC_WRITES: 'false'/);
  assert.match(template, /rds-db-credentials\/checksops-staging\/checksops\/1788286468693-\*/);
  assert.match(template, /function:checksops-production-prep-api/);
  assert.doesNotMatch(template, /rds-db-credentials\/checksops-production/);
  assert.doesNotMatch(template, /checksops\/production\//);
  assert.doesNotMatch(template, /checksops_admin/);
  assert.doesNotMatch(template, /PROVIDER_SECRETS/);
  assert.doesNotMatch(template, /ADMIN_SECRET/);
  assert.doesNotMatch(template, /UpdateFunctionCode|UpdateFunctionConfiguration/);
  assert.doesNotMatch(template, /AWS_MOOV_ENABLED: 'true'|AWS_CHECKALT_ENABLED: 'true'/);
  assert.doesNotMatch(template, /SecretString/);
});

test('workflow plan names existing handlers and does not treat copied SQL as the workflow', () => {
  const plan = describeWorkflowPlan();
  assert.equal(plan.usesCopiedSqlAsWorkflow, false);
  assert.equal(plan.transitionsUseExistingHandlers, true);
  assert.equal(plan.handlers.sendToMortgageDesk.handler, 'handleWrite');
  assert.equal(plan.handlers.accept.handler, 'executeAcceptMortgage');
  assert.equal(plan.handlers.completeReturn.handler, 'executeUpdateMortgageStatus');
  assert.equal(plan.handlers.queue.http.path, '/data/query');
  assert.ok(plan.futureRunInitial.existingApplicationInvokes.some((item) => /accept_mortgage_handling_request/.test(item)));
  assert.ok(plan.futureRunInitial.never.some((item) => /INSERT check_billing_events/.test(item)));
});
