/**
 * Owner 2026-11-13: a check a partner shared with this organization and then paid out of by a send to someone else
 * "stays in deposited with a note saying Freedom paid it out". The partner learns it through SQL 162's
 * get_shared_check_source_sends (/data/rpc, data.mjs READ_RPCS behind the tenant gate): check id, sharing organization
 * and the newest send's time only. The Check Command Center adds a note on the row; nothing moves between tabs and no
 * total changes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  SHARED_CHECK_SOURCE_SENDS_RPC,
  fetchSharedCheckSourceSends,
  partnerPaidOutAt,
} from '../../src/lib/payments/transferFinanceRows.ts';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const FREEDOM = '9b1f3c55-1111-4222-8333-444455556666';

test('the read calls SQL 162 through /data/rpc with the tenant id; a refused or failed read is no rows', async () => {
  assert.equal(SHARED_CHECK_SOURCE_SENDS_RPC, 'get_shared_check_source_sends');
  const calls = [];
  const rows = [{ check_id: 'c1', source_tenant_id: FREEDOM, last_sent_at: '2026-11-12T19:06:01Z' }];
  const ok = { rpc: async (name, args) => { calls.push([name, args]); return { data: rows, error: null }; } };
  assert.deepEqual(await fetchSharedCheckSourceSends(ok, TENANT), rows);
  assert.deepEqual(calls, [['get_shared_check_source_sends', { _tenant_id: TENANT }]]);
  for (const client of [
    { rpc: async () => ({ data: null, error: { message: 'rpc_disabled' } }) },
    { rpc: async () => ({ data: { not: 'an array' }, error: null }) },
    { rpc: async () => { throw new Error('network'); } },
  ]) {
    assert.deepEqual(await fetchSharedCheckSourceSends(client, TENANT), []);
  }
  // Rows without a check id are dropped.
  const odd = { rpc: async () => ({ data: [{ check_id: '' }, null, { check_id: 'c2', last_sent_at: null }], error: null }) };
  assert.deepEqual((await fetchSharedCheckSourceSends(odd, TENANT)).map((r) => r.check_id), ['c2']);
});

test('partnerPaidOutAt: one entry per check, the newest time kept, a missing time kept as null', () => {
  const map = partnerPaidOutAt([
    { check_id: 'c1', source_tenant_id: FREEDOM, last_sent_at: '2026-11-10T10:00:00Z' },
    { check_id: 'c1', source_tenant_id: 'other', last_sent_at: '2026-11-12T10:00:00Z' },
    { check_id: 'c2', source_tenant_id: FREEDOM, last_sent_at: null },
  ]);
  assert.deepEqual([...map.keys()], ['c1', 'c2']);
  assert.equal(map.get('c1'), '2026-11-12T10:00:00Z');
  assert.equal(map.get('c2'), null);
  assert.equal(partnerPaidOutAt(null).size, 0);
  assert.equal(partnerPaidOutAt([]).size, 0);
});

test('the page shows the note on a shared check row only; Deposited, counts and totals are untouched', () => {
  const page = read('src/pages/CheckCommandCenter.tsx');
  assert.match(page, /const \{ data: sharedSourceSends = \[\] \} = useSharedCheckSourceSends\(tenantId\);/);
  assert.match(page, /const partnerPaidOut = useMemo\(\(\) => partnerPaidOutAt\(sharedSourceSends\), \[sharedSourceSends\]\);/);
  assert.match(page, /\{isShared && partnerPaidOut\.has\(check\.id\) && \(\s*<PartnerPaidOutBadge sourceTenantName=\{sourceTenantName\} paidAt=\{partnerPaidOut\.get\(check\.id\)\} \/>\s*\)\}/);
  // The paid-out set feeds nothing but the note: no lane filter, count or total reads it.
  assert.equal([...page.matchAll(/partnerPaidOut\b/g)].length, 3);
  assert.equal([...page.matchAll(/sharedSourceSends\b/g)].length, 3);
  const badge = read('src/components/check-review/PartnerPaidOutBadge.tsx');
  assert.match(badge, /\{`\$\{who\} paid it out`\}/);
  assert.match(badge, /const who = sourceTenantName \|\| "Partner";/);
  const hook = read('src/hooks/useTransferFinance.ts');
  assert.match(hook, /queryFn: \(\) => fetchSharedCheckSourceSends\(supabase, tenantId!\),/);
});
