/**
 * Audit finding 6 (2026-10-29): tenant-billing-admin `apply-event` took a transfer's billing
 * status from the request body, so in production the platform owner could mark any Collection V2
 * obligation settled without Moov. It is refused on the production runtime before any write; on
 * staging it still applies the simulated event.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleTenantBillingAdmin } from '../functions/api/tenant-billing-handlers.mjs';

const USER = 'a1000000-0000-4000-8000-000000000001';
const TENANT = '11111111-1111-4111-8111-111111111111';

const fakeClient = ({ owner = true } = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (/is_platform_owner\(\)/.test(text)) return { rows: [{ ok: owner }] };
      return { rows: [] };
    },
  };
};

const withEnv = async (value, fn) => {
  const before = process.env.CHECKSOPS_ENV;
  process.env.CHECKSOPS_ENV = value;
  try { return await fn(); } finally {
    if (before === undefined) delete process.env.CHECKSOPS_ENV; else process.env.CHECKSOPS_ENV = before;
  }
};

const applyEvent = (client) => handleTenantBillingAdmin(
  { body: JSON.stringify({ action: 'apply-event', tenant_id: TENANT, provider_transfer_id: 'tr_123', status: 'completed' }) },
  { client, mapping: { application_user_id: USER } },
);

const writes = (client) => client.queries.filter((q) => /^\s*(UPDATE|INSERT|DELETE)\b/i.test(q.sql) || /tenant_maintenance_payments|provider_transfer/i.test(q.sql));

for (const env of ['production', 'production-prep']) {
  test(`${env}: apply-event is refused before any write, even for the platform owner`, async () => {
    const client = fakeClient();
    const result = await withEnv(env, () => applyEvent(client));
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, 'apply_event_staging_only');
    assert.equal(result.ok, false);
    assert.deepEqual(writes(client), []);
  });
}

test('staging: apply-event still runs the simulated provider event', async () => {
  const client = fakeClient();
  const result = await withEnv('staging', () => applyEvent(client));
  assert.notEqual(result.error, 'apply_event_staging_only');
  assert.ok(client.queries.some((q) => /provider_transfer_id|tenant_maintenance_payments|billing/i.test(q.sql) && !/is_platform_owner/.test(q.sql)), 'the event lookup ran');
});

test('a non-owner is refused first in every environment', async () => {
  for (const env of ['production', 'staging']) {
    const result = await withEnv(env, () => applyEvent(fakeClient({ owner: false })));
    assert.equal(result.error, 'platform_owner_required', env);
  }
});
