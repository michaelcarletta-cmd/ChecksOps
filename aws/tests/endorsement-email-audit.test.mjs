import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  claimIdempotencyKey,
  deliverAuditedEmail,
  peekAuditedEmail,
} from '../functions/api/email.mjs';
import { runAuthenticatedEndorsement, runPublicEndorsement } from '../functions/api/check-endorsement.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '55555555-5555-4555-8555-555555555555';
const CHECK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENDORSE = '88888888-8888-4888-8888-888888888888';
const KEY = 'endorsement:88888888-8888-4888-8888-888888888888:none';

const sqlClient = (handlers) => ({
  query: async (sql, params = []) => {
    const compact = String(sql).replace(/\s+/g, ' ');
    for (const handler of handlers) {
      if (handler.match(compact, params)) return handler.result(params, compact);
    }
    return { rows: [], rowCount: 0 };
  },
});

const capturingMailer = (sent, messageId = 'sink-1') => async (payload) => {
  sent.push(payload);
  return {
    deliveredCount: 0,
    sunkCount: 1,
    mode: 'sink',
    results: [{ delivery: 'sink', status: 'sunk', messageId, policy: 'staging_ses_identity' }],
  };
};

const endorsementRow = {
  id: ENDORSE,
  check_id: CHECK,
  tenant_id: TENANT,
  payee_type: 'insured',
  payee_name: 'Jane',
  contact_email: 'jane@example.com',
  token: 'abc',
  request_sent_at: null,
};

test('reservation failure never invokes the mailer', async () => {
  const sent = [];
  const result = await deliverAuditedEmail(sqlClient([
    {
      match: (sql) => sql.includes('aws_email_send_log_peek'),
      result: () => ({ rows: [{ doc: { ok: true, row: null } }] }),
    },
    {
      match: (sql) => sql.includes('aws_email_send_log_reserve'),
      result: () => ({ rows: [{ doc: { ok: false, error: 'forbidden', statusCode: 403 } }] }),
    },
  ]), {
    templateName: 'endorsement-request',
    recipientEmail: 'jane@example.com',
    tenantId: TENANT,
    idempotencyKey: KEY,
    send: capturingMailer(sent),
    mailerArgs: { subject: 'x', html: '<p>x</p>', text: 'x' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 503);
  assert.equal(sent.length, 0);
});

test('same idempotency key replays without a second mailer call', async () => {
  const sent = [];
  const reserved = new Map();
  const handlers = [
    {
      match: (sql) => sql.includes('aws_email_send_log_peek'),
      result: (params) => ({
        rows: [{ doc: { ok: true, row: reserved.get(String(params[0] || '')) || null } }],
      }),
    },
    {
      match: (sql) => sql.includes('aws_email_send_log_reserve'),
      result: (params) => {
        const key = String(params[5] || '');
        const row = {
          id: params[0],
          status: 'pending',
          provider_message_id: null,
          idempotency_key: key,
          metadata: {},
        };
        reserved.set(key, row);
        return { rows: [{ doc: { ok: true, claimed: true, duplicate: false, id: params[0], row } }] };
      },
    },
    {
      match: (sql) => sql.includes('aws_email_send_log_finalize'),
      result: (params) => {
        const row = {
          id: params[0],
          status: 'sunk',
          provider_message_id: params[2],
          idempotency_key: KEY,
          metadata: { mode: 'sink', policy: 'staging_ses_identity' },
        };
        reserved.set(KEY, row);
        return { rows: [{ doc: { ok: true, row } }] };
      },
    },
  ];
  const client = sqlClient(handlers);
  const first = await deliverAuditedEmail(client, {
    templateName: 'endorsement-request',
    recipientEmail: 'jane@example.com',
    tenantId: TENANT,
    idempotencyKey: KEY,
    send: capturingMailer(sent, 'sink-abc'),
    mailerArgs: { subject: 'x', html: '<p>x</p>', text: 'x' },
  });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.providerMessageId, 'sink-abc');
  assert.equal(sent.length, 1);

  const second = await deliverAuditedEmail(client, {
    templateName: 'endorsement-request',
    recipientEmail: 'jane@example.com',
    tenantId: TENANT,
    idempotencyKey: KEY,
    send: capturingMailer(sent, 'sink-xyz'),
    mailerArgs: { subject: 'x', html: '<p>x</p>', text: 'x' },
  });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.replay.duplicate, true);
  assert.equal(second.replay.reason, 'idempotent_replay');
  assert.equal(second.providerMessageId, 'sink-abc');
  assert.equal(sent.length, 1);
});

test('pending reservation without MessageId does not send again', async () => {
  const sent = [];
  const result = await deliverAuditedEmail(sqlClient([
    {
      match: (sql) => sql.includes('aws_email_send_log_peek'),
      result: () => ({
        rows: [{
          doc: {
            ok: true,
            row: {
              id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              status: 'pending',
              provider_message_id: null,
              idempotency_key: KEY,
              metadata: {},
            },
          },
        }],
      }),
    },
  ]), {
    templateName: 'endorsement-request',
    recipientEmail: 'jane@example.com',
    tenantId: TENANT,
    idempotencyKey: KEY,
    send: capturingMailer(sent),
    mailerArgs: { subject: 'x', html: '<p>x</p>', text: 'x' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'delivery_in_progress');
  assert.equal(sent.length, 0);
});

test('authenticated endorsement send reserves, marks request_sent_at, and replays', async () => {
  const sent = [];
  const reserved = new Map();
  const handlers = [
    {
      match: (sql) => sql.includes('FROM public.check_endorsements WHERE id'),
      result: () => ({ rows: [endorsementRow] }),
    },
    {
      match: (sql) => sql.includes('FROM public.check_intake_items'),
      result: () => ({ rows: [{ id: CHECK, tenant_id: TENANT, check_number: '1001', carrier_name: 'Acme' }] }),
    },
    {
      match: (sql) => sql.includes('aws_can_write_tenant'),
      result: () => ({ rows: [{ ok: true }] }),
    },
    {
      match: (sql) => sql.includes('aws_email_send_log_peek'),
      result: (params) => ({
        rows: [{ doc: { ok: true, row: reserved.get(String(params[0] || '')) || null } }],
      }),
    },
    {
      match: (sql) => sql.includes('aws_email_send_log_reserve'),
      result: (params) => {
        const key = String(params[5] || '');
        const row = {
          id: params[0],
          status: 'pending',
          provider_message_id: null,
          idempotency_key: key,
          metadata: {},
        };
        reserved.set(key, row);
        return { rows: [{ doc: { ok: true, claimed: true, duplicate: false, id: params[0], row } }] };
      },
    },
    {
      match: (sql) => sql.includes('aws_email_send_log_finalize'),
      result: (params) => {
        const row = {
          id: params[0],
          status: 'sunk',
          provider_message_id: 'sink-1',
          idempotency_key: KEY,
          metadata: { mode: 'sink' },
        };
        for (const key of reserved.keys()) reserved.set(key, { ...reserved.get(key), ...row });
        return { rows: [{ doc: { ok: true, row } }] };
      },
    },
    {
      match: (sql) => sql.includes('aws_mark_endorsement_request_sent'),
      result: () => ({
        rows: [{ doc: { ok: true, status: 'sent', request_sent_at: '2026-09-12T17:00:00.000Z', token: 'abc' } }],
      }),
    },
  ];
  const first = await runAuthenticatedEndorsement({
    mapping: { application_user_id: USER },
    spoof: { ignored: true },
    event: { headers: {} },
    send: capturingMailer(sent),
    body: { action: 'send_endorsement_request', endorsementId: ENDORSE, idempotencyKey: KEY },
    client: sqlClient(handlers),
  });
  assert.equal(first.ok, true);
  assert.equal(first.emailSent, true);
  assert.equal(first.providerMessageId, 'sink-1');
  assert.equal(first.requestSentAt, '2026-09-12T17:00:00.000Z');
  assert.equal(sent.length, 1);

  const replay = await runAuthenticatedEndorsement({
    mapping: { application_user_id: USER },
    spoof: { ignored: true },
    event: { headers: {} },
    send: capturingMailer(sent),
    body: { action: 'send_endorsement_request', endorsementId: ENDORSE, idempotencyKey: KEY },
    client: sqlClient(handlers),
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.reason, 'idempotent_replay');
  assert.equal(replay.providerMessageId, 'sink-1');
  assert.equal(sent.length, 1);
});

test('cross-tenant endorsement send is denied before mailer', async () => {
  const sent = [];
  const denied = await runAuthenticatedEndorsement({
    mapping: { application_user_id: USER },
    spoof: { ignored: true, headerTenantId: OTHER_TENANT },
    event: { headers: {} },
    send: capturingMailer(sent),
    body: { action: 'send_endorsement_request', endorsementId: ENDORSE },
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.check_endorsements WHERE id'),
        result: () => ({ rows: [{ ...endorsementRow, tenant_id: TENANT }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.check_intake_items'),
        result: () => ({ rows: [{ id: CHECK, tenant_id: TENANT }] }),
      },
      {
        match: (sql) => sql.includes('aws_can_write_tenant'),
        result: () => ({ rows: [{ ok: false }] }),
      },
    ]),
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(sent.length, 0);
});

test('peek fail-closes instead of sending', async () => {
  const prior = await peekAuditedEmail(sqlClient([
    {
      match: (sql) => sql.includes('aws_email_send_log_peek'),
      result: () => { throw new Error('permission denied for table email_send_log'); },
    },
  ]), KEY);
  assert.equal(prior.ok, false);
  assert.equal(prior.statusCode, 503);
});

test('claim RPC forbidden is not treated as claimed', async () => {
  const claim = await claimIdempotencyKey(sqlClient([
    {
      match: (sql) => sql.includes('aws_email_send_log_reserve'),
      result: () => ({ rows: [{ doc: { ok: false, error: 'forbidden', statusCode: 403 } }] }),
    },
  ]), {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    template_name: 'endorsement-request',
    recipient_email: 'jane@example.com',
    tenant_id: TENANT,
    idempotency_key: KEY,
  });
  assert.equal(claim.ok, false);
  assert.equal(claim.error, 'forbidden');
});

test('used public token cannot be reused', async () => {
  const used = await runPublicEndorsement({
    headers: {},
    body: JSON.stringify({
      action: 'submit_endorsement',
      token: 'used',
      eSignConsentAccepted: true,
      signatureData: 'data:image/png;base64,aaa',
    }),
  }, {
    client: sqlClient([{
      match: (sql) => sql.includes('aws_public_submit_endorsement'),
      result: () => ({ rows: [{ doc: { ok: false, error: 'invalid_or_used_token', statusCode: 404 } }] }),
    }]),
  });
  assert.equal(used.statusCode, 404);
  assert.equal(used.code, 'invalid_or_used_token');
});
