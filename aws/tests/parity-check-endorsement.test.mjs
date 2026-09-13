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
  runAuthenticatedEndorsement,
  runPublicEndorsement,
} from '../functions/api/check-endorsement.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const ENDORSE_ID = '44444444-4444-4444-8444-444444444444';

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
  if (/^BEGIN|COMMIT|ROLLBACK|SET TRANSACTION/i.test(compact.trim())) return { rows: [], rowCount: 0 };
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
  assert.equal(bad.code, 'token_consumed');

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

test('public submit denies invalid tokens and check mismatch', async () => {
  const missing = await runPublicEndorsement(eventOf({
    action: 'submit_endorsement',
    token: 'nope',
    eSignConsentAccepted: true,
    signatureData: 'data:image/png;base64,aaa',
  }), {
    client: sqlClient([{
      match: (sql) => sql.includes('aws_public_submit_endorsement'),
      result: () => ({ rows: [{ doc: { ok: false, error: 'invalid_or_used_token', statusCode: 404 } }] }),
    }]),
  });
  assert.equal(missing.statusCode, 404);
  assert.match(missing.error, /already-used token/i);

  const mismatch = await runPublicEndorsement(eventOf({
    action: 'submit_endorsement',
    token: 'tok',
    checkId: CHECK_ID,
    eSignConsentAccepted: true,
    signatureData: 'data:image/png;base64,aaa',
  }), {
    client: sqlClient([{
      match: (sql) => sql.includes('aws_public_submit_endorsement'),
      result: () => ({ rows: [{ doc: { ok: false, error: 'check_mismatch', statusCode: 403 } }] }),
    }]),
  });
  assert.equal(mismatch.statusCode, 403);
  assert.equal(mismatch.code, 'check_mismatch');
});

test('already-signed public submit is idempotent', async () => {
  const client = sqlClient([{
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
  }]);
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
