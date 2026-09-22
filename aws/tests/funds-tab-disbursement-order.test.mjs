import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('FundsTab places Disburse to Stakeholders and DisbursementConsole above ProjectPlanCard', () => {
  const tab = fs.readFileSync(path.join(ROOT, 'src/components/payments/FundsTab.tsx'), 'utf8');
  const buttons = tab.indexOf('Disburse to Stakeholders');
  const consoleMount = tab.indexOf('<DisbursementConsole');
  const projectPlan = tab.indexOf('<ProjectPlanCard');
  const paymentList = tab.indexOf('{/* Payment list */}');

  assert.ok(buttons > 0, 'Disburse to Stakeholders button is present');
  assert.ok(consoleMount > 0, 'DisbursementConsole is present');
  assert.ok(projectPlan > 0, 'ProjectPlanCard is present');
  assert.ok(paymentList > 0, 'Payment list marker is present');
  assert.equal(tab.split('<ProjectPlanCard').length - 1, 1, 'ProjectPlanCard is mounted once');

  assert.ok(buttons < projectPlan, 'Disburse to Stakeholders is above ProjectPlanCard');
  assert.ok(consoleMount < projectPlan, 'DisbursementConsole is above ProjectPlanCard');
  assert.ok(projectPlan < paymentList, 'ProjectPlanCard stays above remaining Funds content');
});
