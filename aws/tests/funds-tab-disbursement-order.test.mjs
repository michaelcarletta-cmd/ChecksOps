import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('FundsTab places Disburse to Stakeholders and DisbursementConsole above the payment list', () => {
  const tab = fs.readFileSync(path.join(ROOT, 'src/components/payments/FundsTab.tsx'), 'utf8');
  const buttons = tab.indexOf('Disburse to Stakeholders');
  const consoleMount = tab.indexOf('<DisbursementConsole');
  const paymentList = tab.indexOf('{/* Payment list */}');

  assert.ok(buttons > 0, 'Disburse to Stakeholders button is present');
  assert.ok(consoleMount > 0, 'DisbursementConsole is present');
  assert.ok(paymentList > 0, 'Payment list marker is present');
  // The project schedule moved to its own tab (owner 2026-11-15); the Funds tab no longer mounts it.
  assert.equal(tab.includes('<ProjectPlanCard'), false, 'ProjectPlanCard is not mounted in the Funds tab');

  assert.ok(buttons < paymentList, 'Disburse to Stakeholders is above the payment list');
  assert.ok(consoleMount < paymentList, 'DisbursementConsole is above the payment list');
});
