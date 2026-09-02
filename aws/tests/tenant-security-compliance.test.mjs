import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPendingComplianceSnapshot,
  handleTenantSecurityCompliance,
  isValidTenantId,
  tenantAllowedForIdentity,
} from '../functions/api/tenant-security-compliance.mjs';

const TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER_TENANT_ID = '4f172140-f57a-4744-8050-95f4f07b13b4';

test('validates tenant UUIDs', () => {
  assert.equal(isValidTenantId(TENANT_ID), true);
  assert.equal(isValidTenantId('not-a-tenant'), false);
});

test('membership check is tenant-specific', () => {
  const identity = { ok: true, tenants: [{ tenant_id: TENANT_ID }] };
  assert.equal(tenantAllowedForIdentity(identity, TENANT_ID), true);
  assert.equal(tenantAllowedForIdentity(identity, OTHER_TENANT_ID), false);
});

test('pending snapshot matches frontend contract without fabricating compliance evidence', () => {
  const snapshot = buildPendingComplianceSnapshot({ tenantId: TENANT_ID, tenantName: 'Freedom' });
  assert.equal(snapshot.overview.securityStatus, 'Pending');
  assert.deepEqual(snapshot.accessRecords, []);
  assert.deepEqual(snapshot.auditEvents, []);
  assert.equal(snapshot.meta.readOnly, true);
});

test('rejects unauthenticated requests', async () => {
  const result = await handleTenantSecurityCompliance({}, TENANT_ID, {
    resolveClaims: async () => ({ ok: false, statusCode: 401, error: 'missing_cognito_token' }),
    resolveIdentity: async () => { throw new Error('must not resolve identity'); },
  });
  assert.equal(result.statusCode, 401);
});

test('rejects cross-tenant access', async () => {
  const result = await handleTenantSecurityCompliance({}, OTHER_TENANT_ID, {
    resolveClaims: async () => ({ ok: true, claims: { sub: 'cognito-sub', email: 'user@example.com' } }),
    resolveIdentity: async () => ({
      ok: true,
      tenants: [{ tenant_id: TENANT_ID, tenant_name: 'Freedom', role: 'operator' }],
    }),
  });
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'tenant_access_denied');
});

test('returns read-only placeholder snapshot for authorized tenant', async () => {
  const result = await handleTenantSecurityCompliance({}, TENANT_ID, {
    resolveClaims: async () => ({ ok: true, claims: { sub: 'cognito-sub', email: 'user@example.com' } }),
    resolveIdentity: async () => ({
      ok: true,
      tenants: [{ tenant_id: TENANT_ID, tenant_name: 'Freedom', role: 'operator' }],
    }),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.snapshot.meta.tenantId, TENANT_ID);
  assert.equal(result.snapshot.meta.readOnly, true);
  assert.equal(result.snapshot.overview.securityStatus, 'Pending');
});
