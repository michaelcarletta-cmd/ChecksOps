import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const AWS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(AWS, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

test('SQL 48/49 stay additive and do not rewrite SQL 47, queue Accept, or money rails', () => {
  const sql47 = read('aws/isolated/mortgage-agent-compensation/sql/47_mortgage_agent_compensation.sql');
  const sql48 = read('aws/isolated/mortgage-agent-compensation/sql/48_return_mortgage_request_to_queue.sql');
  const sql49 = read('aws/isolated/mortgage-agent-compensation/sql/49_adjust_mortgage_agent_compensation.sql');
  const queue = read('src/pages/mortgage-ops/MortgageOpsQueue.tsx');
  const rpc = read('aws/functions/api/workflow-rpc.mjs');
  const api = read('aws/functions/api/mortgage-agent-compensation.mjs');
  const panel = read('src/components/admin/MortgageAgentsPanel.tsx');

  assert.match(sql47, /earn_mortgage_agent_compensation/);
  assert.doesNotMatch(sql47, /return_mortgage_handling_request_to_queue/);
  assert.doesNotMatch(sql47, /adjust_mortgage_agent_compensation/);

  assert.match(sql48, /return_mortgage_handling_request_to_queue/);
  assert.match(sql48, /mortgage_ops_request_audit/);
  assert.match(sql48, /aws_can_admin_mortgage_agent_compensation/);
  assert.match(sql48, /accepted_at_preserved/);
  assert.match(sql48, /5b20db20-13e1-4919-9528-06388d8661d2/);
  assert.doesNotMatch(sql48, /GRANT\s+UPDATE\s+ON\s+TABLE\s+public\.mortgage_handling_requests/i);
  assert.doesNotMatch(sql48, /ALTER\s+TABLE\s+public\.mortgage_handling_requests/i);
  assert.doesNotMatch(sql48.replace(/--.*$/gm, ''), /\bmoov\b|\bstripe\b|\bach\b|\bwallet\b/i);

  assert.match(sql49, /adjust_mortgage_agent_compensation/);
  assert.match(sql49, /parent_entry_id/);
  assert.match(sql49, /adjustment_reason/);
  assert.match(sql49, /CHECK \(action IN \('approve', 'pay', 'adjust'\)\)/);
  assert.doesNotMatch(sql49.replace(/--.*$/gm, ''), /\bmoov\b|\bstripe\b|\bach\b|\bwallet\b/i);

  assert.match(queue, /accept_mortgage_handling_request/);
  assert.doesNotMatch(queue, /return_mortgage_handling_request_to_queue/);
  assert.doesNotMatch(queue, /Return to Queue/);
  assert.match(rpc, /const executeAcceptMortgage/);
  assert.doesNotMatch(rpc, /return_mortgage_handling_request_to_queue/);
  assert.doesNotMatch(rpc, /adjust_mortgage_agent_compensation/);

  assert.match(api, /action === 'return_to_queue'/);
  assert.match(api, /action === 'adjust'/);
  assert.match(api, /action === 'in_progress'/);
  assert.doesNotMatch(api, /moov_|stripe_|bill-mortgage-handling/);

  assert.match(panel, /Return to Queue/);
  assert.match(panel, /original tenant \$10\/\$5 billing event is retained/);
  assert.match(panel, />Adjust</);
  assert.match(panel, /Adjustment history/);
  assert.match(panel, /value="in-progress"/);
  assert.doesNotMatch(panel, /supabase\.rpc\("accept_mortgage_handling_request"/);
});

test('Branding, Homeowner, and accepted AdminTenants contracts remain', () => {
  const tenants = read('src/pages/admin/AdminTenants.tsx');
  const alias = read('src/pages/admin/AdminMortgageOps.tsx');
  const app = read('src/App.tsx');
  const emailSender = read('src/components/settings/EmailSenderSettings.tsx');

  assert.match(tenants, /<MortgageAgentsPanel \/>/);
  assert.match(tenants, /<EmailSenderSettings showSendingDomain=\{true\} \/>/);
  assert.match(tenants, /Branding & Email/);
  assert.match(alias, /\/admin\/tenants\?tab=mortgage-agents/);
  assert.match(alias, /<MortgageAgentsPanel \/>/);
  assert.match(app, /path="\/h\/ledger\/:token"/);
  assert.match(emailSender, /showSendingDomain && <SectionCard\s+title="Sending subdomain"/);
});
