import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const AWS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(AWS, '..');

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

test('Mortgage Agents tab is composed onto AdminTenants without reverting Branding', () => {
  const tenants = read('src/pages/admin/AdminTenants.tsx');
  assert.match(tenants, /MortgageAgentsPanel/);
  assert.match(tenants, /value="mortgage-agents"/);
  assert.match(tenants, /<EmailSenderSettings showSendingDomain=\{true\} \/>/);
  assert.match(tenants, /Branding & Email/);
  assert.match(tenants, /value="branding"/);
});

test('Files drilldown shows homeowner, claim, check, accepted, and payment columns', () => {
  const panel = read('src/components/admin/MortgageAgentsPanel.tsx');
  assert.match(panel, /<TableHead>Homeowner<\/TableHead>/);
  assert.match(panel, /<TableHead>Claim<\/TableHead>/);
  assert.match(panel, /<TableHead>Check<\/TableHead>/);
  assert.match(panel, /<TableHead>Accepted<\/TableHead>/);
  assert.match(panel, /<TableHead>Paid<\/TableHead>/);
  assert.match(panel, /<TableHead>Payment ref<\/TableHead>/);
  assert.match(panel, /<TableHead>Payment note<\/TableHead>/);
  assert.match(panel, /entry\.homeowner_name/);
  assert.match(panel, /entry\.claim_number \|\| entry\.claim_id/);
  assert.match(panel, /entry\.check_intake_item_id/);
  assert.match(panel, /entry\.accepted_at/);
  assert.match(panel, /entry\.payment_date/);
  assert.match(panel, /entry\.payment_reference/);
  assert.match(panel, /entry\.payment_note/);
  assert.match(panel, /!isAwsStaging\(\)/);
  assert.match(panel, /Optional password/);
  assert.doesNotMatch(panel, /AdminTenants/);
});

test('compose does not overlay Mortgage Agent Compensation Lambda or SQL 47', () => {
  assert.equal(fs.existsSync(path.join(REPO, 'aws/functions/api/mortgage-agent-compensation.mjs')), false);
  const queue = read('src/pages/mortgage-ops/MortgageOpsQueue.tsx');
  assert.match(queue, /accept_mortgage_handling_request/);
  assert.match(queue, /update_mortgage_handling_request_status/);
  const rpc = read('aws/functions/api/workflow-rpc.mjs');
  assert.match(rpc, /const executeAcceptMortgage/);
  assert.match(rpc, /const executeUpdateMortgageStatus/);
  assert.doesNotMatch(rpc, /mortgage_agent_accounts/);
  assert.doesNotMatch(rpc, /mortgage-agent-compensation/);
});
