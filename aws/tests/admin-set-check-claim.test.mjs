import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeAdminSetCheckClaim, SAFE_WRITE_RPCS } from '../functions/api/workflow-rpc.mjs';
import { INTAKE_PROHIBITED_COLUMNS } from '../functions/api/write-allowlist.mjs';

const ADMIN = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const STAFF = '44444444-4444-4444-8444-444444444444';
const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const CLAIM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLAIM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLAIM_C1C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';

const mockClient = ({
  roles = [{ role: 'admin' }],
  check = {
    id: CHECK_ID,
    tenant_id: FREEDOM,
    claim_id: null,
    deposited_at: null,
    amount: 150,
    status: 'needs_review',
  },
  member = true,
  claim = { id: CLAIM_A, tenant_id: FREEDOM },
  updateRow = null,
} = {}) => {
  const queries = [];
  const store = { check: { ...check } };
  return {
    queries,
    store,
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql.includes('FROM public.user_roles')) return { rows: roles };
      if (sql.includes('FROM public.check_intake_items') && sql.includes('SELECT id, tenant_id, claim_id')) {
        return { rows: store.check ? [store.check] : [] };
      }
      if (sql.includes('FROM public.tenant_users')) return { rows: member ? [{ '?column?': 1 }] : [] };
      if (sql.includes('FROM public.claims')) {
        const id = params[0];
        if (claim && String(claim.id) === String(id)) return { rows: [claim] };
        if (String(id) === CLAIM_C1C) return { rows: [{ id: CLAIM_C1C, tenant_id: C1C }] };
        if (String(id) === CLAIM_B) return { rows: [{ id: CLAIM_B, tenant_id: FREEDOM }] };
        if (String(id) === CLAIM_A) return { rows: [{ id: CLAIM_A, tenant_id: FREEDOM }] };
        return { rows: [] };
      }
      if (sql.includes('UPDATE public.check_intake_items')) {
        if (store.check?.deposited_at) return { rows: [] };
        store.check = {
          ...store.check,
          claim_id: params[1],
        };
        return { rows: [updateRow || store.check] };
      }
      if (sql.includes('INSERT INTO public.check_audit_log')) return { rows: [{ id: 'audit-1' }] };
      return { rows: [] };
    },
  };
};

test('generic intake allowlist still prohibits claim_id', () => {
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('claim_id'), true);
  assert.equal(SAFE_WRITE_RPCS.has('admin_set_check_claim'), true);
});

test('admin can set, correct, and clear claim_id with audit; noop skips audit', async () => {
  const client = mockClient();
  const setA = await executeAdminSetCheckClaim({
    client,
    mapping: { application_user_id: ADMIN },
    args: { p_check_id: CHECK_ID, p_claim_id: CLAIM_A },
  });
  assert.equal(setA.data.ok, true);
  assert.equal(setA.data.noop, false);
  assert.equal(setA.data.prior_claim_id, null);
  assert.equal(setA.data.new_claim_id, CLAIM_A);
  assert.ok(client.queries.some((row) => /INSERT INTO public.check_audit_log/.test(row.sql)
    && JSON.parse(row.params[3]).prior_claim_id === null
    && JSON.parse(row.params[3]).new_claim_id === CLAIM_A));

  const setB = await executeAdminSetCheckClaim({
    client,
    mapping: { application_user_id: ADMIN },
    args: { p_check_id: CHECK_ID, p_claim_id: CLAIM_B },
  });
  assert.equal(setB.data.prior_claim_id, CLAIM_A);
  assert.equal(setB.data.new_claim_id, CLAIM_B);

  const auditsBeforeClear = client.queries.filter((row) => /INSERT INTO public.check_audit_log/.test(row.sql)).length;
  const noop = await executeAdminSetCheckClaim({
    client,
    mapping: { application_user_id: ADMIN },
    args: { p_check_id: CHECK_ID, p_claim_id: CLAIM_B },
  });
  assert.equal(noop.data.noop, true);
  const auditsAfterNoop = client.queries.filter((row) => /INSERT INTO public.check_audit_log/.test(row.sql)).length;
  assert.equal(auditsAfterNoop, auditsBeforeClear);

  const cleared = await executeAdminSetCheckClaim({
    client,
    mapping: { application_user_id: ADMIN },
    args: { p_check_id: CHECK_ID, p_claim_id: null },
  });
  assert.equal(cleared.data.prior_claim_id, CLAIM_B);
  assert.equal(cleared.data.new_claim_id, null);
  const lastAudit = [...client.queries].reverse().find((row) => /INSERT INTO public.check_audit_log/.test(row.sql));
  assert.equal(JSON.parse(lastAudit.params[3]).new_claim_id, null);
  assert.equal(JSON.parse(lastAudit.params[3]).prior_claim_id, CLAIM_B);
});

test('staff, cross-tenant claim, and deposited checks are denied without mutation', async () => {
  const staff = mockClient({ roles: [{ role: 'staff' }] });
  const staffResult = await executeAdminSetCheckClaim({
    client: staff,
    mapping: { application_user_id: STAFF },
    args: { p_check_id: CHECK_ID, p_claim_id: CLAIM_A },
  });
  assert.equal(staffResult.error, 'not_authorized');
  assert.equal(staff.queries.some((row) => /UPDATE public.check_intake_items/.test(row.sql)), false);

  const outsider = mockClient({ member: false });
  const outsiderResult = await executeAdminSetCheckClaim({
    client: outsider,
    mapping: { application_user_id: ADMIN },
    args: { p_check_id: CHECK_ID, p_claim_id: CLAIM_A },
  });
  assert.equal(outsiderResult.error, 'not_authorized');
  assert.equal(outsider.queries.some((row) => /UPDATE public.check_intake_items/.test(row.sql)), false);

  const cross = mockClient();
  const crossResult = await executeAdminSetCheckClaim({
    client: cross,
    mapping: { application_user_id: ADMIN },
    args: { p_check_id: CHECK_ID, p_claim_id: CLAIM_C1C },
  });
  assert.equal(crossResult.error, 'cross_tenant_denied');
  assert.equal(cross.queries.some((row) => /UPDATE public.check_intake_items/.test(row.sql)), false);

  const deposited = mockClient({
    check: {
      id: CHECK_ID,
      tenant_id: FREEDOM,
      claim_id: CLAIM_A,
      deposited_at: '2026-09-01T00:00:00.000Z',
      amount: 150,
      status: 'deposited',
    },
  });
  const depositedResult = await executeAdminSetCheckClaim({
    client: deposited,
    mapping: { application_user_id: ADMIN },
    args: { p_check_id: CHECK_ID, p_claim_id: CLAIM_B },
  });
  assert.equal(depositedResult.error, 'already_deposited');
  assert.equal(deposited.queries.some((row) => /UPDATE public.check_intake_items/.test(row.sql)), false);
  assert.equal(deposited.store.check.claim_id, CLAIM_A);

  const depositedClear = await executeAdminSetCheckClaim({
    client: deposited,
    mapping: { application_user_id: ADMIN },
    args: { p_check_id: CHECK_ID, p_claim_id: null },
  });
  assert.equal(depositedClear.error, 'already_deposited');
  assert.equal(deposited.store.check.claim_id, CLAIM_A);
  assert.equal(deposited.queries.some((row) => /INSERT INTO public.check_audit_log/.test(row.sql)), false);
});

test('claim association update does not rewrite amount or deposit columns', async () => {
  const client = mockClient();
  await executeAdminSetCheckClaim({
    client,
    mapping: { application_user_id: ADMIN },
    args: { p_check_id: CHECK_ID, p_claim_id: CLAIM_A },
  });
  const update = client.queries.find((row) => /UPDATE public.check_intake_items/.test(row.sql));
  assert.ok(update);
  const setClause = update.sql.split('WHERE')[0];
  assert.match(setClause, /SET claim_id = \$2::uuid,\s+updated_at = now\(\)/);
  assert.equal(/amount|payee_line|status|check_stage/.test(setClause), false);
  assert.equal(client.store.check.amount, 150);
});
