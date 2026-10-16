import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeSafeWriteRpc } from '../functions/api/workflow-rpc.mjs';

const USER = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';
const OWN_CLAIM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOREIGN_CLAIM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORGLESS_CLAIM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FOREIGN_CASE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const claimRow = (id, orgId, name) => ({
  id,
  org_id: orgId,
  claim_number: `CLM-${id.slice(0, 4)}`,
  policyholder_name: name,
  policyholder_email: `${name.toLowerCase()}@example.com`,
  policyholder_phone: '555-0100',
  policyholder_address: '1 Main St',
  insurance_company: 'Carrier Co',
  policy_number: 'POL-1',
  mortgage_company_id: '11111111-1111-4111-8111-111111111111',
  loan_number: 'LN-1',
  loss_date: '2026-01-02',
});

/**
 * Fake client over a tiny in-memory model of tenant_users, user_roles,
 * claims, check_intake_items and check_cases. check_cases enforces the
 * repo's global unique index (external_system, external_claim_id).
 */
const fakeDb = ({
  memberships = [{ user_id: USER, tenant_id: TENANT, role: 'operator' }],
  userRoles = [],
  claims = [
    claimRow(OWN_CLAIM, TENANT, 'Alice'),
    claimRow(FOREIGN_CLAIM, OTHER_TENANT, 'Mallory'),
    claimRow(ORGLESS_CLAIM, null, 'Orla'),
  ],
  checks = [],
  cases = [],
} = {}) => {
  const queries = [];
  let seq = 0;
  const client = {
    queries,
    cases,
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (/FROM public\.user_roles/.test(sql)) {
        return { rows: userRoles.filter((r) => r.user_id === params[0]).map(() => ({ '?column?': 1 })) };
      }
      if (/FROM public\.tenant_users/.test(sql)) {
        assert.match(sql, /lower\(role::text\) IN \('owner', 'admin', 'manager', 'operator'\)/);
        const ok = memberships.some((m) => m.user_id === params[0] && m.tenant_id === params[1]
          && ['owner', 'admin', 'manager', 'operator'].includes(String(m.role).toLowerCase()));
        return { rows: ok ? [{ '?column?': 1 }] : [] };
      }
      if (/FROM public\.claims/.test(sql)) {
        assert.match(sql, /c\.org_id = \$2::uuid/);
        assert.match(sql, /check_intake_items/);
        const [claimId, tenantId] = params;
        const c = claims.find((row) => row.id === claimId);
        if (!c) return { rows: [] };
        const owned = c.org_id === tenantId
          || (c.org_id == null && checks.some((ci) => ci.claim_id === c.id && ci.tenant_id === tenantId));
        return { rows: owned ? [c] : [] };
      }
      if (/^\s*SELECT id FROM public\.check_cases/.test(sql)) {
        assert.match(sql, /tenant_id = \$1::uuid/);
        if (/external_system = 'freedom_crm'/.test(sql)) {
          const [tenantId, ext] = params;
          const row = cases.find((c) => c.tenant_id === tenantId
            && c.external_system === 'freedom_crm' && c.external_claim_id === ext);
          return { rows: row ? [{ id: row.id }] : [] };
        }
        const [tenantId, claimNumber] = params;
        const row = cases.find((c) => c.tenant_id === tenantId && c.external_claim_id == null
          && (c.claim_number ?? null) === (claimNumber ?? null));
        return { rows: row ? [{ id: row.id }] : [] };
      }
      if (/INSERT INTO public\.check_cases/.test(sql)) {
        const [
          tenantId, externalSystem, externalClaimId, claimNumber, insuredName,
          insuredEmail, insuredPhone, propertyAddress, carrierName, policyNumber,
          mortgageCompanyId, loanNumber, lossDate,
        ] = params;
        if (externalClaimId != null && cases.some((c) => c.external_system === externalSystem
          && c.external_claim_id === externalClaimId)) {
          return { rows: [] };
        }
        seq += 1;
        const id = `eeeeeeee-eeee-4eee-8eee-${String(seq).padStart(12, '0')}`;
        cases.push({
          id, tenant_id: tenantId, external_system: externalSystem, external_claim_id: externalClaimId,
          claim_number: claimNumber, insured_name: insuredName, insured_email: insuredEmail,
          insured_phone: insuredPhone, property_address: propertyAddress, carrier_name: carrierName,
          policy_number: policyNumber, mortgage_company_id: mortgageCompanyId, loan_number: loanNumber,
          loss_date: lossDate,
        });
        return { rows: [{ id }] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return client;
};

const call = (client, args, userId = USER) => executeSafeWriteRpc({
  client,
  mapping: { application_user_id: userId },
  name: 'resolve_check_case',
  args: { _tenant_id: TENANT, ...args },
});

const inserts = (client) => client.queries.filter((q) => /INSERT INTO public\.check_cases/.test(q.sql));

test('same-tenant claim: case is created with the claim fields copied', async () => {
  const client = fakeDb();
  const result = await call(client, { _claim_id: OWN_CLAIM });
  assert.ok(result.data);
  assert.equal(client.cases.length, 1);
  const row = client.cases[0];
  assert.equal(row.id, result.data);
  assert.equal(row.tenant_id, TENANT);
  assert.equal(row.external_system, 'freedom_crm');
  assert.equal(row.external_claim_id, OWN_CLAIM);
  assert.equal(row.insured_name, 'Alice');
  assert.equal(row.insured_email, 'alice@example.com');
  assert.equal(row.insured_phone, '555-0100');
  assert.equal(row.property_address, '1 Main St');
  assert.equal(row.carrier_name, 'Carrier Co');
  assert.equal(row.policy_number, 'POL-1');
  assert.equal(row.mortgage_company_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(row.loan_number, 'LN-1');
  assert.equal(row.loss_date, '2026-01-02');
});

test("another tenant's claim is refused and nothing is inserted", async () => {
  const client = fakeDb();
  const result = await call(client, {
    _claim_id: FOREIGN_CLAIM,
    _claim_number: 'X-1',
    _insured_name: 'Someone',
  });
  assert.equal(result.error, 'claim_not_in_tenant');
  assert.equal(result.data, undefined);
  assert.equal(inserts(client).length, 0);
  assert.equal(client.cases.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /Mallory|mallory@example\.com|POL-1|LN-1/);
});

test('an unknown claim id is refused the same way (no existence oracle)', async () => {
  const client = fakeDb();
  const result = await call(client, { _claim_id: '12345678-1234-4234-8234-123456789abc' });
  assert.equal(result.error, 'claim_not_in_tenant');
  assert.equal(inserts(client).length, 0);
});

test("org-less claim is allowed only with this tenant's own check", async () => {
  const none = fakeDb();
  assert.equal((await call(none, { _claim_id: ORGLESS_CLAIM })).error, 'claim_not_in_tenant');
  assert.equal(inserts(none).length, 0);

  const otherTenantsCheck = fakeDb({ checks: [{ claim_id: ORGLESS_CLAIM, tenant_id: OTHER_TENANT }] });
  assert.equal((await call(otherTenantsCheck, { _claim_id: ORGLESS_CLAIM })).error, 'claim_not_in_tenant');
  assert.equal(inserts(otherTenantsCheck).length, 0);

  const ownCheck = fakeDb({ checks: [{ claim_id: ORGLESS_CLAIM, tenant_id: TENANT }] });
  const result = await call(ownCheck, { _claim_id: ORGLESS_CLAIM });
  assert.ok(result.data);
  assert.equal(ownCheck.cases[0].tenant_id, TENANT);
  assert.equal(ownCheck.cases[0].insured_name, 'Orla');
});

test("existing-case lookup ignores other tenants' cases and never returns their id", async () => {
  // Another tenant already holds the global (freedom_crm, external_claim_id) slot.
  const ext = '44444444-4444-4444-8444-444444444444';
  const client = fakeDb({
    cases: [{ id: FOREIGN_CASE, tenant_id: OTHER_TENANT, external_system: 'freedom_crm', external_claim_id: ext }],
  });
  const result = await call(client, { _external_claim_id: ext });
  assert.notEqual(result.data, FOREIGN_CASE);
  assert.equal(result.error, 'check_case_conflict');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(FOREIGN_CASE));
  for (const q of client.queries.filter((x) => /SELECT id FROM public\.check_cases/.test(x.sql))) {
    assert.equal(q.params[0], TENANT);
  }
});

test("the same claim's own-tenant case is returned without inserting", async () => {
  const own = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const client = fakeDb({
    cases: [{ id: own, tenant_id: TENANT, external_system: 'freedom_crm', external_claim_id: OWN_CLAIM }],
  });
  const result = await call(client, { _claim_id: OWN_CLAIM });
  assert.equal(result.data, own);
  assert.equal(inserts(client).length, 0);
});

test('ON CONFLICT race with an own-tenant case returns that case', async () => {
  const own = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const client = fakeDb();
  const original = client.query;
  let raced = false;
  client.query = async (sql, params) => {
    if (!raced && /INSERT INTO public\.check_cases/.test(sql)) {
      raced = true;
      client.cases.push({ id: own, tenant_id: TENANT, external_system: 'freedom_crm', external_claim_id: OWN_CLAIM });
    }
    return original(sql, params);
  };
  const result = await call(client, { _claim_id: OWN_CLAIM });
  assert.equal(result.data, own);
});

for (const role of ['viewer', 'partner']) {
  test(`${role} role is refused`, async () => {
    const client = fakeDb({ memberships: [{ user_id: USER, tenant_id: TENANT, role }] });
    const result = await call(client, { _claim_id: OWN_CLAIM });
    assert.equal(result.error, 'not_authorized');
    assert.equal(inserts(client).length, 0);
    assert.equal(client.queries.some((q) => /FROM public\.claims/.test(q.sql)), false);
  });
}

for (const role of ['admin', 'staff']) {
  test(`global ${role} without a tenant membership is refused`, async () => {
    const client = fakeDb({ memberships: [], userRoles: [{ user_id: USER, role }] });
    const result = await call(client, { _claim_id: OWN_CLAIM });
    assert.equal(result.error, 'not_authorized');
    assert.equal(inserts(client).length, 0);
    assert.equal(client.queries.some((q) => /user_roles/.test(q.sql)), false);
  });
}

test('a member of another tenant only is refused', async () => {
  const client = fakeDb({ memberships: [{ user_id: USER, tenant_id: OTHER_TENANT, role: 'owner' }] });
  const result = await call(client, { _claim_id: OWN_CLAIM });
  assert.equal(result.error, 'not_authorized');
  assert.equal(inserts(client).length, 0);
});

for (const role of ['operator', 'OWNER', 'admin', 'manager']) {
  test(`${role} member is allowed`, async () => {
    const client = fakeDb({ memberships: [{ user_id: USER, tenant_id: TENANT, role }] });
    const result = await call(client, { _claim_id: OWN_CLAIM });
    assert.ok(result.data);
    assert.equal(result.error, undefined);
  });
}

test('claim-number path stays tenant-scoped and unchanged', async () => {
  const client = fakeDb();
  const first = await call(client, { _claim_number: 'N-77', _insured_name: 'Bob' });
  assert.ok(first.data);
  assert.equal(client.cases[0].external_system, 'checksops');
  const second = await call(client, { _claim_number: 'N-77' });
  assert.equal(second.data, first.data);
  assert.equal(inserts(client).length, 1);
});
