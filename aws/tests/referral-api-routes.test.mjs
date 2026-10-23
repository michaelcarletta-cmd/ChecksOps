/**
 * Refer & Earn on AWS (owner decisions 2026-10-22, SQL 111): the redeem goes through the
 * safe write RPC path to aws_apply_referral_code, and the tenant summary and the platform
 * owner overview are read RPCs over aws_tenant_referral_summary and
 * aws_platform_owner_referral_overview. The functions themselves are covered on PostgreSQL 16
 * by sql111-tenant-referral-codes-pg.test.mjs; these tests cover the API bridge.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  APPLY_REFERRAL_CODE_SQL,
  SAFE_WRITE_RPC_CLASSIFICATION,
  SAFE_WRITE_RPCS,
  executeSafeWriteRpc,
} from '../functions/api/workflow-rpc.mjs';
import { unwrapRpcData } from '../functions/api/data.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TENANT = '11111111-1111-4111-8111-111111111111';
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';

const fakeClient = (result) => {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql === APPLY_REFERRAL_CODE_SQL) return { rows: result === undefined ? [] : [{ result }] };
      return { rows: [] };
    },
  };
};

test('apply_referral_code is a safe write RPC over aws_apply_referral_code (no money, no tenants row)', () => {
  assert.equal(SAFE_WRITE_RPC_CLASSIFICATION.apply_referral_code, 'safe_now');
  assert.equal(SAFE_WRITE_RPCS.has('apply_referral_code'), true);
  assert.equal(APPLY_REFERRAL_CODE_SQL, 'SELECT public.aws_apply_referral_code($1::uuid, $2::text) AS result');
});

test('redeem passes the tenant and the trimmed code to the function and returns its answer as data', async () => {
  const answer = { success: true, message: 'Referral code applied.', referrer_name: 'Acme Adjusting' };
  const client = fakeClient(answer);
  const res = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'apply_referral_code',
    // The Refer & Earn screen's argument names (Supabase-era apply_referral_code).
    args: { p_referring_code: '  acme-5 ', p_new_tenant_id: TENANT, p_new_user_id: APP_ID },
  });
  assert.deepEqual(res, { data: answer });
  assert.equal(client.queries.length, 1);
  assert.deepEqual(client.queries[0], { sql: APPLY_REFERRAL_CODE_SQL, params: [TENANT, 'acme-5'] });

  // The function's refusals (already_redeemed, invalid_code, own_code, mutual_referral,
  // not_authorized) come back as data so the screen shows its message.
  for (const error of ['already_redeemed', 'invalid_code', 'own_code', 'mutual_referral', 'not_authorized']) {
    const refused = { success: false, error, message: `refused: ${error}` };
    const r = await executeSafeWriteRpc({ client: fakeClient(refused), mapping: { application_user_id: APP_ID }, name: 'apply_referral_code', args: { p_referring_code: 'X1Y2', p_new_tenant_id: TENANT } });
    assert.deepEqual(r, { data: refused }, error);
  }
});

test('redeem refuses bad input before touching the database', async () => {
  for (const [args, error, field] of [
    [{ p_referring_code: 'ACME', p_new_tenant_id: 'not-a-uuid' }, 'invalid_uuid', 'p_new_tenant_id'],
    [{ p_referring_code: 'ACME' }, 'invalid_uuid', 'p_new_tenant_id'],
    [{ p_referring_code: '   ', p_new_tenant_id: TENANT }, 'missing_required_field', 'p_referring_code'],
    [{ p_referring_code: 42, p_new_tenant_id: TENANT }, 'missing_required_field', 'p_referring_code'],
  ]) {
    const client = fakeClient({ success: true });
    const res = await executeSafeWriteRpc({ client, mapping: { application_user_id: APP_ID }, name: 'apply_referral_code', args });
    assert.deepEqual(res, { error, field }, JSON.stringify(args));
    assert.equal(client.queries.length, 0);
  }
  // No row from the function is a failure, never a silent success.
  const empty = await executeSafeWriteRpc({ client: fakeClient(undefined), mapping: { application_user_id: APP_ID }, name: 'apply_referral_code', args: { p_referring_code: 'ACME', p_new_tenant_id: TENANT } });
  assert.deepEqual(empty, { error: 'referral_apply_failed' });
});

test('the summary and the owner overview are read RPCs that return the function\'s jsonb', () => {
  const src = fs.readFileSync(path.join(ROOT, 'aws/functions/api/data.mjs'), 'utf8');
  const block = (start) => src.slice(src.indexOf(start), src.indexOf(']);', src.indexOf(start)));
  for (const name of ['aws_tenant_referral_summary', 'aws_platform_owner_referral_overview']) {
    assert.match(block('const READ_RPCS = new Set(['), new RegExp(`'${name}'`), name);
    assert.match(block('const RPC_UNWRAP_SINGLE_COLUMN = new Set(['), new RegExp(`'${name}'`), name);
  }
  // The apply function stays off the read path: it writes.
  assert.doesNotMatch(block('const READ_RPCS = new Set(['), /aws_apply_referral_code|apply_referral_code/);
  const summary = { tenant_id: TENANT, referral_code: 'ACME', active_referrals: 2, earned_credit_cents: 1000, manual_discount_cents: 0, applied_discount_cents: 1000 };
  assert.deepEqual(unwrapRpcData('aws_tenant_referral_summary', [{ aws_tenant_referral_summary: summary }]), summary);
  const overview = [{ tenant_id: TENANT, active_referrals: 2 }];
  assert.deepEqual(unwrapRpcData('aws_platform_owner_referral_overview', [{ aws_platform_owner_referral_overview: overview }]), overview);
  assert.equal(unwrapRpcData('aws_tenant_referral_summary', []), null);
});
