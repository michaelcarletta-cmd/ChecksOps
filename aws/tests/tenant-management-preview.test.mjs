import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTenant, isPlatformOwnerActor } from '../functions/api/providers/parity/caller.mjs';
import { WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';
import { executeTenantsNarrow, executeAppMetadataWrite } from '../functions/api/write-app-metadata.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PIPELINE = '3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const APP_ID = '7dbb3009-f059-4767-b5dc-1c5c72379330';

const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

const clientOf = ({ platformOwner = false, memberships = [], updates = [] } = {}) => ({
  query: async (sql, params = []) => {
    if (sql.includes('is_platform_owner()')) {
      return { rows: [{ is_owner: platformOwner }] };
    }
    if (sql.includes('FROM public.user_roles')) {
      return { rows: [] };
    }
    if (sql.includes('FROM public.tenant_users') && sql.includes('LIMIT 1')) {
      const tenantId = params[1];
      const hit = memberships.some((m) => m.tenant_id === tenantId);
      return { rows: hit ? [{ '?column?': 1 }] : [] };
    }
    if (sql.includes('INSERT INTO public.tenants')) {
      updates.push({ op: 'insert', params });
      return { rows: [{ id: PIPELINE, name: params[0], slug: params[1] }] };
    }
    if (sql.includes('UPDATE public.tenants')) {
      updates.push({ op: 'update', sql, params });
      return { rows: [{ id: params.at(-1), is_test_account: params[0] }] };
    }
    return { rows: [] };
  },
});

test('platform owner can resolve a claimed tenant without tenant_users membership', async () => {
  const client = clientOf({ platformOwner: true, memberships: [] });
  const result = await resolveTenant(client, {
    userId: APP_ID,
    body: { tenant_id: PIPELINE },
    memberships: [],
    requireAdmin: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.tenantId, PIPELINE);
  assert.equal(result.isAdmin, true);
});

test('tenant user_roles.admin cannot claim another tenant', async () => {
  const client = clientOf({ platformOwner: false });
  const result = await resolveTenant(client, {
    userId: APP_ID,
    body: { tenant_id: PIPELINE },
    memberships: [{ tenant_id: FREEDOM, role: 'admin' }],
    requireAdmin: true,
  });
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'cross_tenant_denied');
});

test('claimed tenant_id is never replaced by memberships[0]', async () => {
  const client = clientOf({ platformOwner: true });
  const result = await resolveTenant(client, {
    userId: APP_ID,
    body: { tenant_id: PIPELINE },
    memberships: [{ tenant_id: FREEDOM, role: 'admin' }],
  });
  assert.equal(result.tenantId, PIPELINE);
  assert.notEqual(result.tenantId, FREEDOM);
});

test('ordinary member can still resolve their own tenant', async () => {
  const client = clientOf({ platformOwner: false });
  const result = await resolveTenant(client, {
    userId: APP_ID,
    body: { tenant_id: FREEDOM },
    memberships: [{ tenant_id: FREEDOM, role: 'admin' }],
    requireAdmin: true,
  });
  assert.equal(result.tenantId, FREEDOM);
});

test('isPlatformOwnerActor reads is_platform_owner() only', async () => {
  const owner = await isPlatformOwnerActor(clientOf({ platformOwner: true }));
  const other = await isPlatformOwnerActor(clientOf({ platformOwner: false }));
  assert.equal(owner, true);
  assert.equal(other, false);
});

test('tenant writes still deny provider allowlist flags', () => {
  assert.ok(!WRITE_ALLOWLIST.tenants.columns.has('moov_allowlisted'));
  assert.ok(!WRITE_ALLOWLIST.tenants.columns.has('checkalt_enabled'));
  assert.ok(WRITE_ALLOWLIST.tenants.columns.has('is_test_account'));
  assert.ok(WRITE_ALLOWLIST.tenants.columns.has('moov_environment'));
  assert.ok(WRITE_ALLOWLIST.tenants.ops.has('insert'));
});

test('platform owner can update Tenant Management flags without membership', async () => {
  const updates = [];
  const client = clientOf({ platformOwner: true, memberships: [], updates });
  const result = await executeTenantsNarrow({
    client,
    mapping: { application_user_id: APP_ID },
    op: 'update',
    values: { is_test_account: true, moov_environment: 'sandbox' },
    filters: [{ column: 'id', op: 'eq', value: PIPELINE }],
  });
  assert.equal(result.error, undefined);
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /is_test_account/);
});

test('tenant member cannot write Tenant Management financial flags', async () => {
  const updates = [];
  const client = clientOf({
    platformOwner: false,
    memberships: [{ tenant_id: FREEDOM }],
    updates,
  });
  const denied = await executeTenantsNarrow({
    client,
    mapping: { application_user_id: APP_ID },
    op: 'update',
    values: { is_test_account: true, moov_environment: 'sandbox' },
    filters: [{ column: 'id', op: 'eq', value: FREEDOM }],
  });
  assert.equal(denied.error, 'missing_required_field');

  const branding = await executeTenantsNarrow({
    client,
    mapping: { application_user_id: APP_ID },
    op: 'update',
    values: { name: 'Freedom Adjustment' },
    filters: [{ column: 'id', op: 'eq', value: FREEDOM }],
  });
  assert.equal(branding.error, undefined);
});

test('non-member non-owner cannot write another tenant', async () => {
  const result = await executeAppMetadataWrite({
    client: clientOf({ platformOwner: false, memberships: [] }),
    mapping: { application_user_id: APP_ID },
    table: 'tenants',
    op: 'update',
    values: { name: 'Nope' },
    filters: [{ column: 'id', op: 'eq', value: PIPELINE }],
  });
  assert.equal(result.error, 'not_authorized');
});

test('frontend preview stays in the selected tenant and does not require membership', () => {
  const login = read('src/components/white-label/WhiteLabelLogin.tsx');
  const whiteLabel = read('src/pages/WhiteLabelApp.tsx');
  const custom = read('src/components/white-label/CustomDomainWhiteLabelApp.tsx');
  const banner = read('src/components/admin/TenantPreviewBanner.tsx');
  const admin = read('src/pages/admin/AdminTenants.tsx');
  const helper = read('src/lib/platformAdminPreview.ts');
  const wallet = read('src/pages/WalletOps.tsx');
  const checkCenter = read('src/components/white-label/WhiteLabelCheckCenter.tsx');
  const context = read('src/contexts/TenantContext.tsx');

  assert.match(helper, /isMasterOwner/);
  assert.match(whiteLabel, /canPlatformPreviewTenant/);
  assert.doesNotMatch(whiteLabel, /isMasterMerchant\(user\?\.email/);
  assert.match(custom, /canPlatformPreviewTenant/);
  assert.match(login, /if \(tenant\?\.slug\)/);
  assert.match(login, /\$\{basePath\}\/checks/);
  assert.match(login, /Preview Tenant/);
  assert.match(banner, /Return to Tenant Management/);
  assert.match(banner, /TEST/);
  assert.match(banner, /SANDBOX/);
  assert.match(admin, /Preview Tenant/);
  assert.match(wallet, /tenant\?\.name/);
  assert.match(wallet, /SANDBOX/);
  assert.match(checkCenter, /TEST/);
  assert.match(checkCenter, /SANDBOX/);
  assert.match(context, /is_test_account, moov_environment/);
  assert.match(context, /from\("tenants"\)/);
  assert.match(context, /tenants_public is active-only/);
  assert.match(whiteLabel, /subscription_status !== "active" && !canPreview/);
  assert.match(custom, /subscription_status !== "active" && !canPreview/);
  assert.match(read('src/integrations/aws/client.ts'), /isMasterOwner: identity.isMasterOwner === true/);
});
