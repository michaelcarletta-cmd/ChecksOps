import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CHECKALT_OPERATOR_ROLES as SERVER_CHECKALT_OPERATOR_ROLES,
  roleAllowsCheckAlt,
} from '../functions/api/providers/production/checkalt-authz.mjs';
import { CHECKALT_TENANT_MEMBER_SQL } from '../functions/api/workflow-rpc.mjs';
import {
  CHECKALT_OPERATOR_ROLES,
  canOperateCheckAlt,
  canSaveCheckAltAutoDeposit,
} from '../../src/lib/checkAltOperatorAccess.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceOf = (rel) => fs.readFileSync(path.join(ROOT, '..', rel), 'utf8');

test('SPA Check Alt operator roles mirror the server list exactly', () => {
  assert.deepEqual([...CHECKALT_OPERATOR_ROLES], [...SERVER_CHECKALT_OPERATOR_ROLES]);
  for (const role of CHECKALT_OPERATOR_ROLES) {
    assert.match(CHECKALT_TENANT_MEMBER_SQL, new RegExp(`'${role}'`));
  }
  const sqlRoles = CHECKALT_TENANT_MEMBER_SQL.match(/IN \(([^)]*)\)/)[1]
    .split(',').map((r) => r.trim().replace(/'/g, ''));
  assert.deepEqual(sqlRoles, [...CHECKALT_OPERATOR_ROLES]);
  assert.throws(() => { CHECKALT_OPERATOR_ROLES.push('viewer'); });
});

test('canOperateCheckAlt: tenant members with an operator role only, same as the server', () => {
  for (const role of ['owner', 'admin', 'manager', 'operator', 'Owner', ' ADMIN ']) {
    assert.equal(canOperateCheckAlt({ isTenantMember: true, tenantRole: role }), true, role);
    assert.equal(roleAllowsCheckAlt([role.trim()]), true, role);
  }
  for (const role of ['viewer', 'Viewer', 'client', 'contractor', 'staff', '', null, undefined]) {
    assert.equal(canOperateCheckAlt({ isTenantMember: true, tenantRole: role }), false, String(role));
  }
  // Not a member of the tenant (e.g. a partner the check is shared with).
  assert.equal(canOperateCheckAlt({ isTenantMember: false, tenantRole: 'admin' }), false);
  assert.equal(canOperateCheckAlt({ isTenantMember: false, tenantRole: null }), false);
  assert.equal(canOperateCheckAlt(), false);
});

test('canSaveCheckAltAutoDeposit: operator roles or the platform owner (SQL 80); viewers refused', () => {
  assert.equal(canSaveCheckAltAutoDeposit({ isTenantMember: true, tenantRole: 'operator' }), true);
  assert.equal(canSaveCheckAltAutoDeposit({ isTenantMember: true, tenantRole: 'viewer' }), false);
  assert.equal(canSaveCheckAltAutoDeposit({ isTenantMember: false, tenantRole: null }), false);
  assert.equal(canSaveCheckAltAutoDeposit({ isTenantMember: false, isPlatformOwner: true }), true);
  assert.equal(canSaveCheckAltAutoDeposit({ isTenantMember: true, tenantRole: 'viewer', isPlatformOwner: false }), false);
  const sql80 = sourceOf('aws/workflows/sql/80_checkalt_member_auto_deposit.sql');
  assert.match(sql80, /public\.is_platform_owner\(\)/);
});

test('useCanOperateCheckAlt reuses the tenant membership hook and the shared rule', () => {
  const hook = sourceOf('src/hooks/useCanMoveChecks.ts');
  assert.match(hook, /export function useIdentityTenantAccess\(tenantIdOverride\?: string \| null\)/);
  assert.match(hook, /export function useCanOperateCheckAlt\(/);
  assert.match(hook, /canOperateCheckAlt\(\{ isTenantMember, tenantRole \}\)/);
});

test('Auto-Deposit card hides Save and locks the fields for viewers', () => {
  const card = sourceOf('src/components/billing/TenantAutoApproveCard.tsx');
  assert.match(card, /useIdentityTenantAccess\(tenantId\)/);
  assert.match(card, /canSaveCheckAltAutoDeposit\(/);
  assert.match(card, /\{canEdit \? \(\s*<Button[\s\S]*?Save settings[\s\S]*?\) : \(/);
  assert.match(card, /disabled=\{isLoading \|\| !canEdit\}/);
  assert.match(card, /disabled=\{!enabled \|\| isLoading \|\| !canEdit\}/);
  assert.match(card, /Only owners, admins, managers and operators/);
});

test('Pending approvals hide Approve, Reject and Poll Now from viewers', () => {
  const src = sourceOf('src/components/settings/CheckAltSettings.tsx');
  const start = src.indexOf('export function PendingApprovalDeposits()');
  const end = src.indexOf('export function CheckAltDepositHistory()');
  const pending = src.slice(start, end);
  assert.match(pending, /const canOperate = useCanOperateCheckAlt\(\);/);
  assert.match(pending, /\{canOperate && !isRejecting && \(/);
  assert.match(pending, /\{canOperate && isRejecting && \(/);
  const pollButtons = pending.split('onClick={() => poll.mutate()}').length - 1;
  assert.equal(pollButtons, 2);
  assert.equal((pending.match(/\{canOperate && \(\s*(<div[^>]*>\s*)?<Button[^>]*onClick=\{\(\) => poll\.mutate\(\)\}/g) || []).length, 2);
  // The local list refresh is a read and stays.
  assert.match(pending, /onClick=\{\(\) => refetch\(\)\}/);
});

test('Check detail hides the Check Alt Deposit button from viewers and shared-check partners', () => {
  const src = sourceOf('src/pages/CheckCommandCenter.tsx');
  assert.match(src, /const canDepositWithCheckAlt = isOwner && canOperateCheckAltHere;/);
  assert.match(src, /\{canDepositWithCheckAlt && \(\s*<Button[\s\S]{0,400}onClick=\{handleDepositWithCheckAlt\}/);
  assert.equal(src.split('onClick={handleDepositWithCheckAlt}').length - 1, 1);
});

test('Deposit operations hide Check Alt Submit/Resubmit Deposit from viewers', () => {
  const src = sourceOf('src/components/deposit-ops/DepositOperationsConsole.tsx');
  assert.match(src, /const canOperateCheckAlt = useCanOperateCheckAlt\(\);/);
  const calls = src.split('checkaltSubmitMutation.mutate(item.check_id)').length - 1;
  assert.equal(calls, 2);
  assert.match(src, /\{canOperateCheckAlt && item\.status === "provider_assigned" && item\.provider === "checkalt" && \(/);
  assert.match(src, /\{canOperateCheckAlt && item\.status === "failed" && item\.provider === "checkalt" && \(/);
});
