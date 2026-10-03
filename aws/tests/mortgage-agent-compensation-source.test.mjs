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

test('compensation entries SELECT adds homeowner_name without rewriting SQL 47', () => {
  const api = read('aws/functions/api/mortgage-agent-compensation.mjs');
  const sql47 = read('aws/isolated/mortgage-agent-compensation/sql/47_mortgage_agent_compensation.sql');
  assert.match(api, /r\.homeowner_name/);
  assert.match(api, /c\.claim_number/);
  assert.match(api, /LEFT JOIN public\.claims c ON c\.id = e\.claim_id/);
  assert.doesNotMatch(api, /ALTER TABLE/);
  assert.doesNotMatch(sql47, /CREATE OR REPLACE FUNCTION public\.list_mortgage_agent_compensation_entries/);
});

test('SQL 47 does not collide with SQL 39, queue, or money rails', () => {
  const sql = read('aws/isolated/mortgage-agent-compensation/sql/47_mortgage_agent_compensation.sql');
  assert.equal(fs.existsSync(path.join(REPO, 'aws/rls/sql/39_mortgage_ops_agent_accept_complete.sql')), false);
  assert.doesNotMatch(sql, /GRANT\s+UPDATE\s+ON\s+TABLE\s+public\.mortgage_handling_requests/i);
  assert.doesNotMatch(sql, /ALTER\s+TABLE\s+public\.mortgage_handling_requests/i);
  assert.doesNotMatch(sql, /ALTER\s+TABLE\s+public\.check_billing_events/i);
  assert.doesNotMatch(sql, /\bmoov_/i);
  assert.doesNotMatch(sql, /\bstripe_/i);
  assert.doesNotMatch(sql, /bill-mortgage-handling/);
  assert.equal(sql.includes('CREATE OR REPLACE FUNCTION public.aws_is_mortgage_ops_agent'), false);
  assert.match(sql, /earn_mortgage_agent_compensation/);
  assert.match(sql, /5b20db20-13e1-4919-9528-06388d8661d2/);

  const queue = read('src/pages/mortgage-ops/MortgageOpsQueue.tsx');
  assert.match(queue, /accept_mortgage_handling_request/);
  assert.match(queue, /update_mortgage_handling_request_status/);

  const rpc = read('aws/functions/api/workflow-rpc.mjs');
  assert.match(rpc, /const executeAcceptMortgage/);
  assert.match(rpc, /const executeUpdateMortgageStatus/);
  assert.doesNotMatch(rpc, /mortgage_agent_accounts/);
  assert.doesNotMatch(rpc, /mortgage-agent-compensation/);
});
