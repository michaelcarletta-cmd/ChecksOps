/**
 * Settings must not offer Moov verification Override.
 * Moov writes verified status through webhook / moov-sync.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';

test('Settings Bank Account and Stakeholders have no Override button', () => {
  const stakeholders = readFileSync('src/components/disbursement/StakeholderAccountSettings.tsx', 'utf8');
  const operating = readFileSync('src/components/settings/TenantBankAccountSettings.tsx', 'utf8');
  const awsClient = readFileSync('src/integrations/aws/client.ts', 'utf8');
  const workflow = readFileSync('aws/functions/api/write-check-workflow.mjs', 'utf8');
  assert.doesNotMatch(stakeholders, /adminOverride/);
  assert.doesNotMatch(stakeholders, /Admin override: mark as verified/);
  assert.doesNotMatch(stakeholders, /> Override</);
  assert.doesNotMatch(operating, /adminOverride/);
  assert.doesNotMatch(operating, /Admin override: mark as verified/);
  assert.doesNotMatch(operating, /> Override</);
  assert.equal(WRITE_ALLOWLIST.stakeholder_accounts, undefined);
  assert.doesNotMatch(awsClient, /"stakeholder_accounts"/);
  assert.doesNotMatch(workflow, /executeStakeholderAdminOverride/);
  assert.doesNotMatch(workflow, /write-stakeholder-override/);
});
