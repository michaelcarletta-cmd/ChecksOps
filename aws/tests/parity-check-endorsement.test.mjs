import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import { CLASS_A_FUNCTIONS, handleAppServiceRequest } from '../functions/api/app-services.mjs';
import {
  denyDepositAdvance,
  evaluateEndorsementCompletion,
  endorsementRateLimited,
  handlePublicEndorsement,
  isContractorPayee,
  persistPhysicalEndorsementOnCheck,
  persistPayeeEndorsementState,
  runAuthenticatedEndorsement,
  runGetEndorsementData,
  runPublicEndorsement,
} from '../functions/api/check-endorsement.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const ENDORSE_ID = '44444444-4444-4444-8444-444444444444';
const PAYEE_ID = '55555555-5555-4555-8555-555555555555';
const ACTOR_ID = '66666666-6666-4666-8666-666666666666';

const eventOf = (body = {}, headers = {}) => ({
  headers,
  body: JSON.stringify(body),
  requestContext: { http: { method: 'POST', path: '/functions/v1/check-endorsement' } },
});

const mockClient = (impl) => ({
  query: async (sql, params = []) => impl(String(sql), params || []),
  connect: async () => {},
  end: async () => {},
});

const sqlClient = (handlers) => mockClient((sql, params) => {
  const compact = sql.replace(/\s+/g, ' ');
  if (/^BEGIN|COMMIT|ROLLBACK|SET TRANSACTION|SAVEPOINT|RELEASE SAVEPOINT/i.test(compact.trim())) return { rows: [], rowCount: 0 };
  for (const handler of handlers) {
    if (handler.match(compact, params)) return handler.result(params, compact);
  }
  return { rows: [], rowCount: 0 };
});

test('class A registry includes check-endorsement before provider_disabled', async () => {
  assert.ok(CLASS_A_FUNCTIONS.has('check-endorsement'));
  const result = await handleAppServiceRequest(eventOf({}), '/functions/v1/check-endorsement', 'POST');
  assert.notEqual(result.error, 'provider_disabled');
  assert.equal(result.statusCode, 400);
  assert.equal(result.error, 'Token required');
});

test('completion evaluation never advances deposit', () => {
  const done = evaluateEndorsementCompletion([
    { status: 'signed', payee_type: 'insured' },
    { status: 'waived', payee_type: 'mortgage_company' },
  ]);
  assert.equal(done.allSigned, true);
  assert.equal(done.depositAdvanceDenied, true);
  assert.equal(done.advance_check_on_endorsement_complete, 'denied');
  assert.equal(done.readyForDeposit, false);
  assert.equal(done.approvedForDeposit, false);
  assert.equal(denyDepositAdvance().paymentDirectionTriggered, false);
});

test('contractor payees are CC-only and send is rate-limited', () => {
  assert.equal(isContractorPayee('contractor'), true);
  assert.equal(endorsementRateLimited(new Date().toISOString()), true);
  assert.equal(endorsementRateLimited(new Date(Date.now() - 6 * 60 * 1000).toISOString()), false);
});

test('public get and abuse cases ignore spoofed tenant headers', async () => {
  const missing = await handlePublicEndorsement(eventOf({ action: 'get_endorsement_data' }, { 'x-tenant-id': TENANT_B }));
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.spoofFieldsIgnored.headerTenantId, TENANT_B);

  const client = sqlClient([{
    match: (sql) => sql.includes('aws_public_endorsement_by_token'),
    result: () => ({ rows: [{ doc: null }] }),
  }]);
  const bad = await runPublicEndorsement(eventOf({ action: 'get_endorsement_data', token: 'nope' }), { client });
  assert.equal(bad.statusCode, 404);
  assert.equal(bad.code, 'invalid_link');
  assert.match(bad.error, /invalid or has expired/i);
  assert.equal(/already been used/i.test(bad.error), false);

  const submitUnknown = await runPublicEndorsement(eventOf({
    action: 'submit_endorsement',
    token: 'nope',
    eSignConsentAccepted: true,
    signatureData: 'typed:X',
  }), { client: sqlClient([]) });
  assert.equal(submitUnknown.statusCode, 404);
  assert.equal(submitUnknown.code, 'invalid_link');
  assert.match(submitUnknown.error, /invalid or has expired/i);
  assert.equal(/already-used|already been used/i.test(submitUnknown.error), false);

  const rejectUnknown = await runPublicEndorsement(eventOf({
    action: 'reject_endorsement',
    token: 'nope',
  }), { client: sqlClient([]) });
  assert.equal(rejectUnknown.statusCode, 404);
  assert.equal(rejectUnknown.code, 'invalid_link');
  assert.equal(/already-used|already been used/i.test(rejectUnknown.error), false);

  const signedGet = await runPublicEndorsement(eventOf({ action: 'get_endorsement_data', token: 'used' }), {
    client: sqlClient([{
      match: (sql) => sql.includes('aws_public_endorsement_by_token'),
      result: () => ({
        rows: [{
          doc: {
            id: ENDORSE_ID,
            status: 'signed',
            token: 'used',
            payee_name: 'Jane',
          },
        }],
      }),
    }]),
  });
  assert.equal(signedGet.statusCode, 404);
  assert.equal(signedGet.code, 'token_consumed');

  const getSql = [];
  const txnClient = mockClient(async (sql, params = []) => {
    getSql.push(String(sql).replace(/\s+/g, ' ').trim());
    const compact = String(sql).replace(/\s+/g, ' ');
    if (/^BEGIN|COMMIT|ROLLBACK|SET TRANSACTION|SAVEPOINT|RELEASE SAVEPOINT/i.test(compact.trim())) {
      return { rows: [], rowCount: 0 };
    }
    if (compact.includes('aws_public_endorsement_by_token')) {
      return {
        rows: [{
          doc: {
            id: ENDORSE_ID,
            status: 'sent',
            token: 'fresh',
            payee_name: 'Jane',
            carrier_name: 'Acme',
            check_number: '1001',
            amount: 12.34,
          },
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  const freshGet = await runPublicEndorsement(eventOf({ action: 'get_endorsement_data', token: 'fresh' }), { client: txnClient });
  assert.equal(freshGet.statusCode, 200);
  assert.equal(freshGet.payee_name, 'Jane');
  assert.equal(getSql[0], 'BEGIN');
  assert.equal(getSql[1], 'SET TRANSACTION READ ONLY');
  assert.ok(getSql.includes('COMMIT'));
  assert.ok(getSql.some((sql) => sql.includes('aws_public_endorsement_by_token')));

  const unusedPayee = await runGetEndorsementData(sqlClient([
    { match: (sql) => sql.includes('aws_public_endorsement_by_token'), result: () => ({ rows: [{ doc: null }] }) },
    {
      match: (sql) => sql.includes('FROM public.check_payees p'),
      result: () => ({ rows: [{
        id: PAYEE_ID,
        check_id: CHECK_ID,
        payee_name: 'Unused Payee',
        endorsement_status: 'pending',
        endorsement_token: 'unused-payee-token',
        carrier_name: 'Acme',
        check_number: '1001',
        amount: 10,
        tenant_id: TENANT_A,
      }] }),
    },
  ]), 'unused-payee-token', {});
  assert.equal(unusedPayee.ok, true);
  assert.equal(unusedPayee.payee_name, 'Unused Payee');
  assert.equal(unusedPayee.status, 'pending');
});

test('public submit requires consent and does not advance deposit', async () => {
  const noConsent = await runPublicEndorsement(eventOf({
    action: 'submit_endorsement',
    token: 'tok',
    eSignConsentAccepted: false,
  }), {
    client: sqlClient([]),
  });
  assert.equal(noConsent.statusCode, 400);
  assert.match(noConsent.error, /consent/i);

  const endorsement = {
    id: ENDORSE_ID,
    check_id: CHECK_ID,
    tenant_id: TENANT_A,
    payee_id: null,
    payee_name: 'Jane Doe',
    contact_email: 'jane@example.com',
    status: 'sent',
    token: 'tok',
  };
  const updates = [];
  const client = sqlClient([
    {
      match: (sql) => sql.includes('aws_public_endorsement_by_token'),
      result: () => ({
        rows: [{
          doc: {
            id: ENDORSE_ID,
            status: 'sent',
            token: 'tok',
            payee_name: 'Jane Doe',
            check_id: CHECK_ID,
            tenant_id: TENANT_A,
          },
        }],
      }),
    },
    {
      match: (sql) => sql.includes('aws_public_submit_endorsement'),
      result: () => ({
        rows: [{
          doc: {
            ok: true,
            already_signed: false,
            id: ENDORSE_ID,
            check_id: CHECK_ID,
            tenant_id: TENANT_A,
            payee_id: null,
            payee_name: 'Jane Doe',
            contact_email: 'jane@example.com',
            status: 'signed',
            token: 'rotated',
            payee_status: null,
          },
        }],
      }),
    },
    {
      match: (sql) => sql.includes("SET status = 'signed'") || sql.includes('UPDATE public.check_payees'),
      result: (_params, sql) => {
        updates.push(sql);
        return { rows: [], rowCount: 1 };
      },
    },
    {
      match: (sql) => sql.includes('SELECT status, payee_type'),
      result: () => ({ rows: [{ status: 'signed', payee_type: 'insured' }] }),
    },
  ]);
  const submitted = await runPublicEndorsement(eventOf({
    action: 'submit_endorsement',
    token: 'tok',
    eSignConsentAccepted: true,
    signatureData: 'data:image/png;base64,aaa',
  }, { 'x-tenant-id': TENANT_B }), { client });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.allSigned, true);
  assert.equal(submitted.depositAdvanceDenied, true);
  assert.equal(submitted.advance_check_on_endorsement_complete, 'denied');
  assert.equal(submitted.spoofFieldsIgnored.headerTenantId, TENANT_B);
  assert.equal(updates.some((sql) => /ready_for_deposit|approved_for_deposit/.test(sql)), false);
});

test('public submit does not depend on a second payee UPDATE when SQL 73 signed the payee', async () => {
  const updates = [];
  const client = sqlClient([
    {
      match: (sql) => sql.includes('aws_public_endorsement_by_token'),
      result: () => ({
        rows: [{
          doc: {
            id: ENDORSE_ID,
            status: 'sent',
            token: 'tok',
            payee_name: 'Jane Doe',
            check_id: CHECK_ID,
            tenant_id: TENANT_A,
            payee_id: PAYEE_ID,
          },
        }],
      }),
    },
    {
      match: (sql) => sql.includes('aws_public_submit_endorsement'),
      result: () => ({
        rows: [{
          doc: {
            ok: true,
            already_signed: false,
            id: ENDORSE_ID,
            check_id: CHECK_ID,
            tenant_id: TENANT_A,
            payee_id: PAYEE_ID,
            payee_name: 'Jane Doe',
            contact_email: 'jane@example.com',
            status: 'signed',
            token: 'rotated',
            payee_status: 'signed',
          },
        }],
      }),
    },
    {
      match: (sql) => sql.includes('UPDATE public.check_payees'),
      result: (_params, sql) => {
        updates.push(sql);
        return { rows: [{ id: PAYEE_ID, endorsement_status: 'signed' }], rowCount: 1 };
      },
    },
    {
      match: (sql) => sql.includes('SELECT status, payee_type'),
      result: () => ({ rows: [{ status: 'signed', payee_type: 'insured' }] }),
    },
  ]);
  const submitted = await runPublicEndorsement(eventOf({
    action: 'submit_endorsement',
    token: 'tok',
    eSignConsentAccepted: true,
    signatureData: 'data:image/png;base64,aaa',
  }), { client });
  assert.equal(submitted.ok, true);
  assert.equal(updates.some((sql) => sql.includes('UPDATE public.check_payees')), false);
});

test('public submit fails closed when payee_id is present and RPC did not sign the payee', async () => {
  const result = await runPublicEndorsement(eventOf({
    action: 'submit_endorsement',
    token: 'tok',
    eSignConsentAccepted: true,
    signatureData: 'data:image/png;base64,aaa',
  }), {
    client: sqlClient([
      {
        match: (sql) => sql.includes('aws_public_endorsement_by_token'),
        result: () => ({
          rows: [{
            doc: {
              id: ENDORSE_ID,
              status: 'sent',
              token: 'tok',
              payee_name: 'Jane Doe',
              check_id: CHECK_ID,
              tenant_id: TENANT_A,
              payee_id: PAYEE_ID,
            },
          }],
        }),
      },
      {
        match: (sql) => sql.includes('aws_public_submit_endorsement'),
      result: () => ({
        rows: [{
          doc: {
            ok: true,
            already_signed: false,
            id: ENDORSE_ID,
            check_id: CHECK_ID,
            tenant_id: TENANT_A,
            payee_id: PAYEE_ID,
            payee_name: 'Jane Doe',
            status: 'signed',
            token: 'rotated',
          },
        }],
      }),
    }]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'payee_persist_failed');
});

test('public submit denies invalid tokens and check mismatch', async () => {
  const missing = await runPublicEndorsement(eventOf({
    action: 'submit_endorsement',
    token: 'nope',
    eSignConsentAccepted: true,
    signatureData: 'data:image/png;base64,aaa',
  }), {
    client: sqlClient([{
      match: (sql) => sql.includes('aws_public_endorsement_by_token'),
      result: () => ({ rows: [{ doc: null }] }),
    }]),
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.code, 'invalid_link');
  assert.match(missing.error, /invalid or has expired/i);
  assert.equal(/already-used|already been used/i.test(missing.error), false);

  const mismatch = await runPublicEndorsement(eventOf({
    action: 'submit_endorsement',
    token: 'tok',
    checkId: CHECK_ID,
    eSignConsentAccepted: true,
    signatureData: 'data:image/png;base64,aaa',
  }), {
    client: sqlClient([
      {
        match: (sql) => sql.includes('aws_public_endorsement_by_token'),
        result: () => ({
          rows: [{
            doc: {
              id: ENDORSE_ID,
              status: 'sent',
              token: 'tok',
              payee_name: 'Jane',
              check_id: CHECK_ID,
            },
          }],
        }),
      },
      {
        match: (sql) => sql.includes('aws_public_submit_endorsement'),
        result: () => ({ rows: [{ doc: { ok: false, error: 'check_mismatch', statusCode: 403 } }] }),
      },
    ]),
  });
  assert.equal(mismatch.statusCode, 403);
  assert.equal(mismatch.code, 'check_mismatch');
});

test('already-signed public submit is idempotent', async () => {
  const client = sqlClient([
    {
      match: (sql) => sql.includes('aws_public_endorsement_by_token'),
      result: () => ({
        rows: [{
          doc: {
            id: ENDORSE_ID,
            status: 'signed',
            token: 'tok',
            check_id: CHECK_ID,
          },
        }],
      }),
    },
    {
      match: (sql) => sql.includes('aws_public_submit_endorsement'),
      result: () => ({
        rows: [{
          doc: {
            ok: true,
            already_signed: true,
            id: ENDORSE_ID,
            status: 'signed',
            token: 'tok',
            check_id: CHECK_ID,
          },
        }],
      }),
    },
  ]);
  const result = await runPublicEndorsement(eventOf({
    action: 'submit_endorsement',
    token: 'tok',
    eSignConsentAccepted: true,
  }), { client });
  assert.equal(result.statusCode, 200);
  assert.equal(result.message, 'Already endorsed');
  assert.equal(result.depositAdvanceDenied, true);
});

test('authenticated send is tenant-isolated and contractor blocked', async () => {
  const endorsement = {
    id: ENDORSE_ID,
    check_id: CHECK_ID,
    tenant_id: TENANT_A,
    payee_type: 'insured',
    payee_name: 'Jane',
    contact_email: 'jane@example.com',
    token: 'abc',
    request_sent_at: null,
  };
  const denied = await runAuthenticatedEndorsement({
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.check_endorsements WHERE id'),
        result: () => ({ rows: [endorsement] }),
      },
      {
        match: (sql) => sql.includes('FROM public.check_intake_items'),
        result: () => ({ rows: [{ id: CHECK_ID, tenant_id: TENANT_A }] }),
      },
      {
        match: (sql) => sql.includes('aws_can_write_tenant'),
        result: () => ({ rows: [{ ok: false }] }),
      },
    ]),
    mapping: { application_user_id: '55555555-5555-4555-8555-555555555555' },
    body: { action: 'send_endorsement_request', endorsementId: ENDORSE_ID },
    spoof: { ignored: true, headerTenantId: TENANT_B },
    event: eventOf({}),
  });
  assert.equal(denied.statusCode, 403);

  const contractor = await runAuthenticatedEndorsement({
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.check_endorsements WHERE id'),
        result: () => ({ rows: [{ ...endorsement, payee_type: 'contractor' }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.check_intake_items'),
        result: () => ({ rows: [{ id: CHECK_ID, tenant_id: TENANT_A }] }),
      },
      {
        match: (sql) => sql.includes('aws_can_write_tenant'),
        result: () => ({ rows: [{ ok: true }] }),
      },
    ]),
    mapping: { application_user_id: '55555555-5555-4555-8555-555555555555' },
    body: { action: 'send_endorsement_request', endorsementId: ENDORSE_ID },
    spoof: { ignored: true },
    event: eventOf({}),
  });
  assert.equal(contractor.statusCode, 400);
  assert.equal(contractor.code, 'contractor_cc_only');
});

test('in-person sign requires image consent and stays fail-closed on deposit', async () => {
  const endorsement = {
    id: ENDORSE_ID,
    check_id: CHECK_ID,
    tenant_id: TENANT_A,
    payee_name: 'Jane',
    payee_id: null,
  };
  const missing = await runAuthenticatedEndorsement({
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.check_endorsements WHERE id'),
        result: () => ({ rows: [endorsement] }),
      },
      {
        match: (sql) => sql.includes('FROM public.check_intake_items'),
        result: () => ({ rows: [{ id: CHECK_ID, tenant_id: TENANT_A }] }),
      },
      {
        match: (sql) => sql.includes('aws_can_write_tenant'),
        result: () => ({ rows: [{ ok: true }] }),
      },
    ]),
    mapping: { application_user_id: '55555555-5555-4555-8555-555555555555' },
    body: { action: 'sign_in_person', endorsementId: ENDORSE_ID, signatureData: 'typed:Jane' },
    spoof: { ignored: true },
    event: eventOf({}),
  });
  assert.equal(missing.statusCode, 400);

  const signed = await runAuthenticatedEndorsement({
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.check_endorsements WHERE id'),
        result: () => ({ rows: [endorsement] }),
      },
      {
        match: (sql) => sql.includes('FROM public.check_intake_items'),
        result: () => ({ rows: [{ id: CHECK_ID, tenant_id: TENANT_A }] }),
      },
      {
        match: (sql) => sql.includes('aws_can_write_tenant'),
        result: () => ({ rows: [{ ok: true }] }),
      },
      {
        match: (sql) => sql.includes('SELECT status, payee_type'),
        result: () => ({ rows: [{ status: 'signed', payee_type: 'insured' }] }),
      },
    ]),
    mapping: { application_user_id: '55555555-5555-4555-8555-555555555555' },
    body: {
      action: 'sign_in_person',
      endorsementId: ENDORSE_ID,
      signatureData: 'data:image/png;base64,aaa',
      eSignConsentAccepted: true,
    },
    spoof: { ignored: true },
    event: eventOf({}),
  });
  assert.equal(signed.ok, true);
  assert.equal(signed.depositAdvanceDenied, true);
});

test('public endorsement route is no longer writes_disabled', async () => {
  const result = await handler({
    requestContext: { http: { method: 'POST', path: '/public/endorsement' } },
    body: JSON.stringify({ action: 'submit_endorsement', token: 'x' }),
  });
  assert.notEqual(result.statusCode, 403);
  const body = JSON.parse(result.body);
  assert.notEqual(body.error, 'writes_disabled');
});

const physicalEndorsement = {
  id: ENDORSE_ID,
  check_id: CHECK_ID,
  tenant_id: TENANT_A,
  payee_id: PAYEE_ID,
  payee_name: 'BCV Synthetic Insured',
  payee_type: 'insured',
  status: 'pending',
  token: 'live-token',
};

const physicalAuthzHandlers = [
  {
    match: (sql) => sql.includes('FROM public.check_endorsements WHERE id'),
    result: () => ({ rows: [physicalEndorsement] }),
  },
  {
    match: (sql) => sql.includes('FROM public.check_intake_items'),
    result: () => ({ rows: [{ id: CHECK_ID, tenant_id: TENANT_A }] }),
  },
  {
    match: (sql) => sql.includes('aws_can_write_tenant'),
    result: () => ({ rows: [{ ok: true }] }),
  },
];

test('waive_endorsement persists endorsement and payee atomically as manual physical-on-check', async () => {
  const updates = [];
  const client = sqlClient([
    ...physicalAuthzHandlers,
    {
      match: (sql) => sql.includes("signature_method = 'manual'"),
      result: (_params, sql) => {
        updates.push({ table: 'check_endorsements', sql });
        return { rows: [{ ...physicalEndorsement, status: 'signed', signature_method: 'manual' }], rowCount: 1 };
      },
    },
    {
      match: (sql) => sql.includes('SET endorsement_status') && sql.includes('WHERE id'),
      result: (_params, sql) => {
        updates.push({ table: 'check_payees', sql });
        return { rows: [{ id: PAYEE_ID, endorsement_status: 'signed', endorsement_token: 'live-token' }], rowCount: 1 };
      },
    },
    {
      match: (sql) => sql.includes('SELECT e.status AS endorsement_status'),
      result: () => ({
        rows: [{
          endorsement_status: 'signed',
          signature_method: 'manual',
          payee_status: 'signed',
          endorsement_token: 'live-token',
        }],
        rowCount: 1,
      }),
    },
    {
      match: (sql) => sql.includes('SELECT status, payee_type'),
      result: () => ({ rows: [{ status: 'signed', payee_type: 'insured' }] }),
    },
  ]);
  const result = await runAuthenticatedEndorsement({
    client,
    mapping: { application_user_id: ACTOR_ID },
    body: { action: 'waive_endorsement', endorsementId: ENDORSE_ID },
    spoof: { ignored: true },
    event: eventOf({}),
  });
  assert.equal(result.ok, true);
  assert.equal(result.success, true);
  assert.equal(result.endorsement_status, 'signed');
  assert.equal(result.payee_status, 'signed');
  assert.equal(result.signature_method, 'manual');
  assert.equal(result.token_rotated, false);
  assert.equal(result.depositAdvanceDenied, true);
  assert.equal(updates.some((row) => row.table === 'check_endorsements'), true);
  assert.equal(updates.some((row) => row.table === 'check_payees'), true);
  assert.equal(updates.some((row) => /endorsement_token\s*=/.test(row.sql)), false);
});

test('waive_endorsement fails closed when payee persist misses and does not report success', async () => {
  const client = sqlClient([
    ...physicalAuthzHandlers,
    {
      match: (sql) => sql.includes("signature_method = 'manual'"),
      result: () => ({
        rows: [{ ...physicalEndorsement, status: 'signed', signature_method: 'manual' }],
        rowCount: 1,
      }),
    },
    {
      match: (sql) => sql.includes('SET endorsement_status') && sql.includes('WHERE id'),
      result: () => ({ rows: [], rowCount: 0 }),
    },
  ]);
  const result = await runAuthenticatedEndorsement({
    client,
    mapping: { application_user_id: ACTOR_ID },
    body: { action: 'waive_endorsement', endorsementId: ENDORSE_ID },
    spoof: { ignored: true },
    event: eventOf({}),
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'payee_persist_failed');
  assert.notEqual(result.success, true);
});

test('persistPhysicalEndorsementOnCheck does not rotate a live public token', async () => {
  const payee = await persistPayeeEndorsementState(
    sqlClient([{
      match: (sql) => sql.includes('SET endorsement_status'),
      result: (_params, sql) => {
        assert.equal(/endorsement_token\s*=/.test(sql), false);
        return { rows: [{ id: PAYEE_ID, endorsement_status: 'signed', endorsement_token: 'live-token' }], rowCount: 1 };
      },
    }]),
    physicalEndorsement,
    { status: 'signed', signedAt: new Date().toISOString(), rotateToken: false },
  );
  assert.equal(payee.ok, true);
  assert.equal(payee.data.endorsement_token, 'live-token');

  const failed = await persistPhysicalEndorsementOnCheck(sqlClient([
    {
      match: (sql) => sql.includes("signature_method = 'manual'"),
      result: () => ({ rows: [{ ...physicalEndorsement, status: 'signed' }], rowCount: 1 }),
    },
    {
      match: (sql) => sql.includes('SET endorsement_status'),
      result: () => ({ rows: [], rowCount: 0 }),
    },
  ]), {
    endorsement: physicalEndorsement,
    mapping: { application_user_id: ACTOR_ID },
    spoof: { ignored: true },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.statusCode, 409);
});
