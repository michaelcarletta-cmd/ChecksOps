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
import {
  adjustmentAmountError,
  adjustmentCaps,
  newIdempotencyKey,
  parseDollarsToCents,
} from '../../src/lib/mortgageCompensationAmount.ts';

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
  // Return to Queue and Deactivate replace them. Password reset moved into
  // the panel (platform owner only).
  assert.doesNotMatch(alias, /accepted_at: null|from\("user_roles"\)\.delete|from\("mortgage_handling_requests"\)/);
});

test('Return to Queue and Adjust are shown only to the platform owner', () => {
  const panel = read(PANEL);
  assert.match(panel, /import \{ isPlatformOwner \} from "@\/lib\/masterMerchant";/);
  assert.match(panel, /setPlatformOwner\(!!user && isPlatformOwner\(user\.email, user\.id\)\)/);
  assert.match(panel, /useState\(false\);\n\n  useEffect/);
  assert.match(panel, /\{platformOwner \? \(\s*<Button size="sm" variant="outline" onClick=\{\(\) => \{ setReturnTarget\(row\); setReturnReason\(""\); \}\}>\s*Return to Queue/);
  assert.match(panel, /onAdjust=\{platformOwner \? \(\) => openAdjust\(entry\) : undefined\}/);
  assert.match(panel, /\{onAdjust \? <Button size="sm" variant="outline" onClick=\{onAdjust\}>Adjust<\/Button> : null\}/);
  assert.match(panel, /<Dialog open=\{platformOwner && !!returnTarget\}/);
  assert.match(panel, /<Dialog open=\{platformOwner && !!adjustTarget\}/);
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

// Main's AdminMortgageOps.tsx (d71e2e1ab) sendPasswordReset body, unchanged.
const MAIN_PASSWORD_RESET = `    if (!agent.email) return toast.error("No email on file for this agent");
    if (isAwsStaging()) {
      const { error } = await supabase.auth.resetPasswordForEmail(agent.email);
      if (error) return toast.error(error.message);
      toast.success(
        \`AWS staging: Cognito reset requested for \${agent.email} (Tester mailbox delivery rules apply).\`,
      );
      return;
    }
    const { error } = await supabase.auth.resetPasswordForEmail(agent.email, {
      redirectTo: \`\${window.location.origin}/mortgage-ops/login\`,
    });
    if (error) return toast.error(error.message);
    toast.success(\`Password reset email sent to \${agent.email}\`);
  };`;

test('agent password reset is kept, platform owner only, with the same call as before', () => {
  const panel = read(PANEL);
  assert.ok(
    panel.includes(`  const sendPasswordReset = async (agent: AgentRow) => {\n    if (!platformOwner) return;\n${MAIN_PASSWORD_RESET}`),
    'sendPasswordReset must be main\'s body behind the platform-owner check',
  );
  assert.match(panel, /\{platformOwner \? \(\s*<Button\s+size="sm"\s+variant="ghost"\s+onClick=\{\(\) => void sendPasswordReset\(agent\)\}\s+title="Send password reset email"\s*>\s*<KeyRound className="w-4 h-4" \/>\s*<\/Button>\s*\) : null\}/);
  assert.equal(panel.split('sendPasswordReset(').length - 1, 1);
  assert.equal(panel.split('resetPasswordForEmail(').length - 1, 2);
});

test('Return, Adjust and Mark paid cannot double-submit; Adjust sends a per-dialog key', () => {
  const panel = read(PANEL);
  assert.match(panel, /if \(!platformOwner \|\| !returnTarget \|\| returnBusy\) return;/);
  assert.match(panel, /if \(!platformOwner \|\| !adjustTarget \|\| !adjustLimits \|\| adjustBusy\) return;/);
  assert.match(panel, /if \(payBusy\) return;/);
  assert.match(panel, /disabled=\{returnBusy \|\| !returnReason\.trim\(\)\}/);
  assert.match(panel, /disabled=\{adjustBusy \|\| !adjustReason\.trim\(\)\}/);
  assert.match(panel, /disabled=\{payBusy \|\| payTargets\.ids\.length === 0 \|\| \(payTargets\.all && !payConfirmAll\)\}/);
  for (const busy of ['setReturnBusy', 'setAdjustBusy', 'setPayBusy']) {
    assert.match(panel, new RegExp(`${busy}\\(true\\);[\\s\\S]*?\\} finally \\{\\s*${busy}\\(false\\);`));
  }
  assert.match(panel, /setAdjustKey\(newIdempotencyKey\(\)\);/);
  assert.match(panel, /idempotency_key: adjustKey,/);
  // Strict amount parsing and the cap, not Number().
  assert.match(panel, /const amount = parseDollarsToCents\(adjustAmount\);/);
  assert.doesNotMatch(panel, /Number\(adjustAmount\)/);
  assert.match(panel, /data-testid="adjustment-cap"/);
  // Mark paid with nothing selected needs an explicit confirm with count and total.
  assert.match(panel, /data-testid="mark-paid-summary"/);
  assert.match(panel, /data-testid="mark-paid-confirm-all"/);
  assert.match(panel, /if \(payTargets\.all && !payConfirmAll\) return toast\.error/);
  assert.doesNotMatch(panel, /entries\.filter\(\(e\) => e\.status !== "paid"\)/);
});

test('amount parsing is strict and the caps mirror SQL 85', () => {
  for (const [raw, cents] of [
    ['10', 1000], ['10.5', 1050], ['-5.00', -500], ['0.01', 1], [' 12.34 ', 1234], ['-0.5', -50],
  ]) assert.equal(parseDollarsToCents(raw), cents, raw);
  for (const raw of ['1e5', '1E2', '+5', '5.', '.5', '5.001', '1,000', 'abc', '', '--1', '0x10', '1234567890']) {
    assert.equal(parseDollarsToCents(raw), null, raw);
  }
  const parent = { agent_user_id: 'b', amount_cents: 1000 };
  const caps = adjustmentCaps(parent, [
    { agent_user_id: 'b', amount_cents: -300, status: 'earned' },
    { agent_user_id: 'b', amount_cents: -500, status: 'voided' },
    { agent_user_id: 'a', amount_cents: 300, status: 'earned' },
  ]);
  assert.deepEqual(caps, { maxAbsCents: 1000, maxDebitCents: 700 });
  assert.equal(adjustmentAmountError(0, caps, false), 'Enter a nonzero dollar amount');
  assert.equal(adjustmentAmountError(null, caps, false), 'Enter a dollar amount like 10.00 or -5.00');
  assert.match(adjustmentAmountError(1001, caps, false), /original entry amount/);
  assert.equal(adjustmentAmountError(1000, caps, false), null);
  assert.match(adjustmentAmountError(-800, caps, false), /remaining net/);
  assert.equal(adjustmentAmountError(-700, caps, false), null);
  assert.match(adjustmentAmountError(800, caps, true), /remaining net/);
  assert.equal(adjustmentAmountError(700, caps, true), null);
  const a = newIdempotencyKey();
  assert.match(a, /^adjust-[0-9a-f-]{32,36}$/);
  assert.notEqual(a, newIdempotencyKey());
});
