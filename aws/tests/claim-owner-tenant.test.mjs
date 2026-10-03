import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACTIVE_TENANT_SLUG_GUC,
  bindActiveTenantSlug,
  resolveActiveTenantSlug,
  sanitizeTenantSlug,
} from '../functions/api/claim-owner-tenant.mjs';

const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';

test('sanitizeTenantSlug accepts slugs and rejects UUIDs / identity keys', () => {
  assert.equal(sanitizeTenantSlug('freedom'), 'freedom');
  assert.equal(sanitizeTenantSlug('C1C'), 'c1c');
  assert.equal(sanitizeTenantSlug(' home-hero '), 'home-hero');
  assert.equal(sanitizeTenantSlug(FREEDOM), null);
  assert.equal(sanitizeTenantSlug(C1C), null);
  assert.equal(sanitizeTenantSlug(''), null);
  assert.equal(sanitizeTenantSlug('../freedom'), null);
  assert.equal(sanitizeTenantSlug('org_id'), null);
});

test('resolveActiveTenantSlug reads only the slug hint, never org_id / tenant_id', () => {
  assert.equal(resolveActiveTenantSlug({
    headers: { 'x-active-tenant-slug': 'freedom', 'x-tenant-id': C1C },
    queryStringParameters: { tenant_id: C1C, tenant_slug: FREEDOM },
  }, { org_id: C1C, tenant_id: C1C, active_tenant_slug: 'ignored-when-header-present' }), 'freedom');

  assert.equal(resolveActiveTenantSlug({
    headers: { 'X-Active-Tenant-Slug': 'C1C' },
  }, { org_id: FREEDOM }), 'c1c');

  assert.equal(resolveActiveTenantSlug({
    queryStringParameters: { tenant_slug: 'barzzini' },
  }, { org_id: FREEDOM }), 'barzzini');

  assert.equal(resolveActiveTenantSlug({
    headers: { 'x-tenant-id': FREEDOM },
    queryStringParameters: { tenant_id: C1C, org_id: FREEDOM },
  }, { org_id: C1C, tenant_id: FREEDOM }), null);

  assert.equal(resolveActiveTenantSlug({
    headers: { 'x-active-tenant-slug': FREEDOM },
  }, { active_tenant_slug: C1C }), null);
});

test('bindActiveTenantSlug sets the GUC to a sanitized slug or empty', async () => {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [{ set_config: params[1] }] };
    },
  };

  const bound = await bindActiveTenantSlug(client, {
    headers: { 'x-active-tenant-slug': 'Freedom' },
  }, { org_id: C1C });
  assert.equal(bound, 'freedom');
  assert.deepEqual(queries[0], {
    sql: 'SELECT set_config($1, $2, true)',
    params: [ACTIVE_TENANT_SLUG_GUC, 'freedom'],
  });

  queries.length = 0;
  const ignored = await bindActiveTenantSlug(client, {
    headers: { 'x-tenant-id': C1C, 'x-active-tenant-slug': C1C },
  }, { org_id: FREEDOM, tenant_id: FREEDOM });
  assert.equal(ignored, null);
  assert.deepEqual(queries[0].params, [ACTIVE_TENANT_SLUG_GUC, '']);
});
