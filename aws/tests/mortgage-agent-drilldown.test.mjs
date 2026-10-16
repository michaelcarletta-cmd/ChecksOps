/**
 * Mortgage Agents admin SPA (Tenant Management -> Mortgage Agents, and the
 * /admin/mortgage-ops alias): tab routing, the files drilldown, and Return to
 * Queue / Adjust shown only to the platform owner. Ported from
 * cursor/mortgage-agent-lambda-prod-ad99 (b73e976be).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveAdminTenantTab } from '../../src/lib/adminTenantTab.ts';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const PANEL = 'src/components/admin/MortgageAgentsPanel.tsx';

test('?tab=mortgage-agents selects Mortgage Agents and unknown tabs stay on tenants', () => {
  assert.equal(resolveAdminTenantTab('mortgage-agents'), 'mortgage-agents');
  assert.equal(resolveAdminTenantTab('tenants'), 'tenants');
  assert.equal(resolveAdminTenantTab('checkalt'), 'checkalt');
  assert.equal(resolveAdminTenantTab('platform-finance'), 'platform-finance');
  assert.equal(resolveAdminTenantTab('referrals'), 'referrals');
  assert.equal(resolveAdminTenantTab('announcements'), 'announcements');
  assert.equal(resolveAdminTenantTab('not-a-tab'), 'tenants');
  assert.equal(resolveAdminTenantTab(null), 'tenants');

  const tenants = read('src/pages/admin/AdminTenants.tsx');
  assert.match(tenants, /searchParams\.get\("tab"\)/);
  assert.match(tenants, /<TabsTrigger value="mortgage-agents">/);
  assert.match(tenants, /<TabsContent value="mortgage-agents">\s*<MortgageAgentsPanel \/>/);
  assert.match(tenants, /isPlatformOwner\(email, userId\)/);
  // Main's Tenant Management v2 overview stays.
  assert.match(tenants, /<TenantManagementV2Dashboard tenantId=\{tenant\.id\} \/>/);

  const alias = read('src/pages/admin/AdminMortgageOps.tsx');
  assert.match(alias, /\/admin\/tenants\?tab=mortgage-agents/);
  assert.match(alias, /<MortgageAgentsPanel \/>/);
  assert.match(alias, /isPlatformOwner\(user\.email, user\.id\)/);
  // The raw Unassign (it cleared accepted_at) and role delete are gone;
  // Return to Queue and Deactivate replace them.
  assert.doesNotMatch(alias, /accepted_at: null|from\("user_roles"\)\.delete|from\("mortgage_handling_requests"\)/);
});

test('Return to Queue and Adjust are shown only to the platform owner', () => {
  const panel = read(PANEL);
  assert.match(panel, /import \{ isPlatformOwner \} from "@\/lib\/masterMerchant";/);
  assert.match(panel, /setPlatformOwner\(!!user && isPlatformOwner\(user\.email, user\.id\)\)/);
  assert.match(panel, /useState\(false\);\n\n  useEffect/);
  assert.match(panel, /\{platformOwner \? \(\s*<Button size="sm" variant="outline" onClick=\{\(\) => \{ setReturnTarget\(row\); setReturnReason\(""\); \}\}>\s*Return to Queue/);
  assert.match(panel, /onAdjust=\{platformOwner \? \(\) => \{/);
  assert.match(panel, /\{onAdjust \? <Button size="sm" variant="outline" onClick=\{onAdjust\}>Adjust<\/Button> : null\}/);
  assert.match(panel, /<Dialog open=\{platformOwner && !!returnTarget\}/);
  assert.match(panel, /<Dialog open=\{platformOwner && !!adjustTarget\}/);
  assert.match(panel, /if \(!platformOwner \|\| !returnTarget\) return;/);
  assert.match(panel, /if \(!platformOwner \|\| !adjustTarget\) return;/);
  // Exactly one Return to Queue button and one Adjust button, both gated above.
  assert.equal(panel.split('Return to Queue\n').length - 1, 1);
  assert.equal(panel.split('>Adjust</Button>').length - 1, 1);
  // Both send a trimmed, required reason to the platform-owner API.
  assert.match(panel, /if \(!reason\) return toast\.error\("A return reason is required"\);/);
  assert.match(panel, /if \(!reason\) return toast\.error\("An adjustment reason is required"\);/);
  assert.match(panel, /action: "return_to_queue",\s*request_id: returnTarget\.id,\s*reason,/);
  assert.match(panel, /action: "adjust",\s*parent_entry_id: adjustTarget\.id,\s*amount_cents: amount,\s*reason,/);
  assert.doesNotMatch(panel, /supabase\.rpc\(|supabase\.from\(/);
});

test('files drilldown renders homeowner, claim, check, dates, class, pay bookkeeping', () => {
  const panel = read(PANEL);
  for (const needle of [
    'entry.homeowner_name',
    'entry.claim_number',
    'entry.claim_id',
    'entry.check_intake_item_id',
    'entry.mortgage_company',
    'entry.accepted_at',
    'entry.completed_at',
    'entry.payment_date',
    'entry.payment_reference',
    'entry.payment_note',
    'label="Homeowner"',
    'label="Claim number"',
    'label="Claim ID"',
    'label="Check ID"',
    'label="Mortgage company"',
    'label="Accepted date"',
    'label="Completed date"',
    'label="Classification"',
    'label="Compensation amount"',
    'label="Compensation status"',
    'label="Payment date"',
    'label="Payment reference"',
    'label="Bookkeeping / payment note"',
    'data-testid="compensation-entry-drilldown"',
    'Adjustment history',
    'value="in-progress"',
  ]) {
    assert.ok(panel.includes(needle), `missing ${needle}`);
  }
  for (const label of ['Initial $10', 'Additional $5', 'Files Worked', 'Gross Owed', 'Paid', 'Balance']) {
    assert.ok(panel.includes(`label="${label}"`), label);
  }
  assert.match(panel, /original tenant \$10\/\$5 billing event is retained/);
});

test('hire stays passwordless on AWS staging and uses the existing hire route', () => {
  const panel = read(PANEL);
  assert.match(panel, /const passwordlessHire = isAwsStaging\(\)/);
  assert.match(panel, /passwordlessHire \? null : \(\s*<div><Label>Optional password<\/Label>/);
  assert.match(panel, /passwordlessHire\s*\?\s*\{\s*full_name: cleanName,\s*email: cleanEmail\s*\}/);
  assert.match(panel, /supabase\.functions\.invoke\("hire-mortgage-agent"/);
  const services = read('aws/functions/api/app-services.mjs');
  assert.match(services, /case 'hire-mortgage-agent':/);
  assert.match(services, /case 'mortgage-agent-compensation':/);
});

test("the Mortgage Agent queue keeps main's PR #983 fixes and has no Return to Queue", () => {
  const queue = read('src/pages/mortgage-ops/MortgageOpsQueue.tsx');
  assert.match(queue, /accept_mortgage_handling_request/);
  assert.match(queue, /const blurActive = \(\) =>/);
  assert.match(queue, /toast\.success\("Marked complete"\);/);
  assert.doesNotMatch(queue, /bill-mortgage-handling/);
  assert.match(queue, /<Tabs defaultValue="mine">/);
  assert.doesNotMatch(queue, /return_to_queue|Return to Queue|adjust_mortgage_agent_compensation/);
  assert.ok(fs.existsSync(path.join(REPO, 'src/lib/transientDomNodeError.ts')));
  const rpc = read('aws/functions/api/workflow-rpc.mjs');
  assert.doesNotMatch(rpc, /return_mortgage_handling_request_to_queue|adjust_mortgage_agent_compensation/);
});
