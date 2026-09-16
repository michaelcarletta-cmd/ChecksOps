import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluateEndorsementCompletion,
  runAuthenticatedEndorsement,
  runPublicEndorsement,
} from '../functions/api/check-endorsement.mjs';
import {
  endorsementAutoAdvanceEnabled,
  endorsementFromAddress,
  endorsementResendEnabled,
  isSuccessfulEndorsementDelivery,
  loadResendApiKey,
  PLATFORM_ENDORSEMENT_FROM,
  resendFromAddress,
  sendViaResend,
} from '../functions/api/endorsement-parity.mjs';
import { evaluateTransition, TRANSITIONS } from '../functions/api/workflow-transitions.mjs';
import { syntheticCompliantCheckAltJpeg } from '../functions/api/providers/production/checkalt-image-compliance.mjs';

const succeedingCompositeDeps = () => {
  const original = syntheticCompliantCheckAltJpeg({ seed: 41, quality: 78 });
  const files = new Map([[`checks/${CHECK_ID}/back-original.jpg`, original]]);
  return {
    downloadClaimFile: async (rel) => files.get(rel) || original,
    uploadClaimFile: async (rel, bytes) => {
      files.set(rel, Buffer.from(bytes));
      return { path: rel };
    },
    loadDeposits: async () => [],
  };
};

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const ENDORSE_A = '44444444-4444-4444-8444-444444444444';
const ENDORSE_B = '55555555-5555-4555-8555-555555555555';
const USER_ID = '66666666-6666-4666-8666-666666666666';
const TEST_TO = 'checksops-tester@freedomadj.com';

const eventOf = (body = {}) => ({
  headers: {},
  body: JSON.stringify(body),
  requestContext: { http: { method: 'POST', path: '/functions/v1/check-endorsement' } },
});

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const mockClient = (impl) => ({
  query: async (sql, params = []) => impl(String(sql), params || []),
  connect: async () => {},
  end: async () => {},
});

const sqlClient = (handlers, captured = []) => mockClient((sql, params) => {
  const compact = sql.replace(/\s+/g, ' ');
  captured.push({ sql: compact, params });
  if (/^BEGIN|COMMIT|ROLLBACK|SET TRANSACTION/i.test(compact.trim())) return { rows: [], rowCount: 0 };
  for (const handler of handlers) {
    if (handler.match(compact, params)) return handler.result(params, compact);
  }
  return { rows: [], rowCount: 0 };
});

test('parity flags default off so production stays inactive until activation', () => {
  delete process.env.AWS_ENDORSEMENT_RESEND_ENABLED;
  delete process.env.AWS_ENDORSEMENT_AUTO_ADVANCE;
  assert.equal(endorsementResendEnabled(), false);
  assert.equal(endorsementAutoAdvanceEnabled(), false);
  const done = evaluateEndorsementCompletion([
    { status: 'signed', payee_type: 'insured' },
    { status: 'waived', payee_type: 'mortgage_company' },
    { status: 'manual_required', payee_type: 'mortgage_company' },
  ]);
  assert.equal(done.allSigned, true);
  assert.equal(done.depositAdvanceDenied, true);
});

test('Resend mailer fail-closes and never treats sink as delivered', async () => {
  await withEnv({
    AWS_ENDORSEMENT_RESEND_ENABLED: 'true',
    RESEND_API_KEY: 're_test_not_real',
  }, async () => {
    await assert.rejects(
      () => sendViaResend({
        to: TEST_TO,
        subject: 'x',
        html: '<p>x</p>',
        fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ message: 'invalid_api_key' }) }),
      }),
      /invalid_api_key/,
    );
    await assert.rejects(
      () => sendViaResend({
        to: 'payee@example.net',
        subject: 'x',
        html: '<p>x</p>',
        apiKey: 're_test_not_real',
        fetchImpl: async () => ({ ok: true, json: async () => ({ id: 'should-not-send' }) }),
      }),
      /endorsement_recipient_not_allowlisted/,
    );
    const sent = await sendViaResend({
      to: TEST_TO,
      subject: 'Endorsement Required — Check #PARITY-1 — Insured A',
      html: '<a href="https://checksops.com/endorse?token=tok-a">endorse</a>',
      text: 'https://checksops.com/endorse?token=tok-a',
      from: PLATFORM_ENDORSEMENT_FROM,
      headers: { 'X-Entity-Ref-ID': ENDORSE_A },
      fetchImpl: async (url, init) => {
        assert.equal(url, 'https://api.resend.com/emails');
        assert.match(String(init.headers.Authorization || ''), /^Bearer /);
        const payload = JSON.parse(init.body);
        assert.equal(payload.to[0], TEST_TO);
        assert.match(payload.html, /https:\/\/checksops\.com\/endorse\?token=tok-a/);
        assert.doesNotMatch(url, /supabase|lovable|amazonaws\.com\/ses/i);
        return { ok: true, json: async () => ({ id: 're_msg_test' }) };
      },
    });
    assert.equal(sent.mode, 'resend');
    assert.equal(sent.deliveredCount, 1);
    assert.equal(isSuccessfulEndorsementDelivery(sent), true);
    assert.equal(isSuccessfulEndorsementDelivery({ mode: 'sink', deliveredCount: 0 }), false);
    assert.equal(isSuccessfulEndorsementDelivery({ mode: 'resend', deliveredCount: 0 }), false);
  });
});

test('endorsement sender reuses tenant branding and ChecksOps fallback', async () => {
  assert.equal(PLATFORM_ENDORSEMENT_FROM, 'ChecksOps <notify@checksops.com>');
  assert.equal(endorsementFromAddress({}), PLATFORM_ENDORSEMENT_FROM);
  assert.equal(endorsementFromAddress({ usingCustomFrom: false, from: 'Acme <office@acme.test>' }), PLATFORM_ENDORSEMENT_FROM);
  assert.equal(
    endorsementFromAddress({ usingCustomFrom: true, from: 'Freedom Adjustment <notify@freedomadj.com>' }),
    'Freedom Adjustment <notify@freedomadj.com>',
  );
  await withEnv({ RESEND_FROM_EMAIL: 'Freedom Claims <claims@freedomclaims.work>' }, () => {
    assert.equal(endorsementFromAddress({ usingCustomFrom: false }), PLATFORM_ENDORSEMENT_FROM);
    assert.doesNotMatch(endorsementFromAddress({}), /freedomclaims\.work/i);
    assert.equal(resendFromAddress(''), PLATFORM_ENDORSEMENT_FROM);
    assert.equal(resendFromAddress('Freedom Adjustment <notify@freedomadj.com>'), 'Freedom Adjustment <notify@freedomadj.com>');
  });
});

test('loadResendApiKey uses env or secret names without exposing values', async () => {
  await withEnv({ RESEND_API_KEY: 're_env_value_not_for_logs' }, async () => {
    const key = await loadResendApiKey(async () => ({ RESEND_API_KEY: 're_secret_value_not_for_logs' }));
    assert.equal(Boolean(key), true);
    assert.equal(typeof key, 'string');
  });
  await withEnv({ RESEND_API_KEY: undefined }, async () => {
    const key = await loadResendApiKey(async () => ({ RESEND_API_KEY: 're_secret_value_not_for_logs' }));
    assert.equal(Boolean(key), true);
  });
  await withEnv({ RESEND_API_KEY: undefined }, async () => {
    const key = await loadResendApiKey(async () => ({}));
    assert.equal(key, null);
  });
});

test('send failure is persisted as failed and not sent/delivered', async () => {
  const captured = [];
  const endorsement = {
    id: ENDORSE_A,
    check_id: CHECK_ID,
    tenant_id: TENANT_A,
    payee_type: 'insured',
    payee_name: 'Insured A',
    contact_email: TEST_TO,
    token: 'tok-a',
    request_sent_at: null,
    payee_id: null,
  };
  const result = await runAuthenticatedEndorsement({
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.check_endorsements WHERE id'),
        result: () => ({ rows: [endorsement] }),
      },
      {
        match: (sql) => sql.includes('FROM public.check_intake_items'),
        result: () => ({ rows: [{ id: CHECK_ID, tenant_id: TENANT_A, check_number: 'PARITY-1' }] }),
      },
      {
        match: (sql) => sql.includes('aws_can_write_tenant'),
        result: () => ({ rows: [{ ok: true }] }),
      },
    ], captured),
    mapping: { application_user_id: USER_ID },
    body: { action: 'send_endorsement_request', endorsementId: ENDORSE_A, email: TEST_TO },
    spoof: { ignored: true },
    event: eventOf({}),
    send: async () => {
      throw new Error('resend_unavailable');
    },
  });
  assert.equal(result.statusCode, 502);
  assert.equal(result.emailSent, false);
  assert.equal(result.delivery_status, 'failed');
  assert.equal(captured.some((row) => row.sql.includes('endorsement_requests') && row.sql.includes("'failed'")), true);
  assert.equal(captured.some((row) => row.sql.includes("SET status = 'sent'")), false);
  assert.equal(captured.some((row) => row.params.includes('delivered')), false);
  assert.equal(captured.some((row) => /checkalt|moov|supabase\.co/i.test(row.sql)), false);
});

test('isolated lifecycle: Resend URL, partial stays Endorsing, final becomes Ready', async () => {
  await withEnv({
    AWS_ENDORSEMENT_RESEND_ENABLED: 'true',
    AWS_ENDORSEMENT_AUTO_ADVANCE: 'true',
    AWS_ENDORSEMENT_RESEND_ALLOW_ANY_RECIPIENT: undefined,
    RESEND_API_KEY: 're_test_not_real',
    SIGN_BASE_URL: 'https://checksops.com',
    APP_PUBLIC_URL: 'https://checksops.com',
  }, async () => {
    const check = {
      id: CHECK_ID,
      tenant_id: TENANT_A,
      check_number: 'PARITY-1',
      carrier_name: 'Test Carrier',
      amount: 250,
      status: 'endorsements_in_progress',
      deposit_recommendation: null,
      check_stage: 'endorsing',
      deposited_at: null,
      back_image_path: `checks/${CHECK_ID}/back-original.jpg`,
      back_image_original_path: `checks/${CHECK_ID}/back-original.jpg`,
      back_image_deposit_path: null,
    };
    const compositeDeps = succeedingCompositeDeps();
    const rows = [
      {
        id: ENDORSE_A,
        check_id: CHECK_ID,
        tenant_id: TENANT_A,
        payee_name: 'Insured A',
        payee_type: 'insured',
        status: 'sent',
        token: 'tok-a',
        contact_email: TEST_TO,
        request_sent_at: null,
        payee_id: null,
      },
      {
        id: ENDORSE_B,
        check_id: CHECK_ID,
        tenant_id: TENANT_A,
        payee_name: 'Insured B',
        payee_type: 'insured',
        status: 'sent',
        token: 'tok-b',
        contact_email: TEST_TO,
        request_sent_at: null,
        payee_id: null,
      },
    ];
    const captured = [];
    const audits = [];
    const resendCalls = [];
    const clientFor = () => sqlClient([
      {
        match: (sql) => sql.includes('FROM public.check_endorsements WHERE id'),
        result: (params) => ({ rows: rows.filter((row) => row.id === params[0]) }),
      },
      {
        match: (sql) => sql.includes('FROM public.check_endorsements WHERE token'),
        result: (params) => ({ rows: rows.filter((row) => row.token === params[0]) }),
      },
      {
        match: (sql) => sql.includes('SELECT status, payee_type'),
        result: () => ({ rows: rows.map((row) => ({ status: row.status, payee_type: row.payee_type })) }),
      },
      {
        match: (sql) => sql.includes('FROM public.check_intake_items'),
        result: () => ({ rows: [{ ...check }] }),
      },
      {
        match: (sql) => sql.includes('aws_can_write_tenant'),
        result: () => ({ rows: [{ ok: true }] }),
      },
      {
        match: (sql) => sql.includes("SET status = 'signed'"),
        result: (params) => {
          const row = rows.find((item) => item.id === params[0]);
          if (row) {
            row.status = 'signed';
            row.token = params[5] || params[6] || row.token;
          }
          return { rows: [], rowCount: 1 };
        },
      },
      {
        match: (sql) => sql.includes("SET status = 'sent'"),
        result: (params) => {
          const row = rows.find((item) => item.id === params[0]);
          if (row) row.status = 'sent';
          return { rows: [], rowCount: 1 };
        },
      },
      {
        match: (sql) => sql.includes("SET status = 'approved_for_deposit'"),
        result: () => {
          check.status = 'approved_for_deposit';
          check.deposit_recommendation = 'ready_for_deposit';
          check.check_stage = 'ready_for_deposit';
          return { rows: [{ ...check }], rowCount: 1 };
        },
      },
      {
        match: (sql) => sql.includes("SET status = 'endorsements_in_progress'"),
        result: () => {
          if (check.status !== 'approved_for_deposit') check.status = 'endorsements_in_progress';
          return { rows: [], rowCount: 1 };
        },
      },
      {
        match: (sql) => sql.includes('INSERT INTO public.check_audit_log'),
        result: (params, sql) => {
          audits.push({ sql, params });
          return { rows: [], rowCount: 1 };
        },
      },
    ], captured);

    const send = await runAuthenticatedEndorsement({
      client: clientFor(),
      mapping: { application_user_id: USER_ID },
      body: { action: 'send_endorsement_request', endorsementId: ENDORSE_A, email: TEST_TO },
      spoof: { ignored: true },
      event: eventOf({}),
      fetchImpl: async (url, init) => {
        resendCalls.push({ url, body: JSON.parse(init.body) });
        return { ok: true, json: async () => ({ id: 're_msg_lifecycle' }) };
      },
    });
    assert.equal(send.ok, true);
    assert.equal(send.emailSent, true);
    assert.equal(send.delivery_status, 'delivered');
    assert.equal(send.emailProvider, 'resend');
    assert.match(send.endorsementUrl, /^https:\/\/checksops\.com\/endorse\?token=/);
    assert.equal(resendCalls.length, 1);
    assert.equal(resendCalls[0].url, 'https://api.resend.com/emails');
    assert.equal(resendCalls[0].body.from, PLATFORM_ENDORSEMENT_FROM);
    assert.doesNotMatch(resendCalls[0].body.from, /freedomclaims\.work/i);
    assert.match(resendCalls[0].body.html, /https:\/\/checksops\.com\/endorse\?token=/);
    assert.doesNotMatch(resendCalls[0].url, /supabase|lovable/i);

    const first = await runPublicEndorsement(eventOf({
      action: 'submit_endorsement',
      token: 'tok-a',
      eSignConsentAccepted: true,
      signatureData: 'data:image/png;base64,aaa',
    }), { client: clientFor(), compositeDeps });
    assert.equal(first.ok, true);
    assert.equal(first.allSigned, false);
    assert.equal(first.readyForDeposit, false);
    assert.equal(check.status, 'endorsements_in_progress');
    assert.equal(check.deposit_recommendation, null);
    assert.equal(audits.some((row) => row.sql.includes('all_endorsements_complete')), false);

    const final = await runPublicEndorsement(eventOf({
      action: 'submit_endorsement',
      token: 'tok-b',
      eSignConsentAccepted: true,
      signatureData: 'data:image/png;base64,bbb',
    }), { client: clientFor(), compositeDeps });
    assert.equal(final.ok, true);
    assert.equal(final.allSigned, true);
    assert.equal(final.officialRearReady, true);
    assert.equal(final.readyForDeposit, true);
    assert.equal(final.approvedForDeposit, true);
    assert.equal(final.depositAdvanceDenied, false);
    assert.equal(final.advance_check_on_endorsement_complete, 'applied');
    assert.equal(final.paymentDirectionTriggered, false);
    assert.equal(check.status, 'approved_for_deposit');
    assert.equal(check.deposit_recommendation, 'ready_for_deposit');
    assert.equal(check.check_stage, 'ready_for_deposit');
    assert.equal(audits.filter((row) => row.sql.includes('all_endorsements_complete')).length, 1);

    const duplicate = await runPublicEndorsement(eventOf({
      action: 'submit_endorsement',
      token: rows[1].token,
      eSignConsentAccepted: true,
      signatureData: 'data:image/png;base64,bbb',
    }), { client: clientFor() });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.message, 'Already endorsed');
    assert.equal(audits.filter((row) => row.sql.includes('all_endorsements_complete')).length, 1);

    const endorsingCount = check.status === 'endorsements_in_progress' ? 1 : 0;
    const readyCount = (
      check.status === 'approved_for_deposit'
      || check.deposit_recommendation === 'ready_for_deposit'
    ) ? 1 : 0;
    assert.equal(endorsingCount, 0);
    assert.equal(readyCount, 1);
    assert.equal(captured.some((row) => /moov_transfer|supabase\.co|fincapture|checkalt_deposits/i.test(row.sql)), false);
  });
});

test('auto-advance stays blocked when official endorsed rear cannot be generated', async () => {
  await withEnv({ AWS_ENDORSEMENT_AUTO_ADVANCE: 'true' }, async () => {
    const check = {
      id: CHECK_ID,
      tenant_id: TENANT_A,
      status: 'endorsements_in_progress',
      deposit_recommendation: null,
      check_stage: 'endorsing',
      deposited_at: null,
    };
    const captured = [];
    const blocked = await runPublicEndorsement(eventOf({
      action: 'submit_endorsement',
      token: 'tok-block',
      eSignConsentAccepted: true,
      signatureData: 'data:image/png;base64,aaa',
    }), {
      client: sqlClient([
        {
          match: (sql) => sql.includes('FROM public.check_endorsements WHERE token'),
          result: () => ({ rows: [{
            id: ENDORSE_A, check_id: CHECK_ID, tenant_id: TENANT_A,
            payee_name: 'A', status: 'sent', token: 'tok-block', contact_email: TEST_TO,
          }] }),
        },
        {
          match: (sql) => sql.includes("SET status = 'signed'"),
          result: () => ({ rows: [{ id: ENDORSE_A, status: 'signed' }], rowCount: 1 }),
        },
        {
          match: (sql) => sql.includes('SELECT status, payee_type'),
          result: () => ({ rows: [{ status: 'signed', payee_type: 'insured' }] }),
        },
        {
          match: (sql) => sql.includes('FROM public.check_intake_items'),
          result: () => ({ rows: [check] }),
        },
      ], captured),
      compositeDeps: {
        downloadClaimFile: async () => null,
        loadDeposits: async () => [],
      },
    });
    assert.equal(blocked.ok, true);
    assert.equal(blocked.allSigned, true);
    assert.equal(blocked.readyForDeposit, false);
    assert.equal(blocked.approvedForDeposit, false);
    assert.equal(blocked.depositAdvanceDenied, true);
    assert.equal(blocked.advance_check_on_endorsement_complete, 'blocked_official_rear_missing');
    assert.equal(captured.some((row) => row.sql.includes("SET status = 'approved_for_deposit'")), false);
    assert.equal(captured.some((row) => /moov_transfer|fincapture|checkalt_deposits/i.test(row.sql)), false);
  });
});

test('auto-advance does not move rejected or deposited checks', async () => {
  await withEnv({ AWS_ENDORSEMENT_AUTO_ADVANCE: 'true' }, async () => {
    const rejectedCheck = {
      id: CHECK_ID,
      tenant_id: TENANT_A,
      status: 'endorsements_in_progress',
      deposit_recommendation: null,
      deposited_at: null,
    };
    const rejected = await runPublicEndorsement(eventOf({
      action: 'submit_endorsement',
      token: 'tok-r',
      eSignConsentAccepted: true,
      signatureData: 'data:image/png;base64,aaa',
    }), {
      client: sqlClient([
        {
          match: (sql) => sql.includes('FROM public.check_endorsements WHERE token'),
          result: () => ({ rows: [{
            id: ENDORSE_A, check_id: CHECK_ID, tenant_id: TENANT_A,
            payee_name: 'A', status: 'sent', token: 'tok-r', contact_email: TEST_TO,
          }] }),
        },
        {
          match: (sql) => sql.includes("SET status = 'signed'"),
          result: () => ({ rows: [{ id: ENDORSE_A, status: 'signed' }], rowCount: 1 }),
        },
        {
          match: (sql) => sql.includes('SELECT status, payee_type'),
          result: () => ({ rows: [
            { status: 'signed', payee_type: 'insured' },
            { status: 'rejected', payee_type: 'insured' },
          ] }),
        },
        {
          match: (sql) => sql.includes('FROM public.check_intake_items'),
          result: () => ({ rows: [rejectedCheck] }),
        },
        {
          match: (sql) => sql.includes("SET status = 'needs_review'"),
          result: () => {
            rejectedCheck.status = 'needs_review';
            return { rows: [], rowCount: 1 };
          },
        },
      ]),
    });
    assert.equal(rejected.allSigned, false);
    assert.equal(rejected.readyForDeposit, false);
    assert.equal(rejectedCheck.status, 'needs_review');

    const depositedCheck = {
      id: CHECK_ID,
      tenant_id: TENANT_A,
      status: 'deposited',
      deposit_recommendation: 'ready_for_deposit',
      deposited_at: '2026-09-01T00:00:00Z',
    };
    const captured = [];
    const blocked = await runPublicEndorsement(eventOf({
      action: 'submit_endorsement',
      token: 'tok-d',
      eSignConsentAccepted: true,
      signatureData: 'data:image/png;base64,aaa',
    }), {
      client: sqlClient([
        {
          match: (sql) => sql.includes('FROM public.check_endorsements WHERE token'),
          result: () => ({ rows: [{
            id: ENDORSE_A, check_id: CHECK_ID, tenant_id: TENANT_A,
            payee_name: 'A', status: 'sent', token: 'tok-d', contact_email: TEST_TO,
          }] }),
        },
        {
          match: (sql) => sql.includes("SET status = 'signed'"),
          result: () => ({ rows: [{ id: ENDORSE_A, status: 'signed' }], rowCount: 1 }),
        },
        {
          match: (sql) => sql.includes('SELECT status, payee_type'),
          result: () => ({ rows: [{ status: 'signed', payee_type: 'insured' }] }),
        },
        {
          match: (sql) => sql.includes('FROM public.check_intake_items'),
          result: () => ({ rows: [depositedCheck] }),
        },
      ], captured),
    });
    assert.equal(blocked.allSigned, true);
    assert.equal(blocked.advance_check_on_endorsement_complete, 'skipped_ineligible');
    assert.equal(captured.some((row) => row.sql.includes("SET status = 'approved_for_deposit'")), false);
  });
});

test('waived and mortgage manual_required still satisfy completion math', () => {
  const done = evaluateEndorsementCompletion([
    { status: 'signed', payee_type: 'insured' },
    { status: 'waived', payee_type: 'contractor' },
    { status: 'manual_required', payee_type: 'mortgage_company' },
  ]);
  assert.equal(done.allSigned, true);
  const outstanding = evaluateEndorsementCompletion([
    { status: 'signed', payee_type: 'insured' },
    { status: 'sent', payee_type: 'insured' },
  ]);
  assert.equal(outstanding.allSigned, false);
});

test('manual Review backup documents endorsements_in_progress as an allowed source', () => {
  assert.equal(
    TRANSITIONS.mark_ready_for_deposit.fromStatus.includes('endorsements_in_progress'),
    true,
  );
  const decided = evaluateTransition('mark_ready_for_deposit', {
    id: CHECK_ID,
    status: 'endorsements_in_progress',
    claim_id: null,
  });
  assert.equal(decided.ok, true);
  assert.equal(decided.nextStatus, 'approved_for_deposit');
  assert.equal(decided.nextStage, 'ready_for_deposit');
  assert.equal(decided.providerExecution, false);
});
