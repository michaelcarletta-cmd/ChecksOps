/**
 * Shared S5 Audited Claim Association safeguard helpers.
 * Behavioral assertions plus local-copy mutation probes.
 * Does not call AWS, mutate production SQL, or pin a Lambda SHA.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const S5_LABEL = 'S5 Audited Claim Association';
export const S5_SQL = 'aws/workflows/sql/71_admin_set_check_claim.sql';
export const S5_RPC = 'aws/functions/api/workflow-rpc.mjs';
export const S5_ALLOWLIST = 'aws/functions/api/write-allowlist.mjs';

export const ADMIN = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
export const STAFF = '44444444-4444-4444-8444-444444444444';
export const CHECK_ID = '33333333-3333-4333-8333-333333333333';
export const CLAIM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const CLAIM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const CLAIM_C1C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
export const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';

export const s5Assert = (condition, message) => {
  if (!condition) {
    const error = new Error(`${S5_LABEL}: ${message}`);
    error.s5 = true;
    throw error;
  }
};

export const readRepo = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const rewriteRelativeImports = (source, fromDir) => source.replace(
  /from\s+['"](\.\/[^'"]+)['"]/g,
  (_all, rel) => `from ${JSON.stringify(pathToFileURL(path.join(fromDir, rel)).href)}`,
);

export const importMutatedModule = async (root, rel, mutate) => {
  const abs = path.join(root, rel);
  const fromDir = path.dirname(abs);
  const original = fs.readFileSync(abs, 'utf8');
  const mutated = rewriteRelativeImports(mutate(original), fromDir);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's5-mod-'));
  const dest = path.join(dir, path.basename(rel));
  fs.writeFileSync(dest, mutated);
  return import(`${pathToFileURL(dest).href}?t=${Date.now()}-${Math.random()}`);
};

export const expectS5Failure = async (label, fn) => {
  let failed = false;
  let message = '';
  try {
    await fn();
  } catch (error) {
    failed = true;
    message = String(error?.message || error);
  }
  assert.equal(failed, true, `${S5_LABEL}: expected FAIL for ${label}`);
  assert.match(message, /S5 Audited Claim Association/, `${S5_LABEL}: failure for ${label} must name S5`);
};

const isWrite = (sql) => /admin_set_check_claim\(\$1::uuid/.test(sql)
  || /UPDATE public.check_intake_items/.test(sql)
  || /INSERT INTO public.check_audit_log/.test(sql);

export const mockClient = ({
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
      if (sql.includes('public.admin_set_check_claim')) {
        const prior = store.check?.claim_id || null;
        const next = params[2] ?? null;
        store.check = { ...store.check, claim_id: next };
        return {
          rows: [{
            result: {
              ok: true,
              noop: false,
              check_id: CHECK_ID,
              prior_claim_id: prior,
              new_claim_id: next,
              claim_id: next,
            },
          }],
        };
      }
      return { rows: [] };
    },
  };
};

export const assertSqlContract = (sql) => {
  s5Assert(/CREATE OR REPLACE FUNCTION public\.admin_set_check_claim/.test(sql), 'SQL function is missing');
  s5Assert(/SECURITY DEFINER/.test(sql), 'SQL remains SECURITY DEFINER with accepted authorization is missing');
  s5Assert(/GRANT EXECUTE ON FUNCTION public\.admin_set_check_claim/.test(sql), 'GRANT EXECUTE is missing');
  const grantUpdateEscape = sql.split('\n').filter((line) => (
    /GRANT\s+UPDATE\s*\(\s*claim_id\s*\)/i.test(line) && !/^\s*--/.test(line)
  ));
  s5Assert(grantUpdateEscape.length === 0, 'SQL introduces a direct GRANT UPDATE(claim_id) escape path');
  s5Assert(/Does not GRANT UPDATE\(claim_id\)/.test(sql), 'SQL contract comment against GRANT UPDATE(claim_id) is missing');
  s5Assert(/v_check\.deposited_at IS NOT NULL/.test(sql), 'SQL deposited protection is missing');
  s5Assert(/FROM public\.tenant_users/.test(sql), 'SQL tenant membership protection is missing');
  s5Assert(/v_claim\.tenant_id IS DISTINCT FROM v_check\.tenant_id/.test(sql), 'SQL tenant claim protection is missing');
  s5Assert(/INSERT INTO public\.check_audit_log/.test(sql), 'SQL audit insertion is missing');
  s5Assert(/'admin_set_check_claim'/.test(sql), 'SQL audit event type is missing');
  s5Assert(/prior_claim_id/.test(sql) && /new_claim_id/.test(sql), 'immutable audit prior/new claim fields are missing');
  s5Assert(/actor_id/.test(sql) && /check_id/.test(sql), 'immutable audit actor/check fields are missing');
};

export const assertRpcBridge = (rpc) => {
  s5Assert(rpc.SAFE_WRITE_RPCS.has('admin_set_check_claim'), 'RPC remains explicitly allowed through the accepted narrow bridge');
  s5Assert(
    rpc.SAFE_WRITE_RPC_CLASSIFICATION.admin_set_check_claim === 'safe_now',
    'RPC remains classified through the accepted narrow bridge',
  );
  s5Assert(typeof rpc.executeAdminSetCheckClaim === 'function', 'accepted S5 RPC implementation is missing');
};

export const assertAcceptedInvariants = async (rpc, sql, allowlist) => {
  assertRpcBridge(rpc);
  assertSqlContract(sql);
  s5Assert(allowlist.INTAKE_PROHIBITED_COLUMNS.has('claim_id'), 'generic /data/write claim_id remains prohibited');

  const client = mockClient();
  const setA = await rpc.executeAdminSetCheckClaim({
    client,
    mapping: { application_user_id: ADMIN },
    args: { p_check_id: CHECK_ID, p_claim_id: CLAIM_A },
  });
  s5Assert(setA.data?.ok === true && setA.data.noop === false, 'authorized admin cannot set claim_id before deposit');
  s5Assert(setA.data.prior_claim_id === null && setA.data.new_claim_id === CLAIM_A, 'set result lost prior/new claim');
  s5Assert(client.queries.some((row) => /public\.admin_set_check_claim/.test(row.sql)
    && row.params[0] === ADMIN
    && row.params[1] === CHECK_ID
    && row.params[2] === CLAIM_A), 'RPC did not call the accepted SQL function');

  const setB = await rpc.executeAdminSetCheckClaim({
    client,
    mapping: { application_user_id: ADMIN },
    args: { p_check_id: CHECK_ID, p_claim_id: CLAIM_B },
  });
  s5Assert(setB.data?.prior_claim_id === CLAIM_A && setB.data.new_claim_id === CLAIM_B, 'authorized admin cannot correct claim_id');

  const writesBeforeNoop = client.queries.filter((row) => /public\.admin_set_check_claim/.test(row.sql)).length;
  const noop = await rpc.executeAdminSetCheckClaim({
    client,
    mapping: { application_user_id: ADMIN },
    args: { p_check_id: CHECK_ID, p_claim_id: CLAIM_B },
  });
  s5Assert(noop.data?.noop === true, 'same-value request is no longer a no-op');
  s5Assert(
    client.queries.filter((row) => /public\.admin_set_check_claim/.test(row.sql)).length === writesBeforeNoop,
    'same-value request wrote again',
  );

  const cleared = await rpc.executeAdminSetCheckClaim({
    client,
    mapping: { application_user_id: ADMIN },
    args: { p_check_id: CHECK_ID, p_claim_id: null },
  });
  s5Assert(cleared.data?.prior_claim_id === CLAIM_B && cleared.data.new_claim_id === null, 'authorized admin cannot clear claim_id');

  const dispatched = await rpc.executeSafeWriteRpc({
    client: mockClient(),
    mapping: { application_user_id: ADMIN },
    name: 'admin_set_check_claim',
    args: { p_check_id: CHECK_ID, p_claim_id: CLAIM_A },
  });
  s5Assert(dispatched.data?.ok === true, 'RPC dispatcher no longer routes admin_set_check_claim');

  const staff = mockClient({ roles: [{ role: 'staff' }] });
  const staffResult = await rpc.executeAdminSetCheckClaim({
    client: staff,
    mapping: { application_user_id: STAFF },
    args: { p_check_id: CHECK_ID, p_claim_id: CLAIM_A },
  });
  s5Assert(staffResult.error === 'not_authorized', 'non-admin was allowed to set claim_id');
  s5Assert(!staff.queries.some((row) => isWrite(row.sql)), 'non-admin request mutated claim_id');

  const outsider = mockClient({ member: false });
  const outsiderResult = await rpc.executeAdminSetCheckClaim({
    client: outsider,
    mapping: { application_user_id: ADMIN },
    args: { p_check_id: CHECK_ID, p_claim_id: CLAIM_A },
  });
  s5Assert(outsiderResult.error === 'not_authorized', 'tenant protection is missing');
  s5Assert(!outsider.queries.some((row) => isWrite(row.sql)), 'cross-tenant membership request mutated claim_id');

  const cross = mockClient();
  const crossResult = await rpc.executeAdminSetCheckClaim({
    client: cross,
    mapping: { application_user_id: ADMIN },
    args: { p_check_id: CHECK_ID, p_claim_id: CLAIM_C1C },
  });
  s5Assert(crossResult.error === 'cross_tenant_denied', 'target claim must belong to the same tenant');
  s5Assert(!cross.queries.some((row) => isWrite(row.sql)), 'cross-tenant claim request mutated claim_id');

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
  const depositedResult = await rpc.executeAdminSetCheckClaim({
    client: deposited,
    mapping: { application_user_id: ADMIN },
    args: { p_check_id: CHECK_ID, p_claim_id: CLAIM_B },
  });
  s5Assert(depositedResult.error === 'already_deposited', 'deposited check cannot change claim_id');
  s5Assert(deposited.store.check.claim_id === CLAIM_A, 'deposited check claim_id changed');
  const depositedClear = await rpc.executeAdminSetCheckClaim({
    client: deposited,
    mapping: { application_user_id: ADMIN },
    args: { p_check_id: CHECK_ID, p_claim_id: null },
  });
  s5Assert(depositedClear.error === 'already_deposited', 'deposited check cannot clear claim_id');
  s5Assert(deposited.store.check.claim_id === CLAIM_A, 'deposited check claim_id was cleared');
};

export const mutateRemoveRpcBridge = (source) => {
  const next = source
    .replace("  admin_set_check_claim: 'safe_now',\n", '')
    .replace("  'admin_set_check_claim',\n", '')
    .replace("    case 'admin_set_check_claim':\n      return executeAdminSetCheckClaim({ client, mapping, args });\n", '');
  if (next === source || next.includes("case 'admin_set_check_claim'")) {
    throw new Error(`${S5_LABEL}: cannot apply RPC dispatcher/bridge mutation`);
  }
  return next;
};

export const mutateRemoveDepositedProtection = (source) => {
  const target = `  if (check.deposited_at) {
    return { error: 'already_deposited', message: 'claim_id cannot change after deposit' };
  }`;
  if (!source.includes(target)) {
    throw new Error(`${S5_LABEL}: cannot apply deposited-protection mutation`);
  }
  return source.replace(target, '');
};

export const mutateRemoveTenantProtection = (source) => {
  const member = `  if (!member) {
    return { error: 'not_authorized', message: 'Check is not in the caller tenant' };
  }`;
  const cross = `    if (claim && String(claim.tenant_id) !== String(check.tenant_id)) {
      return { error: 'cross_tenant_denied', message: 'Target claim is not in the check tenant' };
    }`;
  if (!source.includes(member) || !source.includes(cross)) {
    throw new Error(`${S5_LABEL}: cannot apply tenant-protection mutation`);
  }
  return source.replace(member, '').replace(cross, '');
};

export const mutateRemoveAuditInsert = (sql) => {
  const next = sql.replace(/INSERT INTO public\.check_audit_log \([\s\S]*?\);/, '');
  if (next === sql || /INSERT INTO public\.check_audit_log/.test(next)) {
    throw new Error(`${S5_LABEL}: cannot apply audit-insertion mutation`);
  }
  return next;
};

export const mutateAllowGenericClaimId = (source) => {
  const target = `export const INTAKE_PROHIBITED_COLUMNS = new Set([
  'amount',
  'pa_fee_amount',
  'pa_fee_pct',
  'routing_number',
  'account_number',
  'status',
  'check_stage',
  'claim_id',`;
  const next = `export const INTAKE_PROHIBITED_COLUMNS = new Set([
  'amount',
  'pa_fee_amount',
  'pa_fee_pct',
  'routing_number',
  'account_number',
  'status',
  'check_stage',`;
  if (!source.includes(target)) {
    throw new Error(`${S5_LABEL}: cannot apply generic claim_id prohibition mutation`);
  }
  return source.replace(target, next);
};
