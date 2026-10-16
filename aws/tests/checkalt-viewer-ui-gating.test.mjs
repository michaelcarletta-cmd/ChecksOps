import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { roleAllowsCheckAlt } from '../functions/api/providers/production/checkalt-authz.mjs';
import { CHECKALT_TENANT_MEMBER_SQL } from '../functions/api/workflow-rpc.mjs';
import {
  canOperateCheckAlt,
  canOperateCheckAltForTenant,
  canOperateCheckAltInAnyTenant,
  canSaveCheckAltAutoDeposit,
  checkAltAccessState,
} from '../../src/lib/checkAltOperatorAccess.ts';
import {
  loadIdentityTenantMemberships,
  parseIdentityTenantMemberships,
} from '../../src/lib/tenantCheckIdentity.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(ROOT, '..');
const sourceOf = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const count = (src, needle) => src.split(needle).length - 1;

const TENANT_A = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const TENANT_B = '4f172140-f57a-4744-8050-95f4f07b13b4';
const TENANT_C = '11111111-1111-4111-8111-111111111111';

test('Owner policy: Check Alt membership gate on the SPA, the server and the Auto-Deposit SQL ignore the role', () => {
  assert.doesNotMatch(CHECKALT_TENANT_MEMBER_SQL, /role/);
  assert.match(CHECKALT_TENANT_MEMBER_SQL, /WHERE user_id = \$1::uuid AND tenant_id = \$2::uuid/);
  const spa = sourceOf('src/lib/checkAltOperatorAccess.ts');
  assert.doesNotMatch(spa, /CHECKALT_OPERATOR_ROLES|"operator"|"viewer"/);
});

test('canOperateCheckAlt: any member of the tenant, whatever its stored role, same as the server', () => {
  for (const role of ['owner', 'admin', 'manager', 'operator', 'viewer', 'Viewer', 'member', '', null, undefined]) {
    assert.equal(canOperateCheckAlt({ isTenantMember: true, tenantRole: role }), true, String(role));
    assert.equal(roleAllowsCheckAlt([role]), true, String(role));
  }
  // No membership row of the tenant (e.g. a partner the check is shared with).
  assert.equal(roleAllowsCheckAlt([]), false);
  assert.equal(canOperateCheckAlt({ isTenantMember: false, tenantRole: 'admin' }), false);
  assert.equal(canOperateCheckAlt(), false);
});

test('per-row rule: membership of that row\'s tenant decides; Poll Now needs any membership', () => {
  const memberships = [
    { tenant_id: TENANT_A, role: 'operator' },
    { tenant_id: TENANT_B, role: 'viewer' },
  ];
  assert.equal(canOperateCheckAltForTenant(memberships, TENANT_A), true);
  assert.equal(canOperateCheckAltForTenant(memberships, TENANT_B), true);
  assert.equal(canOperateCheckAltForTenant(memberships, TENANT_C), false);
  assert.equal(canOperateCheckAltForTenant(memberships, null), false);
  assert.equal(canOperateCheckAltForTenant(memberships, undefined), false);
  assert.equal(canOperateCheckAltForTenant([], TENANT_A), false);
  assert.equal(canOperateCheckAltForTenant(undefined, TENANT_A), false);
  assert.equal(canOperateCheckAltForTenant([{ tenant_id: TENANT_A, role: null }], TENANT_A), true);

  assert.equal(canOperateCheckAltInAnyTenant(memberships), true);
  assert.equal(canOperateCheckAltInAnyTenant([{ tenant_id: TENANT_B, role: 'viewer' }]), true);
  assert.equal(canOperateCheckAltInAnyTenant([]), false);
  assert.equal(canOperateCheckAltInAnyTenant(null), false);
});

test('canSaveCheckAltAutoDeposit: any member of that tenant or the platform owner (SQL 90)', () => {
  const memberships = [{ tenant_id: TENANT_A, role: 'operator' }, { tenant_id: TENANT_B, role: 'viewer' }];
  assert.equal(canSaveCheckAltAutoDeposit({ memberships, tenantId: TENANT_A }), true);
  assert.equal(canSaveCheckAltAutoDeposit({ memberships, tenantId: TENANT_B }), true);
  assert.equal(canSaveCheckAltAutoDeposit({ memberships, tenantId: TENANT_C }), false);
  assert.equal(canSaveCheckAltAutoDeposit({ memberships: [], tenantId: TENANT_C, isPlatformOwner: true }), true);
  assert.equal(canSaveCheckAltAutoDeposit(), false);
  assert.match(sourceOf('aws/workflows/sql/90_users_only_tenant_roles.sql'), /public\.is_platform_owner\(\)/);
});

test('access state: hidden by default; role message only after memberships loaded', () => {
  assert.equal(checkAltAccessState({ isLoading: true, isError: false, allowed: false }), 'loading');
  assert.equal(checkAltAccessState({ isLoading: false, isError: true, allowed: false }), 'error');
  assert.equal(checkAltAccessState({ isLoading: false, isError: false, allowed: false }), 'denied');
  assert.equal(checkAltAccessState({ isLoading: false, isError: false, allowed: true }), 'allowed');
  const note = sourceOf('src/components/checks/CheckAltAccessNote.tsx');
  assert.match(note, /if \(state === "allowed"\) return null;/);
  assert.match(note, /state === "loading"[^\n]*Checking your access/);
  assert.match(note, /Couldn't check your access/);
  assert.match(note, /Only members of this organization can \{action\}\./);
  // The membership message is only reached after the loading and error branches.
  assert.ok(note.indexOf('Only members') > note.indexOf('state === "error"'));
});

test('identity/me memberships: every tenant with its role; failures throw, no session is empty', async () => {
  assert.deepEqual(parseIdentityTenantMemberships({
    applicationUserId: 'u1',
    tenants: [
      { tenant_id: TENANT_A, role: 'operator' },
      { tenant_id: TENANT_B, role: 'viewer' },
      { tenant_id: TENANT_C },
      { role: 'admin' },
      null,
    ],
  }), [
    { tenant_id: TENANT_A, role: 'operator' },
    { tenant_id: TENANT_B, role: 'viewer' },
    { tenant_id: TENANT_C, role: null },
  ]);
  assert.deepEqual(parseIdentityTenantMemberships({ ok: false, applicationUserId: 'u1', tenants: [{ tenant_id: TENANT_A, role: 'admin' }] }), []);
  assert.deepEqual(parseIdentityTenantMemberships({ tenants: [{ tenant_id: TENANT_A, role: 'admin' }] }), []);

  const ok = async () => ({ ok: true, json: async () => ({ applicationUserId: 'u1', tenants: [{ tenant_id: TENANT_A, role: 'admin' }] }) });
  assert.deepEqual(
    await loadIdentityTenantMemberships({ apiBaseUrl: 'https://api.example.test', idToken: 't', fetchImpl: ok }),
    [{ tenant_id: TENANT_A, role: 'admin' }],
  );
  const denied = async () => ({ ok: false, json: async () => ({ ok: false }) });
  await assert.rejects(loadIdentityTenantMemberships({ apiBaseUrl: 'https://api.example.test', idToken: 't', fetchImpl: denied }));
  const offline = async () => { throw new Error('offline'); };
  await assert.rejects(loadIdentityTenantMemberships({ apiBaseUrl: 'https://api.example.test', idToken: 't', fetchImpl: offline }));
  assert.deepEqual(await loadIdentityTenantMemberships({ apiBaseUrl: 'https://api.example.test', idToken: null, fetchImpl: ok }), []);
  assert.deepEqual(await loadIdentityTenantMemberships({ apiBaseUrl: '', idToken: 't', fetchImpl: ok }), []);
});

test('useCheckAltAccess exposes the membership map with loading and error state', () => {
  const hook = sourceOf('src/hooks/useCanMoveChecks.ts');
  assert.match(hook, /export function useTenantMemberships\(\)/);
  assert.match(hook, /loadIdentityTenantMemberships\(\{ apiBaseUrl: awsApiBaseUrl\(\) \}\)/);
  assert.match(hook, /\.from\("tenant_users"\)\s*\.select\("tenant_id, role"\)\s*\.eq\("user_id", user!\.id\)/);
  assert.match(hook, /isLoading: authLoading \|\| \(enabled && query\.isPending\)/);
  assert.match(hook, /isError: query\.isError/);
  assert.match(hook, /canOperateCheckAltForTenant\(memberships, tenantId\)/);
  assert.match(hook, /canOperateInAny: canOperateCheckAltInAnyTenant\(memberships\)/);
});

test('Auto-Deposit card hides Save and locks the fields for viewers', () => {
  const card = sourceOf('src/components/billing/TenantAutoApproveCard.tsx');
  assert.match(card, /canSaveCheckAltAutoDeposit\(\{\s*memberships: access\.memberships,\s*tenantId,/);
  assert.match(card, /\{canEdit \? \(\s*<Button[\s\S]*?Save settings[\s\S]*?\) : \(\s*<CheckAltAccessNote/);
  assert.match(card, /action="change Auto-Deposit settings"/);
  assert.match(card, /disabled=\{isLoading \|\| !canEdit\}/);
  assert.match(card, /disabled=\{!enabled \|\| isLoading \|\| !canEdit\}/);
});

test('Pending approvals gate Approve/Reject per row tenant and Poll Now by any operator tenant', () => {
  const src = sourceOf('src/components/settings/CheckAltSettings.tsx');
  const pending = src.slice(
    src.indexOf('export function PendingApprovalDeposits()'),
    src.indexOf('export function CheckAltDepositHistory()'),
  );
  assert.match(pending, /\.select\(\s*"id, tenant_id, amount,/);
  assert.match(pending, /const canDecide = checkAltAccess\.canOperateIn\(row\.tenant_id\);/);
  assert.match(pending, /\{canDecide && !isRejecting && \(/);
  assert.match(pending, /\{canDecide && isRejecting && \(/);
  assert.equal(count(pending, 'decide.mutate('), 2);
  assert.match(pending, /const canPoll = checkAltAccess\.canOperateInAny;/);
  assert.equal(count(pending, 'onClick={() => poll.mutate()}'), 2);
  assert.equal((pending.match(/\{canPoll (&&|\?) \(\s*(<div[^>]*>\s*)?<Button[^>]*onClick=\{\(\) => poll\.mutate\(\)\}/g) || []).length, 2);
  assert.equal(/canOperate\b(?!In)/.test(pending), false);
  assert.match(pending, /onClick=\{\(\) => refetch\(\)\}/);
});

test('Check detail hides the Check Alt Deposit button from viewers and shared-check partners', () => {
  const src = sourceOf('src/pages/CheckCommandCenter.tsx');
  assert.match(src, /const canDepositWithCheckAlt = isOwner && checkAltAccess\.canOperateIn\(checkOwnerTenantId\);/);
  assert.match(src, /\{canDepositWithCheckAlt && \(\s*<Button[\s\S]{0,400}onClick=\{handleDepositWithCheckAlt\}/);
  assert.equal(count(src, 'onClick={handleDepositWithCheckAlt}'), 1);
  assert.match(src, /<CheckAltAccessNote\s+state=\{checkAltDepositAccess\}\s+action="deposit"/);
});

test('Deposit operations hide Check Alt Submit/Resubmit Deposit from viewers', () => {
  const src = sourceOf('src/components/deposit-ops/DepositOperationsConsole.tsx');
  assert.match(src, /const canOperateCheckAlt = checkAltAccess\.canOperateIn\(tenantId\);/);
  assert.equal(count(src, 'checkaltSubmitMutation.mutate(item.check_id)'), 2);
  assert.match(src, /\{canOperateCheckAlt && item\.status === "provider_assigned" && item\.provider === "checkalt" && \(/);
  assert.match(src, /\{canOperateCheckAlt && item\.status === "failed" && item\.provider === "checkalt" && \(/);
});

// A new SPA call site for a Check Alt money endpoint must be added here, and
// gated, deliberately.
test('Check Alt submit/approve/poll call sites in the SPA are exactly the known set', () => {
  const TOKENS = [
    'checkalt-submit-deposit',
    'checkalt-approve-deposit',
    'checkalt-poll-status',
    'runCheckAltDepositClick',
    'runCheckAltOneClickSubmit',
  ];
  const EXPECTED = {
    // Transport/orchestration libraries (no UI of their own).
    'src/lib/awsCheckAltMoneyPath.ts': null,
    'src/lib/checkaltDepositOrchestrator.ts': null,
    'src/lib/financialTotpOnlyTest.ts': null,
    // UI call sites, with exact counts per token.
    'src/components/settings/CheckAltSettings.tsx': {
      // Platform-owner CheckAltSettings Poll (AdminTenants) + PendingApprovalDeposits poll.
      'checkalt-poll-status': 4,
      // Doc comment + guarded path + invoke in PendingApprovalDeposits.
      'checkalt-approve-deposit': 3,
    },
    'src/components/deposit-ops/DepositOperationsConsole.tsx': { runCheckAltDepositClick: 2 },
    'src/pages/CheckCommandCenter.tsx': { runCheckAltDepositClick: 2 },
  };
  const found = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const rel = path.relative(REPO, full).split(path.sep).join('/');
      if (rel === 'src/integrations/supabase/types.ts') continue;
      const src = fs.readFileSync(full, 'utf8');
      const counts = {};
      for (const token of TOKENS) {
        const n = count(src, token);
        if (n) counts[token] = n;
      }
      if (Object.keys(counts).length) found[rel] = counts;
    }
  };
  walk(path.join(REPO, 'src'));
  assert.deepEqual(Object.keys(found).sort(), Object.keys(EXPECTED).sort());
  for (const [rel, expected] of Object.entries(EXPECTED)) {
    if (expected) assert.deepEqual(found[rel], expected, rel);
  }
  // The platform-owner Poll in CheckAltSettings() stays on the admin-only page.
  const admin = sourceOf('src/components/settings/CheckAltSettings.tsx');
  const adminCard = admin.slice(admin.indexOf('export function CheckAltSettings()'), admin.indexOf('export function PendingApprovalDeposits()'));
  assert.equal(count(adminCard, 'pollMutation.mutate()'), 1);
  assert.match(sourceOf('src/pages/admin/AdminTenants.tsx'), /<CheckAltSettings \/>/);
});
