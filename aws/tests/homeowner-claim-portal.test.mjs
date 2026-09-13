import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { handleHomeownerClaimPortal } from '../functions/api/homeowner.mjs';

const TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LEAD_ID = '11111111-1111-4111-8111-111111111111';

const eventOf = (body = {}, headers = {}) => ({
  headers,
  body: JSON.stringify(body),
  requestContext: { http: { method: 'POST', path: '/functions/v1/homeowner-claim-portal' } },
});

const mockClient = (impl) => ({
  query: async (sql, params = []) => impl(String(sql), params || []),
  connect: async () => {},
  end: async () => {},
});

const sqlClient = (handlers) => mockClient((sql, params) => {
  const compact = sql.replace(/\s+/g, ' ');
  if (/^BEGIN|COMMIT|ROLLBACK|SET TRANSACTION|SAVEPOINT|RELEASE SAVEPOINT/i.test(compact.trim())) {
    return { rows: [], rowCount: 0 };
  }
  for (const handler of handlers) {
    if (handler.match(compact, params)) return handler.result(params, compact);
  }
  return { rows: [], rowCount: 0 };
});

const acceptedDoc = {
  ok: true,
  pending: false,
  lead: {
    id: LEAD_ID,
    status: 'accepted',
    accepted_at: '2026-09-13T00:00:00.000Z',
    homeowner_name: 'P2 Portal Fixture',
    homeowner_email: 'p2-portal@example.invalid',
    contractor_profile_id: '22222222-2222-4222-8222-222222222222',
    contractor_user_id: '33333333-3333-4333-8333-333333333333',
    dtp_signed_at: null,
  },
  contractor: { id: '22222222-2222-4222-8222-222222222222', display_name: 'C1C', user_id: '33333333-3333-4333-8333-333333333333' },
  uploads: [],
};

test('malformed claim-portal token is invalid body and ignores spoofed tenant', async () => {
  const result = await handleHomeownerClaimPortal(eventOf(
    { token: 'not-a-token', action: 'get', tenant_id: 'spoof' },
    { 'x-tenant-id': 'spoof' },
  ));
  assert.equal(result.statusCode, 400);
  assert.equal(result.error, 'invalid body');
  assert.equal(result.spoofFieldsIgnored.bodyTenantId, 'spoof');
  assert.equal(result.spoofFieldsIgnored.headerTenantId, 'spoof');
});

test('unknown claim-portal token is invalid or expired', async () => {
  const result = await handleHomeownerClaimPortal(eventOf({ token: TOKEN, action: 'get' }), {
    connect: async () => sqlClient([{
      match: (sql) => sql.includes('aws_public_homeowner_claim_by_token'),
      result: () => ({ rows: [{ doc: null }] }),
    }]),
  });
  assert.equal(result.statusCode, 404);
  assert.equal(result.error, 'invalid or expired link');
});

test('sign_dtp does not return signed true when the definer persists zero rows', async () => {
  const queries = [];
  const result = await handleHomeownerClaimPortal(eventOf({
    token: TOKEN,
    action: 'sign_dtp',
    signature_name: 'P2 Portal Fixture',
    insurance_carrier: 'P2 Synthetic Carrier',
    tenant_id: 'should-ignore',
  }), {
    connect: async () => sqlClient([
      {
        match: (sql) => sql.includes('aws_public_homeowner_claim_by_token'),
        result: () => ({ rows: [{ doc: acceptedDoc }] }),
      },
      {
        match: (sql, params) => {
          queries.push({ sql, params });
          return sql.includes('aws_public_homeowner_claim_sign_dtp');
        },
        result: () => ({ rows: [{ doc: { error: 'persist_failed' } }] }),
      },
    ]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 503);
  assert.equal(result.error, 'persist_failed');
  assert.equal(result.signed, undefined);
  assert.equal(queries.some((q) => String(q.sql).includes('UPDATE public.homeowner_intro_requests')), false);
  assert.equal(result.spoofFieldsIgnored.bodyTenantId, 'should-ignore');
});

test('sign_dtp succeeds only when definer returns signed and dtp_signed_at', async () => {
  const signedAt = '2026-09-13T03:00:00.000Z';
  const result = await handleHomeownerClaimPortal(eventOf({
    token: TOKEN,
    action: 'sign_dtp',
    signature_name: 'P2 Portal Fixture',
    insurance_carrier: 'P2 Synthetic Carrier',
    claim_number: 'P2-PORTAL-001',
  }), {
    connect: async () => sqlClient([
      {
        match: (sql) => sql.includes('aws_public_homeowner_claim_by_token'),
        result: () => ({ rows: [{ doc: acceptedDoc }] }),
      },
      {
        match: (sql, params) => {
          assert.equal(params[0], TOKEN);
          assert.equal(params[1], 'P2 Portal Fixture');
          assert.equal(params[2], 'P2 Synthetic Carrier');
          assert.equal(params[3], 'P2-PORTAL-001');
          return sql.includes('aws_public_homeowner_claim_sign_dtp');
        },
        result: () => ({ rows: [{ doc: {
          ok: true,
          signed: true,
          id: LEAD_ID,
          dtp_signed_at: signedAt,
          dtp_signature_name: 'P2 Portal Fixture',
        } }] }),
      },
    ]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.signed, true);
  assert.equal(result.dtp_signed_at, signedAt);
});

test('sign_dtp rejects a short signature name before writing', async () => {
  const result = await handleHomeownerClaimPortal(eventOf({
    token: TOKEN,
    action: 'sign_dtp',
    signature_name: 'A',
  }), {
    connect: async () => sqlClient([{
      match: (sql) => sql.includes('aws_public_homeowner_claim_by_token'),
      result: () => ({ rows: [{ doc: acceptedDoc }] }),
    }]),
  });
  assert.equal(result.statusCode, 400);
  assert.equal(result.error, 'missing_signature_name');
});

test('pending lead cannot sign_dtp', async () => {
  const result = await handleHomeownerClaimPortal(eventOf({
    token: TOKEN,
    action: 'sign_dtp',
    signature_name: 'P2 Portal Fixture',
  }), {
    connect: async () => sqlClient([{
      match: (sql) => sql.includes('aws_public_homeowner_claim_by_token'),
      result: () => ({ rows: [{ doc: { ...acceptedDoc, pending: true, lead: { ...acceptedDoc.lead, status: 'new', accepted_at: null } } }] }),
    }]),
  });
  assert.equal(result.statusCode, 403);
  assert.match(String(result.error), /not accepted/i);
});

test('SQL 42 is SECURITY DEFINER and executable only by checksops', () => {
  const sql = readFileSync(new URL('../write-path/sql/42_public_homeowner_claim_sign_dtp.sql', import.meta.url), 'utf8');
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.aws_public_homeowner_claim_sign_dtp/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.aws_public_homeowner_claim_sign_dtp[\s\S]*TO checksops/);
  assert.match(sql, /status = 'accepted'/);
  assert.match(sql, /RETURNING/);
  assert.equal(sql.includes('GRANT EXECUTE') && sql.includes('TO PUBLIC'), false);
});

test('claim portal handler no longer raw-updates DTP columns', () => {
  const src = readFileSync(new URL('../functions/api/homeowner.mjs', import.meta.url), 'utf8');
  assert.match(src, /aws_public_homeowner_claim_sign_dtp/);
  assert.equal(/UPDATE public\.homeowner_intro_requests SET\s+dtp_signed_at/s.test(src), false);
});

test('claim portal UI refuses to toast success unless GET shows dtp_signed_at', () => {
  const src = readFileSync(new URL('../../src/pages/HomeownerClaimPortal.tsx', import.meta.url), 'utf8');
  assert.match(src, /Signature did not persist/);
  assert.match(src, /dtp_signed_at/);
});
